<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { afterUpdate } from 'svelte';
  import { serverState, addServerLog } from '../../stores/serverState.js';
  import { LogFormatter } from '../../utils/logFormatter.js';
  import logger from '../../utils/logger.js';
  
  export let currentInstance = null;

  // Local state
  let consoleEl;
  let autoScroll = true;
  let command = '';
  const DEFAULT_VISIBLE_LOGS = 400;
  const LOG_PAGE_SIZE = 300;
  let visibleLogCount = DEFAULT_VISIBLE_LOGS;
  // Access the logs from the store
  $: serverLogs = $serverState.logs;
  $: hiddenLogCount = Math.max(0, (serverLogs?.length || 0) - visibleLogCount);
  $: visibleServerLogs = Array.isArray(serverLogs)
    ? serverLogs.slice(Math.max(0, serverLogs.length - visibleLogCount))
    : [];
  
  // Performance optimized log formatting with caching
  $: groupedLogs = (() => {
    try {
      return LogFormatter.groupLogsByDate(visibleServerLogs);
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
      return { [new Date().toDateString()]: visibleServerLogs || [] };
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
      if (!Array.isArray(visibleServerLogs)) {
        logger.warn('Server logs is not an array, using empty array', {
          category: 'ui',
          data: {
            component: 'ServerConsole',
            function: 'formattedLogs',
            serverLogsType: typeof visibleServerLogs
          }
        });
        return [];
      }

      if (!showDateSeparators) {
        // Single day or no logs - use batch formatting for performance
        return LogFormatter.batchFormatLogs(visibleServerLogs.filter(log => log !== null && log !== undefined));
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
      return Array.isArray(visibleServerLogs) ? visibleServerLogs.filter(log => log !== null && log !== undefined) : [];
    }
  })();

  function loadOlderLogs() {
    autoScroll = false;
    const previousScrollHeight = consoleEl?.scrollHeight || 0;
    visibleLogCount = Math.min((serverLogs?.length || 0), visibleLogCount + LOG_PAGE_SIZE);

    requestAnimationFrame(() => {
      if (!consoleEl) {
        return;
      }

      const nextScrollHeight = consoleEl.scrollHeight || 0;
      const scrollDelta = Math.max(0, nextScrollHeight - previousScrollHeight);
      consoleEl.scrollTop += scrollDelta;
    });
  }

  function jumpToLatestLogs() {
    visibleLogCount = DEFAULT_VISIBLE_LOGS;
    autoScroll = true;

    requestAnimationFrame(() => {
      if (consoleEl) {
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
    });
  }

  $: if (autoScroll && visibleLogCount !== DEFAULT_VISIBLE_LOGS) {
    visibleLogCount = DEFAULT_VISIBLE_LOGS;
  }
  
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
      const result = await window.electron.invoke('send-command', {
        command,
        instanceId: currentInstanceId,
        targetPath: currentInstance?.path || null
      });
      
      if (result?.success) {
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

</script>

<!-- Fixed console view with improved styling -->
<div class="console-frame-container">
  <!-- Static black background -->
  <div class="console-background"></div>
  
  <!-- Scrollable console content -->
  <div class="scrollable-console" bind:this={consoleEl} on:scroll={onConsoleScroll}>
    {#if hiddenLogCount > 0}
      <div class="console-toolbar">
        <button type="button" class="console-toolbar-button" on:click={loadOlderLogs}>
          Load Older Logs ({hiddenLogCount})
        </button>
        <button type="button" class="console-toolbar-button secondary" on:click={jumpToLatestLogs}>
          Jump To Latest
        </button>
      </div>
    {/if}

    <!-- Visible log lines -->
    {#if !formattedLogs || formattedLogs.length === 0}
      <div class="console-line console-empty">
        Server console ready. [{new Date().toLocaleString()}]
      </div>
    {:else}
      {#each formattedLogs as line, index (index)}
        <div class="console-line" class:date-separator={line.startsWith('---')}>
          {line}
        </div>
      {/each}
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

  .console-toolbar {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    position: sticky;
    top: 0;
    z-index: 4;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.95), rgba(0, 0, 0, 0.78));
    padding-bottom: 0.5rem;
  }

  .console-toolbar-button {
    border: 1px solid rgba(96, 165, 250, 0.35);
    background: rgba(30, 41, 59, 0.9);
    color: #dbeafe;
    border-radius: 4px;
    padding: 0.35rem 0.7rem;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .console-toolbar-button.secondary {
    border-color: rgba(148, 163, 184, 0.35);
    color: #cbd5e1;
  }

  .console-toolbar-button:hover {
    background: rgba(37, 99, 235, 0.35);
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

    .console-toolbar {
      flex-wrap: wrap;
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
