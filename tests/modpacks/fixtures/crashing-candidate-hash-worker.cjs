const { parentPort } = require('node:worker_threads');

parentPort.once('message', () => process.exit(73));
