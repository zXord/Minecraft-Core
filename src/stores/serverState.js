// Server state store
import { writable } from 'svelte/store';
import logger from '../utils/logger.js';

// Default server state structure
const DEFAULT_SERVER_STATE = {
  status: 'Stopped',
  logs: [],
  cpuLoad: 0,
  memUsedMB: 0,
  maxRamMB: 0,
  uptime: '0h 0m 0s',
  port: 25565,
  maxRam: 4,
};

// Validate server state structure
function validateServerState(state) {
  try {
    if (!state || typeof state !== 'object') {
      logger.warn('Invalid server state: not an object', {
        category: 'core',
        data: {
          store: 'serverState',
          function: 'validateServerState',
          stateType: typeof state,
          isNull: state === null
        }
      });
      return false;
    }

    const requiredFields = ['status', 'logs', 'cpuLoad', 'memUsedMB', 'maxRamMB', 'uptime', 'port', 'maxRam'];
    const missingFields = requiredFields.filter(field => !(field in state));
    
    if (missingFields.length > 0) {
      logger.warn('Server state missing required fields', {
        category: 'core',
        data: {
          store: 'serverState',
          function: 'validateServerState',
          missingFields,
          presentFields: Object.keys(state)
        }
      });
      return false;
    }

    // Validate specific field types
    if (typeof state.status !== 'string' || !Array.isArray(state.logs)) {
      logger.warn('Server state has invalid field types', {
        category: 'core',
        data: {
          store: 'serverState',
          function: 'validateServerState',
          statusType: typeof state.status,
          logsIsArray: Array.isArray(state.logs)
        }
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`Server state validation failed: ${error.message}`, {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'validateServerState',
        errorType: error.constructor.name,
        stack: error.stack
      }
    });
    return false;
  }
}

// Recover corrupted server state
function recoverServerState(corruptedState) {
  logger.warn('Attempting to recover corrupted server state', {
    category: 'core',
    data: {
      store: 'serverState',
      function: 'recoverServerState',
      corruptedStateKeys: corruptedState ? Object.keys(corruptedState) : null
    }
  });

  try {
    const recoveredState = { ...DEFAULT_SERVER_STATE };
    
    // Try to preserve valid fields from corrupted state
    if (corruptedState && typeof corruptedState === 'object') {
      Object.keys(DEFAULT_SERVER_STATE).forEach(key => {
        if (key in corruptedState && typeof corruptedState[key] === typeof DEFAULT_SERVER_STATE[key]) {
          recoveredState[key] = corruptedState[key];
        }
      });
    }

    logger.info('Server state recovered successfully', {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'recoverServerState',
        recoveredFields: Object.keys(recoveredState),
        preservedFields: corruptedState ? Object.keys(corruptedState).filter(key => key in recoveredState) : []
      }
    });

    return recoveredState;
  } catch (error) {
    logger.error(`Server state recovery failed: ${error.message}`, {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'recoverServerState',
        errorType: error.constructor.name,
        fallbackToDefault: true
      }
    });
    return { ...DEFAULT_SERVER_STATE };
  }
}

// Create the server state store with validation and recovery
function createServerStateStore() {
  logger.debug('Initializing server state store', {
    category: 'core',
    data: {
      store: 'serverState',
      function: 'createServerStateStore',
      defaultState: Object.keys(DEFAULT_SERVER_STATE)
    }
  });

  const { subscribe, set, update } = writable(DEFAULT_SERVER_STATE);

  return {
    subscribe,
    set: (value) => {
      try {
        if (validateServerState(value)) {
          logger.debug('Server state set with valid data', {
            category: 'core',
            data: {
              store: 'serverState',
              function: 'set',
              status: value.status,
              logsCount: value.logs?.length || 0
            }
          });
          set(value);
        } else {
          const recoveredState = recoverServerState(value);
          logger.warn('Server state set with invalid data, using recovered state', {
            category: 'core',
            data: {
              store: 'serverState',
              function: 'set',
              recoveryApplied: true
            }
          });
          set(recoveredState);
        }
      } catch (error) {
        logger.error(`Server state set failed: ${error.message}`, {
          category: 'core',
          data: {
            store: 'serverState',
            function: 'set',
            errorType: error.constructor.name,
            fallbackToDefault: true
          }
        });
        set({ ...DEFAULT_SERVER_STATE });
      }
    },
    update: (updater) => {
      try {
        update((currentState) => {
          const newState = updater(currentState);
          
          if (validateServerState(newState)) {
            // Log state transitions
            if (currentState.status !== newState.status) {
              logger.info('Server state transition detected', {
                category: 'core',
                data: {
                  store: 'serverState',
                  function: 'update',
                  transition: `${currentState.status} -> ${newState.status}`,
                  oldStatus: currentState.status,
                  newStatus: newState.status,
                  timestamp: Date.now()
                }
              });
            }

            // Log significant metric changes
            if (Math.abs(currentState.cpuLoad - newState.cpuLoad) > 10 || 
                Math.abs(currentState.memUsedMB - newState.memUsedMB) > 100) {
              logger.debug('Server metrics changed significantly', {
                category: 'performance',
                data: {
                  store: 'serverState',
                  function: 'update',
                  cpuChange: newState.cpuLoad - currentState.cpuLoad,
                  memChange: newState.memUsedMB - currentState.memUsedMB,
                  newCpu: newState.cpuLoad,
                  newMem: newState.memUsedMB
                }
              });
            }

            return newState;
          } else {
            const recoveredState = recoverServerState(newState);
            logger.warn('Server state update produced invalid state, using recovered state', {
              category: 'core',
              data: {
                store: 'serverState',
                function: 'update',
                recoveryApplied: true,
                originalStatus: newState?.status,
                recoveredStatus: recoveredState.status
              }
            });
            return recoveredState;
          }
        });
      } catch (error) {
        logger.error(`Server state update failed: ${error.message}`, {
          category: 'core',
          data: {
            store: 'serverState',
            function: 'update',
            errorType: error.constructor.name,
            stack: error.stack
          }
        });
        // Don't update on error to maintain current state
      }
    }
  };
}

// Create the server state store with enhanced validation and recovery
export const serverState = createServerStateStore();

// Helper functions to update specific parts of the server state
export function updateServerMetrics(metrics) {
  try {
    if (!metrics || typeof metrics !== 'object') {
      logger.warn('Invalid metrics provided to updateServerMetrics', {
        category: 'core',
        data: {
          store: 'serverState',
          function: 'updateServerMetrics',
          metricsType: typeof metrics,
          isNull: metrics === null
        }
      });
      return;
    }

    logger.debug('Updating server metrics', {
      category: 'performance',
      data: {
        store: 'serverState',
        function: 'updateServerMetrics',
        cpuPct: metrics.cpuPct,
        memUsedMB: metrics.memUsedMB,
        maxRamMB: metrics.maxRamMB,
        uptime: metrics.uptime,
        hasAllFields: !!(metrics.cpuPct !== undefined && metrics.memUsedMB !== undefined)
      }
    });
    
    serverState.update(state => {
      try {
        // Only update metrics if server is running or if explicitly zeroing them out
        const shouldUpdate = state.status === 'Running' || 
            (metrics.cpuPct === 0 && metrics.memUsedMB === 0 && metrics.uptime === '0h 0m 0s');

        if (!shouldUpdate) {
          logger.debug('Skipping metrics update - server not running', {
            category: 'performance',
            data: {
              store: 'serverState',
              function: 'updateServerMetrics',
              serverStatus: state.status,
              metricsZeroed: metrics.cpuPct === 0 && metrics.memUsedMB === 0
            }
          });
          return state;
        }

        const updatedState = {
          ...state,
          cpuLoad: typeof metrics.cpuPct === 'number' ? metrics.cpuPct : state.cpuLoad,
          memUsedMB: typeof metrics.memUsedMB === 'number' ? metrics.memUsedMB : state.memUsedMB,
          maxRamMB: typeof metrics.maxRamMB === 'number' ? metrics.maxRamMB : (state.maxRam * 1024),
          uptime: typeof metrics.uptime === 'string' ? metrics.uptime : state.uptime
        };

        // Log performance thresholds
        if (updatedState.cpuLoad > 80) {
          logger.warn('High CPU usage detected', {
            category: 'performance',
            data: {
              store: 'serverState',
              function: 'updateServerMetrics',
              cpuLoad: updatedState.cpuLoad,
              threshold: 80
            }
          });
        }

        if (updatedState.memUsedMB > (updatedState.maxRamMB * 0.9)) {
          logger.warn('High memory usage detected', {
            category: 'performance',
            data: {
              store: 'serverState',
              function: 'updateServerMetrics',
              memUsedMB: updatedState.memUsedMB,
              maxRamMB: updatedState.maxRamMB,
              usagePercent: Math.round((updatedState.memUsedMB / updatedState.maxRamMB) * 100)
            }
          });
        }

        return updatedState;
      } catch (error) {
        logger.error(`Failed to update server metrics: ${error.message}`, {
          category: 'core',
          data: {
            store: 'serverState',
            function: 'updateServerMetrics.update',
            errorType: error.constructor.name,
            metricsProvided: Object.keys(metrics || {})
          }
        });
        return state; // Return unchanged state on error
      }
    });
  } catch (error) {
    logger.error(`updateServerMetrics failed: ${error.message}`, {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'updateServerMetrics',
        errorType: error.constructor.name,
        stack: error.stack
      }
    });
  }
}

// Performance optimization: batch log updates
const MAX_LOGS = 200;
let pendingLogs = [];
let updateTimeout = null;
let logStats = {
  totalProcessed: 0,
  batchesProcessed: 0,
  lastBatchTime: 0
};

// Import LogFormatter for consistent timestamp formatting
import { LogFormatter } from '../utils/logFormatter.js';

// Ensure addServerLog efficiently handles log updates
export function addServerLog(logLine) {
  try {
    if (!logLine || typeof logLine !== 'string') {
      // Disabled debug logging to prevent excessive logs
      // logger.debug('Attempted to add invalid log line', {
      //   category: 'core',
      //   data: {
      //     store: 'serverState',
      //     function: 'addServerLog',
      //     logLineType: typeof logLine,
      //     isEmpty: !logLine,
      //     length: logLine?.length || 0
      //   }
      // });
      return;
    }
    
    // Format the log with timestamp when it's first added (preserves original timestamp)
    const formattedLogLine = LogFormatter.formatLogEntry(logLine);
    
    // Add to pending logs (don't log every single line to avoid spam)
    pendingLogs.push(formattedLogLine);
    logStats.totalProcessed++;
    
    // If we have too many pending logs or no timeout is scheduled, process them
    if (pendingLogs.length >= 10 || !updateTimeout) {
      if (updateTimeout) {
        clearTimeout(updateTimeout);
      }
      
      // Schedule update for next frame
      updateTimeout = setTimeout(() => {
        try {
          if (pendingLogs.length === 0) return;
          
          const batchSize = pendingLogs.length;
          const batchStartTime = Date.now();
          
          // Update logs in batch
          serverState.update(state => {
            try {
              // Ensure we don't exceed our max logs limit
              const allLogs = [...state.logs, ...pendingLogs];
              const logs = allLogs.slice(-MAX_LOGS);
              const trimmedCount = allLogs.length - logs.length;
              
              // Update statistics
              logStats.batchesProcessed++;
              logStats.lastBatchTime = Date.now() - batchStartTime;
              
              // Log batch processing info (only occasionally to avoid spam)
              if (logStats.batchesProcessed % 100 === 0 || trimmedCount > 0) {
                logger.debug('Processing server log batch', {
                  category: 'performance',
                  data: {
                    store: 'serverState',
                    function: 'addServerLog.batchUpdate',
                    batchSize,
                    totalLogsAfter: logs.length,
                    maxLogs: MAX_LOGS,
                    trimmedCount,
                    batchProcessingTime: logStats.lastBatchTime,
                    totalBatches: logStats.batchesProcessed,
                    totalLogsProcessed: logStats.totalProcessed
                  }
                });
              }
              
              // Clear pending logs
              pendingLogs = [];
              updateTimeout = null;
              
              return { ...state, logs };
            } catch (error) {
              logger.error(`Failed to process log batch: ${error.message}`, {
                category: 'core',
                data: {
                  store: 'serverState',
                  function: 'addServerLog.batchUpdate',
                  errorType: error.constructor.name,
                  batchSize,
                  currentLogsCount: state.logs?.length || 0
                }
              });
              
              // Clear pending logs to prevent infinite retry
              pendingLogs = [];
              updateTimeout = null;
              return state;
            }
          });
        } catch (error) {
          logger.error(`Log batch processing failed: ${error.message}`, {
            category: 'core',
            data: {
              store: 'serverState',
              function: 'addServerLog.timeout',
              errorType: error.constructor.name,
              pendingLogsCount: pendingLogs.length
            }
          });
          
          // Clear state to prevent issues
          pendingLogs = [];
          updateTimeout = null;
        }
      }, 16); // ~60fps
    }
  } catch (error) {
    logger.error(`addServerLog failed: ${error.message}`, {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'addServerLog',
        errorType: error.constructor.name,
        logLineLength: logLine?.length || 0,
        pendingLogsCount: pendingLogs.length
      }
    });
  }
}

export function clearServerLogs() {
  try {
    const currentLogsCount = pendingLogs.length;
    const hadTimeout = !!updateTimeout;
    
    logger.info('Clearing server logs', {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'clearServerLogs',
        pendingLogsCount: currentLogsCount,
        hasUpdateTimeout: hadTimeout,
        totalProcessedBefore: logStats.totalProcessed,
        batchesProcessedBefore: logStats.batchesProcessed
      }
    });
    
    // Clear pending state
    pendingLogs = [];
    if (updateTimeout) {
      clearTimeout(updateTimeout);
      updateTimeout = null;
    }
    
    // Reset statistics
    const oldStats = { ...logStats };
    logStats = {
      totalProcessed: 0,
      batchesProcessed: 0,
      lastBatchTime: 0
    };
    
    serverState.update(state => {
      try {
        const clearedLogsCount = state.logs?.length || 0;
        
        logger.info('Server logs cleared successfully', {
          category: 'core',
          data: {
            store: 'serverState',
            function: 'clearServerLogs.update',
            clearedLogsCount,
            statsReset: true,
            previousStats: oldStats
          }
        });
        
        return { ...state, logs: [] };
      } catch (error) {
        logger.error(`Failed to clear server logs in state update: ${error.message}`, {
          category: 'core',
          data: {
            store: 'serverState',
            function: 'clearServerLogs.update',
            errorType: error.constructor.name
          }
        });
        return state;
      }
    });
  } catch (error) {
    logger.error(`clearServerLogs failed: ${error.message}`, {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'clearServerLogs',
        errorType: error.constructor.name,
        stack: error.stack
      }
    });
  }
}

export function updateServerStatus(status) {
  try {
    if (!status || typeof status !== 'string') {
      logger.warn('Attempted to update server status with invalid value', {
        category: 'core',
        data: {
          store: 'serverState',
          function: 'updateServerStatus',
          status,
          statusType: typeof status,
          isEmpty: !status
        }
      });
      return;
    }

    // Validate status value
    const validStatuses = ['Stopped', 'Starting', 'Running', 'Stopping', 'Error', 'Unknown'];
    if (!validStatuses.includes(status)) {
      logger.warn('Invalid server status provided', {
        category: 'core',
        data: {
          store: 'serverState',
          function: 'updateServerStatus',
          providedStatus: status,
          validStatuses
        }
      });
      return;
    }
    
    logger.info('Updating server status', {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'updateServerStatus',
        newStatus: status,
        timestamp: Date.now()
      }
    });
    
    serverState.update(state => {
      try {
        const oldStatus = state.status;
        const statusChanged = oldStatus !== status;
        
        if (statusChanged) {
          // Log detailed status transition
          logger.info('Server status transition', {
            category: 'core',
            data: {
              store: 'serverState',
              function: 'updateServerStatus',
              transition: `${oldStatus} -> ${status}`,
              oldStatus,
              newStatus: status,
              timestamp: Date.now(),
              transitionType: getTransitionType(oldStatus, status)
            }
          });

          // Log specific transition events
          if (status === 'Running' && oldStatus !== 'Running') {
            logger.info('Server started successfully', {
              category: 'server',
              data: {
                store: 'serverState',
                function: 'updateServerStatus',
                previousStatus: oldStatus,
                startupComplete: true
              }
            });
          } else if (status === 'Stopped' && oldStatus !== 'Stopped') {
            logger.info('Server stopped', {
              category: 'server',
              data: {
                store: 'serverState',
                function: 'updateServerStatus',
                previousStatus: oldStatus,
                shutdownComplete: true
              }
            });
          } else if (status === 'Error') {
            logger.error('Server entered error state', {
              category: 'server',
              data: {
                store: 'serverState',
                function: 'updateServerStatus',
                previousStatus: oldStatus,
                errorState: true
              }
            });
          }
        } else {
          logger.debug('Server status update with same value', {
            category: 'core',
            data: {
              store: 'serverState',
              function: 'updateServerStatus',
              status,
              noChange: true
            }
          });
        }
        
        return { ...state, status };
      } catch (error) {
        logger.error(`Failed to update server status in state: ${error.message}`, {
          category: 'core',
          data: {
            store: 'serverState',
            function: 'updateServerStatus.update',
            errorType: error.constructor.name,
            attemptedStatus: status,
            currentStatus: state.status
          }
        });
        return state; // Return unchanged state on error
      }
    });
  } catch (error) {
    logger.error(`updateServerStatus failed: ${error.message}`, {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'updateServerStatus',
        errorType: error.constructor.name,
        attemptedStatus: status,
        stack: error.stack
      }
    });
  }
}

// Helper function to categorize status transitions
function getTransitionType(oldStatus, newStatus) {
  const startupTransitions = ['Stopped->Starting', 'Starting->Running'];
  const shutdownTransitions = ['Running->Stopping', 'Stopping->Stopped'];
  const errorTransitions = ['Starting->Error', 'Running->Error', 'Stopping->Error'];
  
  const transition = `${oldStatus}->${newStatus}`;
  
  if (startupTransitions.includes(transition)) return 'startup';
  if (shutdownTransitions.includes(transition)) return 'shutdown';
  if (errorTransitions.includes(transition)) return 'error';
  if (newStatus === 'Unknown') return 'unknown';
  
  return 'other';
}

// Export function to get current server state synchronously (for debugging)
export function getServerStateSnapshot() {
  /** @type {{status: string, logs: Array, cpuLoad: number, memUsedMB: number} | null} */
  let currentState = null;
  
  try {
    const unsubscribe = serverState.subscribe(state => {
      currentState = state;
    });
    unsubscribe();
    
    logger.debug('Server state snapshot retrieved', {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'getServerStateSnapshot',
        hasState: !!currentState,
        status: (currentState && currentState.status) || 'unknown',
        logsCount: (currentState && currentState.logs && currentState.logs.length) || 0,
        cpuLoad: (currentState && currentState.cpuLoad) || 0,
        memUsedMB: (currentState && currentState.memUsedMB) || 0
      }
    });
    
    return currentState;
  } catch (error) {
    logger.error(`Failed to get server state snapshot: ${error.message}`, {
      category: 'core',
      data: {
        store: 'serverState',
        function: 'getServerStateSnapshot',
        errorType: error.constructor.name
      }
    });
    return null;
  }
}

// Export function to persist server state (for recovery scenarios)
export function persistServerState() {
  try {
    const snapshot = getServerStateSnapshot();
    if (!snapshot) {
      logger.warn('Cannot persist server state - snapshot unavailable', {
        category: 'storage',
        data: {
          store: 'serverState',
          function: 'persistServerState',
          snapshotNull: true
        }
      });
      return false;
    }

    // In a real implementation, this would save to localStorage or file
    // For now, we just log the persistence operation
    logger.info('Server state persistence requested', {
      category: 'storage',
      data: {
        store: 'serverState',
        function: 'persistServerState',
        status: snapshot.status,
        logsCount: snapshot.logs.length,
        timestamp: Date.now(),
        persistenceMethod: 'memory' // Would be 'localStorage' or 'file' in real implementation
      }
    });

    return true;
  } catch (error) {
    logger.error(`Server state persistence failed: ${error.message}`, {
      category: 'storage',
      data: {
        store: 'serverState',
        function: 'persistServerState',
        errorType: error.constructor.name,
        stack: error.stack
      }
    });
    return false;
  }
}
