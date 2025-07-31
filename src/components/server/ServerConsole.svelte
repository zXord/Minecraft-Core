<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount, afterUpdate } from 'svelte';
  import { serverState, addServerLog } from '../../stores/serverState.js';
  import { LogFormatter } from '../../utils/logFormatter.js';
  import logger from '../../utils/logger.js';
  
  // Local state
  let consoleEl;
  let autoScroll = true;
  let command = '';
  
  // Access the logs from the store
  $: serverLogs = $serverState.logs;
  
  // Performance optimized log formatting with caching
  $: groupedLogs = (() => {
    try {
      return LogFormatter.groupLogsByDate(serverLogs);
    } catch (error) {
      logger.error('Error grouping logs by date', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'groupedLogs',
          errorMessage: error.message,
          logsCount: serverLogs ? serverLogs.length : 0
        }
      });
      // Return fallback grouping
      return { [new Date().toDateString()]: serverLogs || [] };
    }
  })();
  
  $: showDateSeparators = (() => {
    try {
      return Object.keys(groupedLogs).length > 1;
    } catch (error) {
      logger.warn('Error determining date separators', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'showDateSeparators',
          errorMessage: error.message
        }
      });
      return false;
    }
  })();
  
  // Optimized log formatting using efficient batch processing
  $: formattedLogs = (() => {
    try {
      if (!Array.isArray(serverLogs)) {
        logger.warn('Server logs is not an array, using empty array', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'formattedLogs',
            serverLogsType: typeof serverLogs
          }
        });
        return [];
      }

      if (!showDateSeparators) {
        // Single day or no logs - use batch formatting for performance
        return LogFormatter.batchFormatLogs(serverLogs.filter(log => log !== null && log !== undefined));
      }
      
      // Multiple days - use optimized separator creation
      return LogFormatter.createFormattedLogsWithSeparators(groupedLogs);
    } catch (error) {
      logger.error('Critical error formatting logs', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'formattedLogs',
          errorMessage: error.message,
          serverLogsLength: serverLogs ? serverLogs.length : 0
        }
      });
      // Ultimate fallback - return raw logs or empty array
      return Array.isArray(serverLogs) ? serverLogs.filter(log => log !== null && log !== undefined) : [];
    }
  })();
  
  // Virtual scrolling variables with error handling
  let startIndex = 0;
  let visibleCount = 50; // Show 50 items at a time
  
  $: totalLogs = (() => {
    try {
      return Array.isArray(formattedLogs) ? formattedLogs.length : 0;
    } catch (error) {
      logger.warn('Error calculating total logs', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'totalLogs',
          errorMessage: error.message
        }
      });
      return 0;
    }
  })();
  
  $: endIndex = (() => {
    try {
      return Math.min(startIndex + visibleCount, totalLogs);
    } catch (error) {
      logger.warn('Error calculating end index', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'endIndex',
          startIndex,
          visibleCount,
          totalLogs,
          errorMessage: error.message
        }
      });
      return Math.min(50, totalLogs); // Fallback to first 50 items
    }
  })();
  
  $: visibleLogs = (() => {
    try {
      if (!Array.isArray(formattedLogs)) {
        logger.warn('Formatted logs is not an array for slicing', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'visibleLogs',
            formattedLogsType: typeof formattedLogs
          }
        });
        return [];
      }
      
      // Ensure indices are valid
      const safeStartIndex = Math.max(0, Math.min(startIndex, totalLogs));
      const safeEndIndex = Math.max(safeStartIndex, Math.min(endIndex, totalLogs));
      
      return formattedLogs.slice(safeStartIndex, safeEndIndex);
    } catch (error) {
      logger.error('Error slicing visible logs', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'visibleLogs',
          startIndex,
          endIndex,
          totalLogs,
          errorMessage: error.message
        }
      });
      return []; // Return empty array on error
    }
  })();
  
  // Calculate the height for spacers with error handling
  const itemHeight = 21; // Approximate height of each log line in pixels
  
  $: topSpacerHeight = (() => {
    try {
      return Math.max(0, startIndex * itemHeight);
    } catch (error) {
      logger.warn('Error calculating top spacer height', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'topSpacerHeight',
          startIndex,
          itemHeight,
          errorMessage: error.message
        }
      });
      return 0;
    }
  })();
  
  $: bottomSpacerHeight = (() => {
    try {
      return Math.max(0, (totalLogs - endIndex) * itemHeight);
    } catch (error) {
      logger.warn('Error calculating bottom spacer height', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'bottomSpacerHeight',
          totalLogs,
          endIndex,
          itemHeight,
          errorMessage: error.message
        }
      });
      return 0;
    }
  })();
  
  function onConsoleScroll() {
    try {
      // Add null check to prevent error
      if (!consoleEl) {
        logger.warn('Console scroll event with null console element', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'onConsoleScroll',
            consoleElExists: !!consoleEl
          }
        });
        return;
      }
      
      // Validate console element properties
      if (typeof consoleEl.scrollTop !== 'number' || 
          typeof consoleEl.clientHeight !== 'number' || 
          typeof consoleEl.scrollHeight !== 'number') {
        logger.warn('Console element has invalid scroll properties', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'onConsoleScroll',
            scrollTop: consoleEl.scrollTop,
            clientHeight: consoleEl.clientHeight,
            scrollHeight: consoleEl.scrollHeight
          }
        });
        return;
      }
      
      const wasAutoScroll = autoScroll;
      
      // If user scrolls up, disable autoScroll with error handling
      try {
        autoScroll = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 5;
      } catch (scrollError) {
        logger.warn('Error calculating auto-scroll state', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'onConsoleScroll.autoScroll',
            errorMessage: scrollError.message
          }
        });
        // Keep current autoScroll state on error
      }
      
      // Update virtual scrolling indices based on scroll position
      if (!autoScroll) {
        try {
          const scrollTop = Math.max(0, consoleEl.scrollTop);
          const newStartIndex = Math.floor(scrollTop / itemHeight);
          const maxStartIndex = Math.max(0, totalLogs - visibleCount);
          startIndex = Math.max(0, Math.min(newStartIndex, maxStartIndex));
          
          if (wasAutoScroll !== autoScroll) {
            logger.debug('Auto-scroll disabled by user interaction', {
              category: 'ui',
              data: {
                component: 'ServerConsole',
                function: 'onConsoleScroll',
                scrollTop,
                startIndex,
                totalLogs
              }
            });
          }
        } catch (indexError) {
          logger.warn('Error updating virtual scroll indices', {
            category: 'ui',
            data: {
              component: 'ServerConsole',
              function: 'onConsoleScroll.indices',
              errorMessage: indexError.message,
              scrollTop: consoleEl.scrollTop,
              totalLogs
            }
          });
          // Keep current startIndex on error
        }
      }
    } catch (error) {
      logger.error('Critical error in console scroll handler', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'onConsoleScroll',
          errorMessage: error.message
        }
      });
      // Don't throw - let the UI continue functioning
    }
  }
  
  afterUpdate(() => {
    try {
      if (autoScroll && consoleEl) {
        // Validate console element before using it
        if (typeof consoleEl.scrollHeight !== 'number') {
          logger.warn('Console element scrollHeight is invalid in afterUpdate', {
            category: 'ui',
            data: {
              component: 'ServerConsole',
              function: 'afterUpdate',
              scrollHeight: consoleEl.scrollHeight
            }
          });
          return;
        }
        
        // When auto-scrolling, show the most recent logs
        try {
          const newStartIndex = Math.max(0, totalLogs - visibleCount);
          
          if (newStartIndex !== startIndex) {
            // Disabled debug logging to prevent excessive logs
            // logger.debug('Auto-scrolling to latest logs', {
            //   category: 'ui',
            //   data: {
            //     component: 'ServerConsole',
            //     function: 'afterUpdate',
            //     oldStartIndex: startIndex,
            //     newStartIndex,
            //     totalLogs
            //   }
            // });
          }
          
          startIndex = newStartIndex;
          
          // Safely set scroll position
          try {
            consoleEl.scrollTop = consoleEl.scrollHeight;
          } catch (scrollError) {
            logger.warn('Error setting scroll position in afterUpdate', {
              category: 'ui',
              data: {
                component: 'ServerConsole',
                function: 'afterUpdate.scroll',
                errorMessage: scrollError.message,
                scrollHeight: consoleEl.scrollHeight
              }
            });
          }
        } catch (indexError) {
          logger.warn('Error calculating start index in afterUpdate', {
            category: 'ui',
            data: {
              component: 'ServerConsole',
              function: 'afterUpdate.index',
              errorMessage: indexError.message,
              totalLogs,
              visibleCount
            }
          });
        }
      }
    } catch (error) {
      logger.error('Critical error in afterUpdate', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'afterUpdate',
          errorMessage: error.message,
          autoScroll,
          consoleElExists: !!consoleEl
        }
      });
      // Don't throw - let the component continue functioning
    }
  });
  
  async function sendCommand() {
    if (!command.trim()) {
      logger.debug('Empty command ignored', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'sendCommand',
          command
        }
      });
      return;
    }
    
    logger.info('Sending server command', {
      category: 'ui',
      data: {
        component: 'ServerConsole',
        function: 'sendCommand',
        command: command.trim(),
        commandLength: command.trim().length
      }
    });
    
    try {
      const ok = await window.electron.invoke('send-command', { command });
      
      if (ok) {
        logger.info('Server command sent successfully', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'sendCommand',
            command: command.trim(),
            success: true
          }
        });
        addServerLog(`[SENT] ${command}`);
      } else {
        logger.error('Failed to send server command', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'sendCommand',
            command: command.trim(),
            success: false
          }
        });
        addServerLog('[ERR] Failed to send command');
      }
    } catch (error) {
      logger.error('Error sending server command', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'sendCommand',
          command: command.trim(),
          errorMessage: error.message
        }
      });
      addServerLog(`[ERR] Command failed: ${error.message}`);
    }
    
    command = '';
  }

  // Handle server log events with error recovery
  const logHandler = (line) => {
    try {
      // Disabled debug logging to prevent excessive logs
      // logger.debug('Received server log line', {
      //   category: 'ui',
      //   data: {
      //     component: 'ServerConsole',
      //     function: 'logHandler',
      //     lineLength: line ? line.length : 0,
      //     hasLine: !!line
      //   }
      // });
      
      // Validate the log line before adding
      if (line === null || line === undefined) {
        logger.warn('Received null/undefined log line, skipping', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'logHandler',
            line
          }
        });
        return;
      }
      
      // Convert non-string lines to strings safely
      let processedLine = line;
      if (typeof line !== 'string') {
        try {
          processedLine = String(line);
          logger.debug('Converted non-string log line to string', {
            category: 'ui',
            data: {
              component: 'ServerConsole',
              function: 'logHandler',
              originalType: typeof line,
              converted: processedLine
            }
          });
        } catch (conversionError) {
          logger.warn('Failed to convert log line to string', {
            category: 'ui',
            data: {
              component: 'ServerConsole',
              function: 'logHandler',
              errorMessage: conversionError.message,
              originalType: typeof line
            }
          });
          processedLine = '(invalid log entry)';
        }
      }
      
      addServerLog(processedLine);
    } catch (error) {
      logger.error('Error in log handler', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'logHandler',
          errorMessage: error.message,
          lineType: typeof line
        }
      });
      
      // Try to add an error log entry
      try {
        addServerLog(`[LOG_ERROR] Failed to process log entry: ${error.message}`);
      } catch (fallbackError) {
        logger.error('Failed to add error log entry', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'logHandler.fallback',
            errorMessage: fallbackError.message
          }
        });
      }
    }
  };

  onMount(() => {
    logger.info('ServerConsole component mounted', {
      category: 'ui',
      data: {
        component: 'ServerConsole',
        function: 'onMount',
        autoScroll,
        visibleCount
      }
    });
    
    // Remove any existing listeners to prevent duplicates
    window.electron.removeAllListeners('server-log');

    // Set up event listener for server logs
    window.electron.on('server-log', logHandler);
    
    // Disabled debug logging to prevent excessive logs
    // logger.debug('Server log listener registered', {
    //   category: 'ui',
    //   data: {
    //     component: 'ServerConsole',
    //     function: 'onMount',
    //     event: 'server-log'
    //   }
    // });

    return () => {
      logger.debug('ServerConsole component unmounting', {
        category: 'ui',
        data: {
          component: 'ServerConsole',
          function: 'onMount.cleanup'
        }
      });
      
      // Clean up event listeners when component is unmounted
      window.electron.removeListener('server-log', logHandler);
    };
  });
</script>

<!-- Fixed console view with improved styling -->
<div class="console-frame-container">
  <!-- Static black background -->
  <div class="console-background"></div>
  
  <!-- Scrollable console content with virtual scrolling -->
  <div class="scrollable-console" bind:this={consoleEl} on:scroll={onConsoleScroll}>
    <!-- Top spacer -->
    {#if topSpacerHeight > 0}
      <div class="virtual-spacer" style="height: {topSpacerHeight}px;"></div>
    {/if}
      <!-- Visible log lines with enhanced formatting -->
    {#if visibleLogs.length === 0}
      <div class="console-line console-empty">
        Server console ready. [{new Date().toLocaleString()}]
      </div>
    {:else}
      {#each visibleLogs as line, index (startIndex + index)}
        <div class="console-line" class:date-separator={line.startsWith('---')}>
          {line}
        </div>
      {/each}
    {/if}
    
    <!-- Bottom spacer -->
    {#if bottomSpacerHeight > 0}
      <div class="virtual-spacer" style="height: {bottomSpacerHeight}px;"></div>
    {/if}
  </div>

  <!-- Command input area -->
  <div class="command-input">
    <input
      type="text"
      placeholder="Enter server command (e.g. say Hello)"
      bind:value={command}
      on:keydown={e => e.key === 'Enter' && sendCommand()}
    />
    <button on:click={sendCommand}>Send</button>
  </div>
</div>

<style>
  /* Main container with fixed dimensions */
  .console-frame-container {
    position: relative;
    width: 100% !important;
    max-width: 1200px !important;
    margin: 0 auto 20px auto;
    height: 700px !important;
    box-sizing: border-box !important;
    /* Ensure this container maintains its size regardless of content */
    min-height: 650px !important;
    max-height: 650px !important;
    overflow: visible;
  }
  
  /* Static black background for console */
  .console-background {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 600px !important;
    min-height: 600px !important;
    max-height: 600px !important;
    background-color: #000000;
    border-radius: 4px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    z-index: 1;
    box-sizing: border-box !important;
  }
  
  /* Scrollable console content area */
  .scrollable-console {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 600px !important;
    min-height: 600px !important;
    max-height: 600px !important;
    padding: 10px;
    box-sizing: border-box !important;
    overflow-y: auto;
    color: #ffffff;
    font-family: monospace;
    font-size: 0.9rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    z-index: 2;
    text-align: left;
    resize: none !important;
    /* Ensure content stays within bounds */
    overflow-x: hidden;
  }
  
  /* Individual console lines */
  .console-line {
    min-height: 1.4em;
    opacity: 1;
    padding: 1px 0;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  
  /* Style for empty console */
  .console-empty {
    color: #888;
    font-style: italic;
  }
  
  /* Date separator styling */
  .console-line.date-separator {
    color: #4a9eff;
    font-weight: bold;
    text-align: center;
    margin: 8px 0 4px 0;
    padding: 4px 0;
    border-top: 1px solid #333;
    border-bottom: 1px solid #333;
    background-color: rgba(74, 158, 255, 0.1);
    font-size: 0.85rem;
    letter-spacing: 0.5px;
  }
  
  /* Enhanced timestamp styling within log entries */
  .console-line:not(.date-separator):not(.console-empty) {
    /* Ensure timestamps are easily readable */
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  }
  
  /* Responsive design for smaller screens */
  @media (max-width: 768px) {
    .scrollable-console {
      font-size: 0.8rem;
      padding: 8px;
    }
    
    .console-line.date-separator {
      font-size: 0.75rem;
      margin: 6px 0 3px 0;
      padding: 3px 0;
    }
    
    .console-line {
      line-height: 1.3;
    }
  }
  
  /* Improved readability for timestamp brackets */
  .console-line:not(.date-separator):not(.console-empty)::before {
    /* This will help distinguish timestamp brackets visually */
    content: '';
  }
  
  /* Virtual scrolling spacers */
  .virtual-spacer {
    min-height: 0;
    width: 100%;
  }
  
  /* Command input area */
  .command-input {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 40px !important;
    min-height: 40px !important;
    display: flex;
    gap: 8px;
    padding-top: 10px;
    z-index: 3;
    box-sizing: border-box !important;
  }
  
  .command-input input {
    flex: 1;
    padding: 8px 12px;
    border-radius: 4px;
    border: 1px solid #555;
    background-color: #333;
    color: #fff;
    height: 36px !important;
    box-sizing: border-box !important;
  }
  
  .command-input button {
    padding: 8px 16px;
    background-color: #4a6da7;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    height: 36px !important;
    box-sizing: border-box !important;
  }
  
  .command-input button:hover {
    background-color: #5a7db7;
  }
</style>
