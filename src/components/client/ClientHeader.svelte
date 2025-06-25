<script>
  import { clientState, setActiveTab } from '../../stores/clientStore.js';
  export let tabs = ['play', 'mods', 'settings'];
  export let instance = {};
  export let minecraftServerStatus = 'unknown';
  export let onOpenAppSettings = () => {};

  $: state = $clientState;

  function selectTab(tab) {
    setActiveTab(tab);
  }
</script>

<header class="client-header">
  <div class="header-title-row">
    <h1>Minecraft Client</h1>
    <button 
      class="app-settings-button" 
      on:click={onOpenAppSettings}
      title="App Settings"
      aria-label="Open app settings"
    >
      ⚙️
    </button>
  </div>
  <div class="modern-client-tabs">
    {#each tabs as tab (tab)}
      <button class="modern-tab-button {state.activeTab === tab ? 'active' : ''}" on:click={() => selectTab(tab)}>
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
    padding: 0.5rem 2rem 0 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-bottom: none;
    margin: 0;
  }

  .header-title-row {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    width: 100%;
  }

  h1 {
    margin: 0;
    color: white;
    text-align: center;
  }

  .app-settings-button {
    position: absolute;
    right: 0;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.8);
    border-radius: 6px;
    padding: 0.5rem;
    font-size: 1.1rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
  }

  .app-settings-button:hover {
    background: rgba(255, 255, 255, 0.15);
    color: white;
    border-color: rgba(255, 255, 255, 0.3);
    transform: scale(1.05);
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

  .modern-client-tabs {
    display: flex;
    gap: 0.75rem;
    margin: 1rem 0 0.5rem 0;
    justify-content: center;
    padding: 0.5rem;
    background: rgba(31, 41, 55, 0.4);
    border-radius: 8px;
    border: 1px solid rgba(75, 85, 99, 0.3);
  }

  .modern-tab-button {
    padding: 0.75rem 1.5rem;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: transparent;
    color: #9ca3af;
    margin: 0;
  }

  .modern-tab-button:hover:not(.active) {
    background: rgba(75, 85, 99, 0.3);
    color: #d1d5db;
    transform: translateY(-1px);
  }

  .modern-tab-button.active {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.3);
  }

  .modern-tab-button.active:hover {
    background: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .client-header {
      padding: 0.5rem 1rem 0 1rem;
    }

    .modern-client-tabs {
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem;
      margin: 0.75rem 0 0.5rem 0;
    }

    .modern-tab-button {
      width: 100%;
      justify-content: center;
      padding: 0.75rem 1rem;
    }

    .header-title-row {
      margin-bottom: 0.5rem;
    }

    h1 {
      font-size: 1.5rem;
    }
  }
</style>
