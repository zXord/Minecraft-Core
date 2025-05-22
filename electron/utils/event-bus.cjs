// Simple event emitter to decouple services
const EventEmitter = require('events');

// Create and export a singleton event emitter
const eventBus = new EventEmitter();

module.exports = eventBus;
