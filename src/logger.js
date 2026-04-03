/**
 * Structured logger — keeps it simple, no deps.
 * Levels: debug, info, warn, error
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function ts() {
  return new Date().toISOString();
}

function fmt(level, tag, msg, data) {
  const base = `[${ts()}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (data !== undefined) {
    return `${base} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  }
  return base;
}

function makeLogger(tag) {
  return {
    debug: (msg, data) => { if (currentLevel <= 0) console.log(fmt('debug', tag, msg, data)); },
    info:  (msg, data) => { if (currentLevel <= 1) console.log(fmt('info', tag, msg, data)); },
    warn:  (msg, data) => { if (currentLevel <= 2) console.warn(fmt('warn', tag, msg, data)); },
    error: (msg, data) => { if (currentLevel <= 3) console.error(fmt('error', tag, msg, data)); },
  };
}

module.exports = { makeLogger, setLevel: (l) => { currentLevel = LOG_LEVELS[l] || 1; } };
