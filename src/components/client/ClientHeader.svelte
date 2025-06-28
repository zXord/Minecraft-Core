<script>
  import { clientState, setActiveTab } from '../../stores/clientStore.js';
  export let tabs = ['play', 'mods', 'settings'];
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
    padding: 0.5rem 0 0 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-bottom: none;
    margin: 0;
    min-height: 120px; /* Same as server header */
    width: 100%;
  }

  .header-title-row {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    width: 100%;
    padding: 0 2rem;
    box-sizing: border-box;
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



  .modern-client-tabs {
    /* Use universal tab container with slight customization */
    display: flex;
    gap: 0.5rem; /* Same as server tabs */
    margin-top: 1rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .modern-tab-button {
    /* Match server tab styling exactly */
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.8);
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-sizing: border-box;
    flex-shrink: 0;
  }

  .modern-tab-button:hover:not(.active) {
    background: rgba(255, 255, 255, 0.15);
    color: white;
    border-color: rgba(255, 255, 255, 0.3);
    transform: translateY(-1px);
  }

  .modern-tab-button.active {
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.4);
  }

  .modern-tab-button.active:hover {
    background: rgba(59, 130, 246, 0.3);
    border-color: rgba(59, 130, 246, 0.6);
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .header-title-row {
      padding: 0 1rem;
    }

    .modern-client-tabs {
    flex-direction: column;
    gap: 0.5rem;
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
