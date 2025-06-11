<script>
  import { clientState, setActiveTab } from '../../stores/clientStore.js';
  export let tabs = ['play', 'mods', 'settings'];
  export let instance = {};
  export let minecraftServerStatus = 'unknown';

  $: state = $clientState;

  function selectTab(tab) {
    setActiveTab(tab);
  }
</script>

<header class="client-header">
  <h1>Minecraft Client</h1>
  <div class="connection-status">
    <div class="status-section">
      <span class="status-section-label">Management Server:</span>
      {#if state.connectionStatus === 'connected'}
        <div class="status-indicator connected" title="Connected to management server">
          <span class="status-dot"></span>
          <span class="status-text">Connected</span>
        </div>
      {:else if state.connectionStatus === 'connecting'}
        <div class="status-indicator connecting" title="Connecting to management server">
          <span class="status-dot"></span>
          <span class="status-text">Connecting...</span>
        </div>
      {:else}
        <div class="status-indicator disconnected" title="Not connected to management server">
          <span class="status-dot"></span>
          <span class="status-text">Disconnected</span>
        </div>
      {/if}
    </div>

    {#if state.connectionStatus === 'connected'}
      <div class="server-details">
        <span class="server-address">
          <span class="address-label">Management Server:</span>
          {instance?.serverIp || 'Unknown'}:{instance?.serverPort || '8080'}
        </span>
        <div class="status-section">
          <span class="status-section-label">Minecraft Server:</span>
          {#if minecraftServerStatus === 'running'}
            <div class="status-indicator server-running" title="Minecraft server is running">
              <span class="status-dot"></span>
              <span class="status-text">Running</span>
            </div>
          {:else if minecraftServerStatus === 'stopped'}
            <div class="status-indicator server-stopped" title="Minecraft server is stopped">
              <span class="status-dot"></span>
              <span class="status-text">Stopped</span>
            </div>
          {:else}
            <div class="status-indicator server-unknown" title="Minecraft server status unknown">
              <span class="status-dot"></span>
              <span class="status-text">Status Unknown</span>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
  <div class="client-tabs">
    {#each tabs as tab (tab)}
      <button class="tab-button {state.activeTab === tab ? 'active' : ''}" on:click={() => selectTab(tab)}>
        {#if tab === 'play'}
          🎮 Play
        {:else if tab === 'mods'}
          🧩 Mods
        {:else if tab === 'settings'}
          ⚙️ Settings
        {:else}
          {tab[0].toUpperCase() + tab.slice(1)}
        {/if}
      </button>
    {/each}
  </div>
</header>

<style>
  .client-header {
    background-color: #1f2937;
    padding: 1rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-bottom: 1px solid #374151;
  }

  .connection-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 1rem;
    gap: 0.5rem;
  }

  .status-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 0.5rem;
    gap: 0.5rem;
  }

  .status-section-label {
    color: #9ca3af;
    font-size: 0.9rem;
  }

  .address-label {
    color: #9ca3af;
    font-size: 0.9rem;
    margin-right: 0.5rem;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 2rem;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .connected {
    background-color: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }

  .connected .status-dot {
    background-color: #10b981;
  }

  .connecting {
    background-color: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
  }

  .connecting .status-dot {
    background-color: #f59e0b;
    animation: pulse 1.5s infinite;
  }

  .disconnected {
    background-color: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }

  .disconnected .status-dot {
    background-color: #ef4444;
  }

  .server-running {
    background-color: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }

  .server-running .status-dot {
    background-color: #10b981;
  }

  .server-stopped {
    background-color: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }

  .server-stopped .status-dot {
    background-color: #ef4444;
  }

  .server-unknown {
    background-color: rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }

  .server-unknown .status-dot {
    background-color: #9ca3af;
  }

  .server-details {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 0.5rem;
    gap: 0.5rem;
  }

  .server-address {
    color: #e2e8f0;
    font-family: monospace;
    background-color: #374151;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
  }

  .client-tabs {
    display: flex;
    margin-top: 1rem;
    gap: 1rem;
  }

  .tab-button {
    background: none;
    border: none;
    color: #9ca3af;
    padding: 0.5rem 1rem;
    font-size: 1rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }

  .tab-button:hover {
    color: white;
  }

  .tab-button.active {
    color: white;
    border-bottom: 2px solid #646cff;
  }
</style>
