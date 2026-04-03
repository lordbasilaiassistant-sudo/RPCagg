"""
TreasureNet — Multi-task anomaly detection and value prediction network
for blockchain contract analysis.

Architecture:
  - Shared feature encoder with residual connections
  - 4 task-specific heads:
      1. Anomaly score (autoencoder reconstruction error)
      2. Value regression (ETH value prediction, log-scale)
      3. Extraction success classification (binary)
      4. Treasure classification (binary)
  - Focal loss for imbalanced binary tasks
  - Log-cosh loss for value regression (robust to outliers)
  - Combined anomaly score from reconstruction error + prediction disagreement

Input: 35-dim feature vector from vectorizer.js
Output: dict of per-task predictions + anomaly score

Designed for real-time inference on every new contract (~0.1ms per forward pass).
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
from typing import Dict, Optional, Tuple


# ---------------------------------------------------------------------------
# Loss functions
# ---------------------------------------------------------------------------

class FocalLoss(nn.Module):
    """
    Focal loss for heavily imbalanced binary classification.
    Down-weights easy negatives so the model focuses on hard positives.

    With gamma=2, alpha=0.75:
      - A well-classified negative (p=0.01) gets weight ~0.0001 (ignored)
      - A misclassified positive (p=0.3) gets weight ~0.37 (amplified)
    """

    def __init__(self, alpha: float = 0.75, gamma: float = 2.0):
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma

    def forward(self, logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        probs = torch.sigmoid(logits)
        # For positive targets, use alpha; for negatives, use (1 - alpha)
        alpha_t = self.alpha * targets + (1 - self.alpha) * (1 - targets)
        # p_t is the model's estimated probability of the correct class
        p_t = probs * targets + (1 - probs) * (1 - targets)
        # Focal modulation: (1 - p_t)^gamma
        focal_weight = (1 - p_t) ** self.gamma
        # BCE component
        bce = F.binary_cross_entropy_with_logits(logits, targets, reduction='none')
        loss = alpha_t * focal_weight * bce
        return loss.mean()


class AsymmetricLoss(nn.Module):
    """
    Asymmetric loss — even more aggressive than focal loss for extreme imbalance.
    Uses different gamma values for positives vs negatives, plus hard thresholding
    on easy negatives.

    This ensures we NEVER miss a treasure (low false negative rate) even if
    it means more false positives.
    """

    def __init__(self, gamma_pos: float = 0.0, gamma_neg: float = 4.0,
                 clip: float = 0.05):
        super().__init__()
        self.gamma_pos = gamma_pos    # No down-weighting of hard positives
        self.gamma_neg = gamma_neg    # Aggressively down-weight easy negatives
        self.clip = clip              # Probability floor for negatives

    def forward(self, logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        probs = torch.sigmoid(logits)
        # Positive loss: standard BCE, minimal modulation
        pos_loss = targets * torch.log(probs.clamp(min=1e-8))
        if self.gamma_pos > 0:
            pos_loss = pos_loss * ((1 - probs) ** self.gamma_pos)

        # Negative loss: clip + heavy modulation
        neg_probs = (1 - probs).clamp(min=1e-8)
        if self.clip > 0:
            # Shift probabilities so easy negatives (high neg_prob) are clipped
            neg_probs = (neg_probs + self.clip).clamp(max=1.0)
        neg_loss = (1 - targets) * torch.log(neg_probs)
        if self.gamma_neg > 0:
            neg_loss = neg_loss * (probs ** self.gamma_neg)

        loss = -(pos_loss + neg_loss)
        return loss.mean()


class LogCoshLoss(nn.Module):
    """
    Log-cosh regression loss — smooth approximation of Huber loss.
    Less sensitive to outliers than MSE, differentiable everywhere unlike Huber.
    Critical for ETH value prediction where a few whales skew the distribution.
    """

    def forward(self, pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        diff = pred - target
        return torch.mean(torch.log(torch.cosh(diff + 1e-12)))


# ---------------------------------------------------------------------------
# Model components
# ---------------------------------------------------------------------------

class ResidualBlock(nn.Module):
    """Pre-norm residual block with dropout."""

    def __init__(self, dim: int, dropout: float = 0.15):
        super().__init__()
        self.norm = nn.LayerNorm(dim)
        self.fc1 = nn.Linear(dim, dim)
        self.fc2 = nn.Linear(dim, dim)
        self.drop = nn.Dropout(dropout)
        self.act = nn.GELU()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        x = self.norm(x)
        x = self.act(self.fc1(x))
        x = self.drop(x)
        x = self.fc2(x)
        x = self.drop(x)
        return x + residual


class FeatureGroupEncoder(nn.Module):
    """
    Encodes a specific group of features into a fixed-size embedding.
    The vectorizer produces 4 distinct feature groups — encoding them
    separately before fusion lets each group learn its own representation
    before cross-group interactions.
    """

    def __init__(self, in_dim: int, out_dim: int, dropout: float = 0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, out_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(out_dim, out_dim),
            nn.LayerNorm(out_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# ---------------------------------------------------------------------------
# Main model
# ---------------------------------------------------------------------------

class TreasureNet(nn.Module):
    """
    Multi-task network for contract treasure detection.

    Architecture:
        Input (35-dim) --> Feature Group Encoders (4 groups) --> Concat (128-dim)
            --> Shared Encoder (3 residual blocks, 128-dim)
                --> Autoencoder Decoder --> reconstruction (35-dim) [anomaly]
                --> Value Head --> log(ETH + 1) prediction [regression]
                --> Extraction Head --> P(extraction success) [binary]
                --> Treasure Head --> P(treasure) [binary]

    The autoencoder branch serves double duty:
        1. Anomaly score = reconstruction error (unusual contracts reconstruct poorly)
        2. Regularization (forces shared encoder to preserve all information)

    Parameters: ~85K (fits in L1 cache, <0.1ms inference on CPU)
    """

    # Feature group slicing indices (matching vectorizer.js)
    STRUCTURAL = (0, 10)     # indices 0-9
    FINANCIAL = (10, 17)     # indices 10-16
    CAPABILITY = (17, 31)    # indices 17-30
    EXTRACTION = (31, 35)    # indices 31-34

    GROUP_EMBED_DIM = 32     # Each group encodes to 32-dim
    SHARED_DIM = 128         # 4 groups * 32 = 128
    NUM_RESIDUAL = 3

    def __init__(self, input_dim: int = 35, dropout: float = 0.15):
        super().__init__()
        self.input_dim = input_dim

        # --- Feature group encoders ---
        self.structural_enc = FeatureGroupEncoder(10, self.GROUP_EMBED_DIM, dropout)
        self.financial_enc = FeatureGroupEncoder(7, self.GROUP_EMBED_DIM, dropout)
        self.capability_enc = FeatureGroupEncoder(14, self.GROUP_EMBED_DIM, dropout)
        self.extraction_enc = FeatureGroupEncoder(4, self.GROUP_EMBED_DIM, dropout)

        # --- Shared encoder (residual blocks) ---
        self.shared = nn.Sequential(
            *[ResidualBlock(self.SHARED_DIM, dropout) for _ in range(self.NUM_RESIDUAL)]
        )

        # --- Task heads ---

        # Anomaly: decode back to input space (autoencoder)
        self.decoder = nn.Sequential(
            nn.Linear(self.SHARED_DIM, 64),
            nn.GELU(),
            nn.Linear(64, input_dim),
            nn.Sigmoid(),  # All features are [0, 1] from vectorizer
        )

        # Value regression: predict log(ETH_value + 1)
        self.value_head = nn.Sequential(
            nn.Linear(self.SHARED_DIM, 32),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(32, 1),
            nn.Softplus(),  # Output >= 0
        )

        # Extraction success: binary logit
        self.extraction_head = nn.Sequential(
            nn.Linear(self.SHARED_DIM, 32),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(32, 1),
        )

        # Treasure classification: binary logit
        self.treasure_head = nn.Sequential(
            nn.Linear(self.SHARED_DIM, 32),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(32, 1),
        )

        self._init_weights()

    def _init_weights(self):
        """Kaiming init for linear layers, zeros for biases in output heads."""
        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.kaiming_normal_(m.weight, nonlinearity='relu')
                if m.bias is not None:
                    nn.init.zeros_(m.bias)

        # Bias the treasure/extraction heads toward negative (rare positive class).
        # log(0.01 / 0.99) ~ -4.6 means initial P(positive) ~ 1%
        nn.init.constant_(self.treasure_head[-1].bias, -4.6)
        nn.init.constant_(self.extraction_head[-1].bias, -4.6)

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        """Encode raw features into shared representation."""
        s = self.structural_enc(x[:, self.STRUCTURAL[0]:self.STRUCTURAL[1]])
        f = self.financial_enc(x[:, self.FINANCIAL[0]:self.FINANCIAL[1]])
        c = self.capability_enc(x[:, self.CAPABILITY[0]:self.CAPABILITY[1]])
        e = self.extraction_enc(x[:, self.EXTRACTION[0]:self.EXTRACTION[1]])
        fused = torch.cat([s, f, c, e], dim=-1)  # [B, 128]
        return self.shared(fused)

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        z = self.encode(x)
        reconstruction = self.decoder(z)
        recon_error = F.mse_loss(reconstruction, x, reduction='none').mean(dim=-1)

        value_pred = self.value_head(z).squeeze(-1)
        extraction_logit = self.extraction_head(z).squeeze(-1)
        treasure_logit = self.treasure_head(z).squeeze(-1)

        return {
            'z': z,                                         # Shared embedding [B, 128]
            'reconstruction': reconstruction,               # Decoded features [B, 35]
            'recon_error': recon_error,                     # Per-sample MSE [B]
            'value_pred': value_pred,                       # log(ETH+1) estimate [B]
            'extraction_logit': extraction_logit,           # Raw logit [B]
            'extraction_prob': torch.sigmoid(extraction_logit),
            'treasure_logit': treasure_logit,               # Raw logit [B]
            'treasure_prob': torch.sigmoid(treasure_logit),
            'anomaly_score': self._compute_anomaly(recon_error, treasure_logit, extraction_logit),
        }

    def _compute_anomaly(self, recon_error: torch.Tensor,
                         treasure_logit: torch.Tensor,
                         extraction_logit: torch.Tensor) -> torch.Tensor:
        """
        Combined anomaly score.
        High anomaly = unusual structure AND model thinks it might have value.

        Score = recon_error * (1 + treasure_prob + extraction_prob)

        A boring empty contract may reconstruct poorly (high error) but has
        low treasure/extraction probability, so the multiplier stays near 1.
        A contract that reconstructs poorly AND triggers the value detectors
        gets amplified — that's what we want to flag.
        """
        t_prob = torch.sigmoid(treasure_logit)
        e_prob = torch.sigmoid(extraction_logit)
        return recon_error * (1.0 + t_prob + e_prob)


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class ContractDataset(torch.utils.data.Dataset):
    """
    Loads JSONL vectors from the vectorizer.

    Each line: {"address":"0x...", "features":[...35 floats...], "labels":{...}}
    """

    def __init__(self, jsonl_path: str):
        import json
        self.samples = []
        self.addresses = []

        with open(jsonl_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                features = torch.tensor(obj['features'], dtype=torch.float32)
                labels = obj.get('labels', {})
                self.samples.append({
                    'features': features,
                    'has_value': float(labels.get('hasValue', False)),
                    'has_extraction': float(labels.get('hasCallableExtraction', False)),
                    'treasure': float(labels.get('treasure', False)),
                    'eth_value': float(labels.get('ethValue', 0.0)),
                })
                self.addresses.append(obj.get('address', ''))

        print(f"Loaded {len(self.samples)} samples from {jsonl_path}")
        self._print_stats()

    def _print_stats(self):
        n = len(self.samples)
        if n == 0:
            return
        n_value = sum(1 for s in self.samples if s['has_value'] > 0.5)
        n_extract = sum(1 for s in self.samples if s['has_extraction'] > 0.5)
        n_treasure = sum(1 for s in self.samples if s['treasure'] > 0.5)
        print(f"  has_value:     {n_value}/{n} ({100*n_value/n:.2f}%)")
        print(f"  has_extraction:{n_extract}/{n} ({100*n_extract/n:.2f}%)")
        print(f"  treasure:      {n_treasure}/{n} ({100*n_treasure/n:.2f}%)")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        return self.samples[idx]


# ---------------------------------------------------------------------------
# Data augmentation
# ---------------------------------------------------------------------------

class FeatureAugmentor:
    """
    Augmentation strategies for contract feature vectors.

    Strategy 1 — Gaussian noise: small perturbation to continuous features
    Strategy 2 — Feature dropout: zero out random features (simulates missing data)
    Strategy 3 — Positive oversampling via SMOTE-like interpolation between
                 existing positive samples

    All augmentations respect the [0, 1] bounds of the vectorizer output.
    Binary features (indices 1, 2, 4, 5, 11, 16, 34) are never augmented.
    """

    BINARY_INDICES = [1, 2, 4, 5, 11, 16, 34]
    CONTINUOUS_INDICES = [i for i in range(35) if i not in [1, 2, 4, 5, 11, 16, 34]]

    @staticmethod
    def add_noise(features: torch.Tensor, std: float = 0.02) -> torch.Tensor:
        """Add Gaussian noise to continuous features only."""
        noisy = features.clone()
        noise = torch.randn_like(features) * std
        mask = torch.ones(35, dtype=torch.bool)
        for idx in FeatureAugmentor.BINARY_INDICES:
            mask[idx] = False
        noisy[:, mask] = (features[:, mask] + noise[:, mask]).clamp(0, 1)
        return noisy

    @staticmethod
    def feature_dropout(features: torch.Tensor, p: float = 0.1) -> torch.Tensor:
        """Randomly zero out continuous features."""
        dropped = features.clone()
        mask = torch.ones(35, dtype=torch.bool)
        for idx in FeatureAugmentor.BINARY_INDICES:
            mask[idx] = False
        drop_mask = torch.rand(features.shape[0], 35) < p
        drop_mask[:, ~mask] = False
        dropped[drop_mask] = 0.0
        return dropped

    @staticmethod
    def smote_interpolate(features: torch.Tensor, k: int = 5) -> torch.Tensor:
        """
        SMOTE-like interpolation: for each sample, pick a random neighbor
        from k nearest neighbors and interpolate.
        """
        n = features.shape[0]
        if n < k + 1:
            k = max(1, n - 1)

        # Compute pairwise distances
        dists = torch.cdist(features, features)
        # Get k nearest neighbors (excluding self)
        _, knn_indices = dists.topk(k + 1, largest=False)
        knn_indices = knn_indices[:, 1:]  # Remove self

        # For each sample, pick a random neighbor and interpolate
        rand_k = torch.randint(0, k, (n,))
        neighbor_idx = knn_indices[torch.arange(n), rand_k]
        lam = torch.rand(n, 1)
        synthetic = features * lam + features[neighbor_idx] * (1 - lam)

        # Restore binary features from the original (don't interpolate them)
        for idx in FeatureAugmentor.BINARY_INDICES:
            synthetic[:, idx] = features[:, idx]

        return synthetic


# ---------------------------------------------------------------------------
# Balanced sampler
# ---------------------------------------------------------------------------

class ImbalancedSampler(torch.utils.data.Sampler):
    """
    Oversamples minority classes to achieve near-balanced batches.

    Strategy: weight each sample inversely proportional to its class frequency.
    Treasure positives (rarest) get the highest weight.
    Draws with replacement so rare samples appear multiple times per epoch.
    """

    def __init__(self, dataset: ContractDataset, oversample_factor: float = 10.0):
        self.n = len(dataset)
        weights = torch.ones(self.n)

        n_treasure = sum(1 for s in dataset.samples if s['treasure'] > 0.5)
        n_extract = sum(1 for s in dataset.samples if s['has_extraction'] > 0.5)
        n_value = sum(1 for s in dataset.samples if s['has_value'] > 0.5)

        for i, s in enumerate(dataset.samples):
            w = 1.0
            if s['treasure'] > 0.5 and n_treasure > 0:
                w = max(w, oversample_factor * (self.n / n_treasure))
            elif s['has_extraction'] > 0.5 and n_extract > 0:
                w = max(w, oversample_factor * (self.n / n_extract) * 0.5)
            elif s['has_value'] > 0.5 and n_value > 0:
                w = max(w, oversample_factor * (self.n / n_value) * 0.25)
            weights[i] = w

        self.weights = weights

    def __iter__(self):
        return iter(torch.multinomial(self.weights, self.n, replacement=True).tolist())

    def __len__(self):
        return self.n


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

class TreasureNetTrainer:
    """
    Training loop with:
    - Multi-task loss (weighted sum of 4 losses)
    - Cosine annealing LR schedule with warm restarts
    - Gradient clipping
    - Early stopping on validation recall (not loss — we optimize for finding treasures)
    - Automatic mixed precision (if CUDA available)
    - Augmentation pipeline
    """

    def __init__(self, model: TreasureNet, lr: float = 3e-4, weight_decay: float = 1e-4,
                 device: str = 'auto'):
        if device == 'auto':
            self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        else:
            self.device = torch.device(device)

        self.model = model.to(self.device)

        # Loss functions
        self.recon_loss = nn.MSELoss()
        self.value_loss = LogCoshLoss()
        self.extraction_loss = AsymmetricLoss(gamma_pos=0.0, gamma_neg=4.0, clip=0.05)
        self.treasure_loss = AsymmetricLoss(gamma_pos=0.0, gamma_neg=6.0, clip=0.02)

        # Task loss weights — treasure gets 5x because it's the rarest and most important
        self.loss_weights = {
            'recon': 1.0,
            'value': 2.0,
            'extraction': 3.0,
            'treasure': 5.0,
        }

        self.optimizer = torch.optim.AdamW(
            model.parameters(), lr=lr, weight_decay=weight_decay, betas=(0.9, 0.999)
        )

        self.augmentor = FeatureAugmentor()
        self.scaler = torch.amp.GradScaler('cuda', enabled=(self.device.type == 'cuda'))

    def train(self, train_dataset: ContractDataset,
              val_dataset: Optional[ContractDataset] = None,
              epochs: int = 200, batch_size: int = 256,
              patience: int = 30, min_epochs: int = 50):
        """
        Full training loop.

        Returns the best model state dict (by validation treasure recall).
        """
        sampler = ImbalancedSampler(train_dataset)
        train_loader = torch.utils.data.DataLoader(
            train_dataset, batch_size=batch_size, sampler=sampler,
            num_workers=0, pin_memory=(self.device.type == 'cuda'),
            collate_fn=self._collate,
        )

        val_loader = None
        if val_dataset is not None:
            val_loader = torch.utils.data.DataLoader(
                val_dataset, batch_size=batch_size * 2, shuffle=False,
                num_workers=0, collate_fn=self._collate,
            )

        scheduler = torch.optim.lr_scheduler.CosineAnnealingWarmRestarts(
            self.optimizer, T_0=20, T_mult=2, eta_min=1e-6
        )

        best_recall = 0.0
        best_state = None
        stale_epochs = 0

        for epoch in range(1, epochs + 1):
            # --- Train ---
            train_metrics = self._train_epoch(train_loader, epoch)

            # --- Validate ---
            val_metrics = {}
            if val_loader is not None:
                val_metrics = self._validate(val_loader)

            scheduler.step()

            # --- Logging ---
            lr = self.optimizer.param_groups[0]['lr']
            msg = (f"Epoch {epoch:03d} | "
                   f"loss={train_metrics['total_loss']:.4f} "
                   f"recon={train_metrics['recon_loss']:.4f} "
                   f"value={train_metrics['value_loss']:.4f} "
                   f"extract={train_metrics['extract_loss']:.4f} "
                   f"treasure={train_metrics['treasure_loss']:.4f} | "
                   f"lr={lr:.2e}")

            if val_metrics:
                msg += (f" | val_loss={val_metrics.get('total_loss', 0):.4f} "
                        f"t_recall={val_metrics.get('treasure_recall', 0):.3f} "
                        f"t_prec={val_metrics.get('treasure_precision', 0):.3f} "
                        f"e_recall={val_metrics.get('extraction_recall', 0):.3f}")
            print(msg)

            # --- Early stopping on treasure recall ---
            current_recall = val_metrics.get('treasure_recall', train_metrics.get('treasure_recall', 0))
            # We also factor in extraction recall — both matter
            combined_recall = current_recall + 0.5 * val_metrics.get('extraction_recall',
                                                                     train_metrics.get('extraction_recall', 0))
            if combined_recall > best_recall and epoch >= min_epochs // 2:
                best_recall = combined_recall
                best_state = {k: v.cpu().clone() for k, v in self.model.state_dict().items()}
                stale_epochs = 0
                print(f"  >> New best combined recall: {combined_recall:.4f}")
            else:
                stale_epochs += 1

            if stale_epochs >= patience and epoch >= min_epochs:
                print(f"Early stopping at epoch {epoch} (patience={patience})")
                break

        # Restore best model
        if best_state is not None:
            self.model.load_state_dict(best_state)
            print(f"Restored best model (combined_recall={best_recall:.4f})")

        return best_state

    def _train_epoch(self, loader, epoch: int) -> Dict[str, float]:
        self.model.train()
        accum = {k: 0.0 for k in ['total_loss', 'recon_loss', 'value_loss',
                                    'extract_loss', 'treasure_loss']}
        n_batches = 0
        all_treasure_preds = []
        all_treasure_labels = []
        all_extract_preds = []
        all_extract_labels = []

        for batch in loader:
            features = batch['features'].to(self.device)
            has_extraction = batch['has_extraction'].to(self.device)
            treasure = batch['treasure'].to(self.device)
            eth_value = batch['eth_value'].to(self.device)

            # Augmentation (stochastic per batch)
            if torch.rand(1).item() < 0.5:
                features = self.augmentor.add_noise(features, std=0.015)
            if torch.rand(1).item() < 0.3:
                features = self.augmentor.feature_dropout(features, p=0.08)

            with torch.amp.autocast(self.device.type, enabled=(self.device.type == 'cuda')):
                out = self.model(features)

                # Per-task losses
                l_recon = self.recon_loss(out['reconstruction'], features)
                l_value = self.value_loss(
                    out['value_pred'],
                    torch.log1p(eth_value)  # Target: log(ETH + 1)
                )
                l_extract = self.extraction_loss(out['extraction_logit'], has_extraction)
                l_treasure = self.treasure_loss(out['treasure_logit'], treasure)

                total = (self.loss_weights['recon'] * l_recon +
                         self.loss_weights['value'] * l_value +
                         self.loss_weights['extraction'] * l_extract +
                         self.loss_weights['treasure'] * l_treasure)

            self.optimizer.zero_grad(set_to_none=True)
            self.scaler.scale(total).backward()
            self.scaler.unscale_(self.optimizer)
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), max_norm=1.0)
            self.scaler.step(self.optimizer)
            self.scaler.update()

            accum['total_loss'] += total.item()
            accum['recon_loss'] += l_recon.item()
            accum['value_loss'] += l_value.item()
            accum['extract_loss'] += l_extract.item()
            accum['treasure_loss'] += l_treasure.item()
            n_batches += 1

            # Track predictions for recall computation
            all_treasure_preds.append((out['treasure_prob'] > 0.3).cpu())
            all_treasure_labels.append(treasure.cpu())
            all_extract_preds.append((out['extraction_prob'] > 0.3).cpu())
            all_extract_labels.append(has_extraction.cpu())

        metrics = {k: v / max(n_batches, 1) for k, v in accum.items()}

        # Compute recall
        all_tp = torch.cat(all_treasure_preds)
        all_tl = torch.cat(all_treasure_labels)
        all_ep = torch.cat(all_extract_preds)
        all_el = torch.cat(all_extract_labels)

        tp_treasure = ((all_tp == 1) & (all_tl == 1)).sum().float()
        fn_treasure = ((all_tp == 0) & (all_tl == 1)).sum().float()
        metrics['treasure_recall'] = (tp_treasure / (tp_treasure + fn_treasure + 1e-8)).item()

        tp_extract = ((all_ep == 1) & (all_el == 1)).sum().float()
        fn_extract = ((all_ep == 0) & (all_el == 1)).sum().float()
        metrics['extraction_recall'] = (tp_extract / (tp_extract + fn_extract + 1e-8)).item()

        return metrics

    @torch.no_grad()
    def _validate(self, loader) -> Dict[str, float]:
        self.model.eval()
        accum = {k: 0.0 for k in ['total_loss', 'recon_loss', 'value_loss',
                                    'extract_loss', 'treasure_loss']}
        n_batches = 0
        all_treasure_preds = []
        all_treasure_labels = []
        all_extract_preds = []
        all_extract_labels = []

        for batch in loader:
            features = batch['features'].to(self.device)
            has_extraction = batch['has_extraction'].to(self.device)
            treasure = batch['treasure'].to(self.device)
            eth_value = batch['eth_value'].to(self.device)

            out = self.model(features)

            l_recon = self.recon_loss(out['reconstruction'], features)
            l_value = self.value_loss(out['value_pred'], torch.log1p(eth_value))
            l_extract = self.extraction_loss(out['extraction_logit'], has_extraction)
            l_treasure = self.treasure_loss(out['treasure_logit'], treasure)

            total = (self.loss_weights['recon'] * l_recon +
                     self.loss_weights['value'] * l_value +
                     self.loss_weights['extraction'] * l_extract +
                     self.loss_weights['treasure'] * l_treasure)

            accum['total_loss'] += total.item()
            accum['recon_loss'] += l_recon.item()
            accum['value_loss'] += l_value.item()
            accum['extract_loss'] += l_extract.item()
            accum['treasure_loss'] += l_treasure.item()
            n_batches += 1

            # Low threshold (0.3 instead of 0.5) to favor recall
            all_treasure_preds.append((out['treasure_prob'] > 0.3).cpu())
            all_treasure_labels.append(treasure.cpu())
            all_extract_preds.append((out['extraction_prob'] > 0.3).cpu())
            all_extract_labels.append(has_extraction.cpu())

        metrics = {k: v / max(n_batches, 1) for k, v in accum.items()}

        all_tp = torch.cat(all_treasure_preds)
        all_tl = torch.cat(all_treasure_labels)
        all_ep = torch.cat(all_extract_preds)
        all_el = torch.cat(all_extract_labels)

        # Treasure metrics
        tp = ((all_tp == 1) & (all_tl == 1)).sum().float()
        fp = ((all_tp == 1) & (all_tl == 0)).sum().float()
        fn = ((all_tp == 0) & (all_tl == 1)).sum().float()
        metrics['treasure_recall'] = (tp / (tp + fn + 1e-8)).item()
        metrics['treasure_precision'] = (tp / (tp + fp + 1e-8)).item()

        # Extraction metrics
        tp_e = ((all_ep == 1) & (all_el == 1)).sum().float()
        fp_e = ((all_ep == 1) & (all_el == 0)).sum().float()
        fn_e = ((all_ep == 0) & (all_el == 1)).sum().float()
        metrics['extraction_recall'] = (tp_e / (tp_e + fn_e + 1e-8)).item()
        metrics['extraction_precision'] = (tp_e / (tp_e + fp_e + 1e-8)).item()

        return metrics

    @staticmethod
    def _collate(samples):
        return {
            'features': torch.stack([s['features'] for s in samples]),
            'has_value': torch.tensor([s['has_value'] for s in samples], dtype=torch.float32),
            'has_extraction': torch.tensor([s['has_extraction'] for s in samples], dtype=torch.float32),
            'treasure': torch.tensor([s['treasure'] for s in samples], dtype=torch.float32),
            'eth_value': torch.tensor([s['eth_value'] for s in samples], dtype=torch.float32),
        }


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

class TreasureDetector:
    """
    Production inference wrapper.

    Usage:
        detector = TreasureDetector.load('treasurenet.pt')
        result = detector.predict(feature_vector)  # 35-element list/array
        results = detector.predict_batch(feature_matrix)  # Nx35

    Decision thresholds are intentionally low to minimize false negatives.
    The cost of missing a treasure far exceeds the cost of investigating a
    false positive.
    """

    # Thresholds tuned for high recall
    TREASURE_THRESHOLD = 0.20     # Flag if >= 20% chance of treasure
    EXTRACTION_THRESHOLD = 0.25   # Flag if >= 25% chance of extraction
    ANOMALY_PERCENTILE = 95       # Flag top 5% anomaly scores

    def __init__(self, model: TreasureNet, device: str = 'cpu'):
        self.model = model
        self.device = torch.device(device)
        self.model.to(self.device)
        self.model.eval()

        # Running stats for anomaly percentile calibration
        self._anomaly_scores: list = []
        self._anomaly_threshold: float = float('inf')

    @classmethod
    def load(cls, path: str, device: str = 'cpu') -> 'TreasureDetector':
        """Load a trained model from disk."""
        checkpoint = torch.load(path, map_location=device, weights_only=True)
        model = TreasureNet()
        if 'model_state_dict' in checkpoint:
            model.load_state_dict(checkpoint['model_state_dict'])
        else:
            model.load_state_dict(checkpoint)
        return cls(model, device)

    @torch.no_grad()
    def predict(self, features) -> Dict:
        """
        Predict on a single 35-dim feature vector.

        Returns dict with all predictions + boolean flags for each alert type.
        """
        if isinstance(features, (list, np.ndarray)):
            features = torch.tensor(features, dtype=torch.float32)
        if features.dim() == 1:
            features = features.unsqueeze(0)

        features = features.to(self.device)
        out = self.model(features)

        anomaly = out['anomaly_score'].item()
        treasure_p = out['treasure_prob'].item()
        extract_p = out['extraction_prob'].item()
        value_pred = out['value_pred'].item()

        # Update running anomaly stats
        self._anomaly_scores.append(anomaly)
        if len(self._anomaly_scores) >= 100:
            self._anomaly_threshold = float(np.percentile(
                self._anomaly_scores[-10000:],  # Rolling window
                self.ANOMALY_PERCENTILE
            ))

        # Compute flags
        is_treasure = treasure_p >= self.TREASURE_THRESHOLD
        is_extractable = extract_p >= self.EXTRACTION_THRESHOLD
        is_anomaly = anomaly >= self._anomaly_threshold
        eth_estimate = np.expm1(value_pred)  # Reverse log1p

        # Priority scoring: weighted combination for triage
        priority = (
            3.0 * treasure_p +
            2.0 * extract_p +
            1.0 * min(anomaly / (self._anomaly_threshold + 1e-8), 2.0) +
            0.5 * min(eth_estimate, 10.0) / 10.0
        )

        return {
            'treasure_prob': round(treasure_p, 4),
            'extraction_prob': round(extract_p, 4),
            'eth_estimate': round(eth_estimate, 6),
            'anomaly_score': round(anomaly, 6),
            'anomaly_threshold': round(self._anomaly_threshold, 6),
            'is_treasure': is_treasure,
            'is_extractable': is_extractable,
            'is_anomaly': is_anomaly,
            'priority': round(priority, 4),
            'alert': is_treasure or is_extractable or is_anomaly,
        }

    @torch.no_grad()
    def predict_batch(self, features) -> list:
        """Predict on a batch of feature vectors. Returns list of result dicts."""
        if isinstance(features, (list, np.ndarray)):
            features = torch.tensor(features, dtype=torch.float32)
        features = features.to(self.device)
        out = self.model(features)

        results = []
        for i in range(features.shape[0]):
            anomaly = out['anomaly_score'][i].item()
            treasure_p = out['treasure_prob'][i].item()
            extract_p = out['extraction_prob'][i].item()
            value_pred = out['value_pred'][i].item()

            self._anomaly_scores.append(anomaly)
            eth_estimate = np.expm1(value_pred)

            results.append({
                'treasure_prob': round(treasure_p, 4),
                'extraction_prob': round(extract_p, 4),
                'eth_estimate': round(eth_estimate, 6),
                'anomaly_score': round(anomaly, 6),
                'is_treasure': treasure_p >= self.TREASURE_THRESHOLD,
                'is_extractable': extract_p >= self.EXTRACTION_THRESHOLD,
                'alert': (treasure_p >= self.TREASURE_THRESHOLD or
                          extract_p >= self.EXTRACTION_THRESHOLD),
                'priority': round(
                    3.0 * treasure_p + 2.0 * extract_p +
                    0.5 * min(eth_estimate, 10.0) / 10.0, 4),
            })

        # Update anomaly threshold after batch
        if len(self._anomaly_scores) >= 100:
            self._anomaly_threshold = float(np.percentile(
                self._anomaly_scores[-10000:],
                self.ANOMALY_PERCENTILE
            ))

        return results

    def calibrate(self, dataset: ContractDataset):
        """
        Run all data through the model to calibrate anomaly thresholds.
        Call this once after loading a trained model before production inference.
        """
        loader = torch.utils.data.DataLoader(
            dataset, batch_size=512, shuffle=False,
            collate_fn=TreasureNetTrainer._collate,
        )
        all_scores = []
        for batch in loader:
            features = batch['features'].to(self.device)
            out = self.model(features)
            all_scores.extend(out['anomaly_score'].cpu().tolist())

        self._anomaly_scores = all_scores
        self._anomaly_threshold = float(np.percentile(all_scores, self.ANOMALY_PERCENTILE))
        print(f"Calibrated anomaly threshold: {self._anomaly_threshold:.6f} "
              f"(p{self.ANOMALY_PERCENTILE} over {len(all_scores)} samples)")


# ---------------------------------------------------------------------------
# Save / export utilities
# ---------------------------------------------------------------------------

def save_checkpoint(model: TreasureNet, optimizer, epoch: int, metrics: dict,
                    path: str):
    """Save training checkpoint."""
    torch.save({
        'epoch': epoch,
        'model_state_dict': model.state_dict(),
        'optimizer_state_dict': optimizer.state_dict(),
        'metrics': metrics,
    }, path)


class _TraceableForward(nn.Module):
    """Wrapper that returns a tuple instead of dict, for JIT tracing."""

    def __init__(self, model: TreasureNet):
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor,
                                                  torch.Tensor, torch.Tensor,
                                                  torch.Tensor]:
        out = self.model(x)
        # Returns: (anomaly_score, treasure_prob, extraction_prob, value_pred, recon_error)
        return (out['anomaly_score'], out['treasure_prob'],
                out['extraction_prob'], out['value_pred'], out['recon_error'])


def export_for_inference(model: TreasureNet, path: str):
    """Export model for production (weights only, smaller file)."""
    torch.save(model.state_dict(), path)
    # Also export a traced version for potential C++ / ONNX inference
    model.eval()
    wrapper = _TraceableForward(model)
    wrapper.eval()
    dummy = torch.randn(1, 35)
    traced = torch.jit.trace(wrapper, dummy)
    traced_path = path.replace('.pt', '_traced.pt')
    traced.save(traced_path)
    print(f"Exported to {path} and {traced_path}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    import argparse
    import os

    parser = argparse.ArgumentParser(description='TreasureNet — train or run inference')
    sub = parser.add_subparsers(dest='command')

    # Train
    train_p = sub.add_parser('train', help='Train model on JSONL data')
    train_p.add_argument('--data', required=True, help='Path to vectors.jsonl')
    train_p.add_argument('--val-split', type=float, default=0.15,
                         help='Validation split ratio')
    train_p.add_argument('--epochs', type=int, default=200)
    train_p.add_argument('--batch-size', type=int, default=256)
    train_p.add_argument('--lr', type=float, default=3e-4)
    train_p.add_argument('--patience', type=int, default=30)
    train_p.add_argument('--output', default='treasurenet.pt',
                         help='Output model path')
    train_p.add_argument('--device', default='auto')

    # Predict
    pred_p = sub.add_parser('predict', help='Run inference on JSONL data')
    pred_p.add_argument('--model', required=True, help='Path to trained model')
    pred_p.add_argument('--data', required=True, help='Path to vectors.jsonl')
    pred_p.add_argument('--threshold', type=float, default=0.20,
                         help='Treasure probability threshold')
    pred_p.add_argument('--output', default=None, help='Output alerts JSONL')

    args = parser.parse_args()

    if args.command == 'train':
        # Load and split data
        full_dataset = ContractDataset(args.data)
        n = len(full_dataset)
        n_val = int(n * args.val_split)
        n_train = n - n_val

        train_ds, val_ds = torch.utils.data.random_split(
            full_dataset, [n_train, n_val],
            generator=torch.Generator().manual_seed(42)
        )

        # Wrap splits back into ContractDataset-compatible objects
        train_wrapped = _SubsetWrapper(full_dataset, train_ds.indices)
        val_wrapped = _SubsetWrapper(full_dataset, val_ds.indices)

        print(f"\nTrain: {len(train_wrapped)} | Val: {len(val_wrapped)}")
        print(f"Model params: {sum(p.numel() for p in TreasureNet().parameters()):,}")
        print()

        model = TreasureNet()
        trainer = TreasureNetTrainer(model, lr=args.lr, device=args.device)
        best_state = trainer.train(
            train_wrapped, val_wrapped,
            epochs=args.epochs, batch_size=args.batch_size,
            patience=args.patience,
        )

        # Save
        save_checkpoint(model, trainer.optimizer, args.epochs, {}, args.output)
        export_for_inference(model, args.output.replace('.pt', '_inference.pt'))
        print(f"\nModel saved to {args.output}")

        # Calibrate and report
        detector = TreasureDetector(model, device=str(trainer.device))
        detector.calibrate(full_dataset)

    elif args.command == 'predict':
        import json

        detector = TreasureDetector.load(args.model)
        dataset = ContractDataset(args.data)

        # Calibrate anomaly thresholds
        detector.calibrate(dataset)

        if args.threshold is not None:
            detector.TREASURE_THRESHOLD = args.threshold

        alerts = []
        for i in range(len(dataset)):
            sample = dataset[i]
            result = detector.predict(sample['features'])
            if result['alert']:
                result['address'] = dataset.addresses[i]
                alerts.append(result)

        print(f"\n{'='*60}")
        print(f"Scanned {len(dataset)} contracts, found {len(alerts)} alerts")
        print(f"{'='*60}")

        # Sort by priority
        alerts.sort(key=lambda x: x['priority'], reverse=True)

        for a in alerts[:20]:
            print(f"  {a['address']} | "
                  f"treasure={a['treasure_prob']:.3f} "
                  f"extract={a['extraction_prob']:.3f} "
                  f"eth~={a['eth_estimate']:.4f} "
                  f"priority={a['priority']:.2f}"
                  f"{'  *** TREASURE ***' if a['is_treasure'] else ''}")

        if args.output:
            with open(args.output, 'w') as f:
                for a in alerts:
                    f.write(json.dumps(a) + '\n')
            print(f"\nWrote {len(alerts)} alerts to {args.output}")

    else:
        parser.print_help()


class _SubsetWrapper:
    """Wraps a dataset subset to preserve the .samples attribute for the sampler."""

    def __init__(self, full_dataset: ContractDataset, indices: list):
        self.indices = indices
        self.samples = [full_dataset.samples[i] for i in indices]
        self.addresses = [full_dataset.addresses[i] for i in indices]

    def __len__(self):
        return len(self.indices)

    def __getitem__(self, idx):
        return self.samples[idx]


if __name__ == '__main__':
    main()
