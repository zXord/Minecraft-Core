// Simple event emitter to decouple services
const EventEmitter = require('events');

// Create and export a singleton event emitter with logging
class LoggedEventBus extends EventEmitter {
  constructor() {
    super();
    this.logger = null;
    this.eventStats = new Map(); // Track event statistics
    
    // Initialize logger lazily to avoid circular dependencies
    this.initializeLogger();
    
    this.logIfAvailable('info', 'Event bus initialized', {
      category: 'core',
      data: {
        service: 'EventBus',
        maxListeners: this.getMaxListeners()
      }
    });

    // Set up error handling for the event emitter
    this.on('error', (error) => {
      this.logIfAvailable('error', `Event bus error: ${error.message}`, {
        category: 'core',
        data: {
          service: 'EventBus',
          errorType: error.constructor.name,
          stack: error.stack
        }
      });
    });
  }

  initializeLogger() {
    try {
      const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
      this.logger = getLoggerHandlers();
    } catch {
      // Logger not available yet, will retry on first use
      this.logger = null;
    }
  }

  logIfAvailable(level, message, data) {
    if (!this.logger) {
      this.initializeLogger();
    }
    
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level](message, data);
    }
  }

  emit(eventName, ...args) {
    const startTime = Date.now();
    const listenerCount = this.listenerCount(eventName);
    
    this.logIfAvailable('debug', 'Event published', {
      category: 'core',
      data: {
        service: 'EventBus',
        eventName,
        listenerCount,
        argsCount: args.length,
        hasData: args.length > 0
      }
    });

    try {
      const result = super.emit(eventName, ...args);
      const duration = Date.now() - startTime;
      
      // Update event statistics
      const stats = this.eventStats.get(eventName) || { count: 0, totalDuration: 0 };
      stats.count++;
      stats.totalDuration += duration;
      this.eventStats.set(eventName, stats);
      
      this.logIfAvailable('debug', 'Event published successfully', {
        category: 'performance',
        data: {
          service: 'EventBus',
          eventName,
          duration,
          listenerCount,
          result,
          totalEmissions: stats.count
        }
      });
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      this.logIfAvailable('error', `Event emission failed: ${error.message}`, {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName,
          duration,
          listenerCount,
          errorType: error.constructor.name,
          argsCount: args.length
        }
      });
      
      throw error;
    }
  }

  on(eventName, listener) {
    this.logIfAvailable('debug', 'Event listener registered', {
      category: 'core',
      data: {
        service: 'EventBus',
        eventName,
        listenerName: listener.name || 'anonymous',
        currentListenerCount: this.listenerCount(eventName)
      }
    });

    try {
      const result = super.on(eventName, listener);
      
      this.logIfAvailable('debug', 'Event listener registered successfully', {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName,
          newListenerCount: this.listenerCount(eventName)
        }
      });
      
      return result;
    } catch (error) {
      this.logIfAvailable('error', `Event listener registration failed: ${error.message}`, {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName,
          errorType: error.constructor.name,
          listenerName: listener.name || 'anonymous'
        }
      });
      
      throw error;
    }
  }

  once(eventName, listener) {
    this.logIfAvailable('debug', 'One-time event listener registered', {
      category: 'core',
      data: {
        service: 'EventBus',
        eventName,
        listenerName: listener.name || 'anonymous',
        currentListenerCount: this.listenerCount(eventName)
      }
    });

    try {
      const result = super.once(eventName, listener);
      
      this.logIfAvailable('debug', 'One-time event listener registered successfully', {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName,
          newListenerCount: this.listenerCount(eventName)
        }
      });
      
      return result;
    } catch (error) {
      this.logIfAvailable('error', `One-time event listener registration failed: ${error.message}`, {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName,
          errorType: error.constructor.name,
          listenerName: listener.name || 'anonymous'
        }
      });
      
      throw error;
    }
  }

  off(eventName, listener) {
    const currentCount = this.listenerCount(eventName);
    
    this.logIfAvailable('debug', 'Event listener removal requested', {
      category: 'core',
      data: {
        service: 'EventBus',
        eventName,
        listenerName: listener.name || 'anonymous',
        currentListenerCount: currentCount
      }
    });

    try {
      const result = super.off(eventName, listener);
      const newCount = this.listenerCount(eventName);
      
      this.logIfAvailable('debug', 'Event listener removed successfully', {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName,
          previousListenerCount: currentCount,
          newListenerCount: newCount,
          removed: currentCount > newCount
        }
      });
      
      return result;
    } catch (error) {
      this.logIfAvailable('error', `Event listener removal failed: ${error.message}`, {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName,
          errorType: error.constructor.name,
          listenerName: listener.name || 'anonymous'
        }
      });
      
      throw error;
    }
  }

  removeAllListeners(eventName) {
    const currentCount = eventName ? this.listenerCount(eventName) : this.eventNames().reduce((total, name) => total + this.listenerCount(name), 0);
    
    this.logIfAvailable('info', 'Removing all event listeners', {
      category: 'core',
      data: {
        service: 'EventBus',
        eventName: eventName || 'all_events',
        currentListenerCount: currentCount,
        eventCount: eventName ? 1 : this.eventNames().length
      }
    });

    try {
      const result = super.removeAllListeners(eventName);
      
      this.logIfAvailable('info', 'All event listeners removed successfully', {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName: eventName || 'all_events',
          removedListenerCount: currentCount,
          success: true
        }
      });
      
      return result;
    } catch (error) {
      this.logIfAvailable('error', `Remove all listeners failed: ${error.message}`, {
        category: 'core',
        data: {
          service: 'EventBus',
          eventName: eventName || 'all_events',
          errorType: error.constructor.name,
          currentListenerCount: currentCount
        }
      });
      
      throw error;
    }
  }

  // Utility method to get event statistics
  getEventStats() {
    const stats = {};
    for (const [eventName, data] of this.eventStats.entries()) {
      stats[eventName] = {
        ...data,
        averageDuration: data.totalDuration / data.count,
        currentListeners: this.listenerCount(eventName)
      };
    }
    
    this.logIfAvailable('debug', 'Event statistics requested', {
      category: 'performance',
      data: {
        service: 'EventBus',
        trackedEvents: this.eventStats.size,
        totalEvents: Object.keys(stats).length
      }
    });
    
    return stats;
  }

  // Utility method to log current event bus state
  logCurrentState() {
    const eventNames = this.eventNames();
    const totalListeners = eventNames.reduce((total, name) => total + this.listenerCount(name), 0);
    
    this.logIfAvailable('info', 'Event bus current state', {
      category: 'core',
      data: {
        service: 'EventBus',
        activeEvents: eventNames.length,
        totalListeners,
        maxListeners: this.getMaxListeners(),
        eventNames: eventNames
      }
    });
  }
}

// Create and export a singleton event emitter
const eventBus = new LoggedEventBus();

module.exports = eventBus;
