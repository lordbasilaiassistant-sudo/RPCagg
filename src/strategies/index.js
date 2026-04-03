/**
 * Strategy registry — load all strategies, export by name.
 */

const fastest = require('./fastest');
const roundRobin = require('./round-robin');
const race = require('./race');

const strategies = {
  [fastest.name]: fastest,
  [roundRobin.name]: roundRobin,
  [race.name]: race,
};

module.exports = strategies;
