<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount, afterUpdate } from 'svelte';
  import { serverState, addServerLog } from '../../stores/serverState.js';
  import logger from '../../utils/logger.js';
  
  // Local state
  let consoleEl;
  let autoScroll = true;
  let command = '';
    // Access the logs from the store
  $: serverLogs = $serverState.logs;
  
  // Virtual scrolling variables
  let startIndex = 0;
  let visibleCount = 50; // Show 50 items at a time
  $: totalLogs = serverLogs.length;
  $: endIndex = Math.min(startIndex + visibleCount, totalLogs);
  $: visibleLogs = serverLogs.slice(startIndex, endIndex);
  
  // Calculate the height for spacers
  const itemHeight = 21; // Approximate height of each log line in pixels
  $: topSpacerHeight = startIndex * itemHeight;
  $: bottomSpacerHeight = Math.max(0, (totalLogs - endIndex) * itemHeight);
  
  function onConsoleScroll() {
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
    
    const wasAutoScroll = autoScroll;
    
    // If user scrolls up, disable autoScroll
    autoScroll = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 5;
    
    // Update virtual scrolling indices based on scroll position
    if (!autoScroll) {
      const scrollTop = consoleEl.scrollTop;
      const newStartIndex = Math.floor(scrollTop / itemHeight);
      startIndex = Math.max(0, Math.min(newStartIndex, Math.max(0, totalLogs - visibleCount)));
      
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
    }
  }
  
  afterUpdate(() => {
    if (autoScroll && consoleEl) {
      // When auto-scrolling, show the most recent logs
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
      consoleEl.scrollTop = consoleEl.scrollHeight;
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

  // Handle server log events
  const logHandler = (line) => {
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
    
    addServerLog(line);
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
      <!-- Visible log lines -->
    {#if visibleLogs.length === 0}      <!-- Add empty line to maintain height when no logs -->
      <div class="console-line console-empty">Server console ready.</div>
    {:else}
      {#each visibleLogs as line, index (startIndex + index)}
        <div class="console-line">{line}</div>
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
  }
  
  /* Style for empty console */
  .console-empty {
    color: #888;
    font-style: italic;
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
