<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount, afterUpdate } from 'svelte';
  import { serverState, addServerLog } from '../../stores/serverState.js';
  
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
  $: itemHeight = 21; // Approximate height of each log line in pixels
  $: topSpacerHeight = startIndex * itemHeight;
  $: bottomSpacerHeight = Math.max(0, (totalLogs - endIndex) * itemHeight);
  
  function onConsoleScroll() {
    // If user scrolls up, disable autoScroll
    autoScroll = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 5;
    
    // Update virtual scrolling indices based on scroll position
    if (!autoScroll) {
      const scrollTop = consoleEl.scrollTop;
      startIndex = Math.floor(scrollTop / itemHeight);
      startIndex = Math.max(0, Math.min(startIndex, Math.max(0, totalLogs - visibleCount)));
    }
  }
  
  afterUpdate(() => {
    if (autoScroll && consoleEl) {
      // When auto-scrolling, show the most recent logs
      startIndex = Math.max(0, totalLogs - visibleCount);
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  });
  
  async function sendCommand() {
    if (!command.trim()) return;
    const ok = await window.electron.invoke('send-command', { command });
    addServerLog(ok ? `[SENT] ${command}` : '[ERR] Failed to send command');
    command = '';
  }

  // Handle server log events
  const logHandler = (line) => {
    addServerLog(line);
  };

  onMount(() => {
    // Remove any existing listeners to prevent duplicates
    window.electron.removeAllListeners('server-log');

    // Set up event listener for server logs
    window.electron.on('server-log', logHandler);

    return () => {
      // Clean up event listeners when component is unmounted
      window.electron.removeListener('server-log', logHandler);
    };
  });
</script>

<!-- Fixed console view with improved styling -->
<div class="console-frame-container" style="width: 1200px !important; max-width: none !important;">
  <!-- Static black background -->
  <div class="console-background"></div>
  
  <!-- Scrollable console content with virtual scrolling -->
  <div class="scrollable-console" bind:this={consoleEl} on:scroll={onConsoleScroll}>
    <!-- Top spacer -->
    {#if topSpacerHeight > 0}
      <div class="virtual-spacer" style="height: {topSpacerHeight}px;"></div>
    {/if}
      <!-- Visible log lines -->
    {#if visibleLogs.length === 0}
      <!-- Add empty line to maintain height when no logs -->
      <div class="console-line console-empty">Server console ready.</div>
    {:else}
      {#each visibleLogs as line}
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
    max-width: 1600px !important;
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
