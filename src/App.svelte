<!-- @ts-ignore -->
<script>
  /// <reference path="./electron.d.ts" />
  import { onMount } from 'svelte';
  import { serverState } from './stores/serverState.js';
  import { errorMessage } from './stores/modStore.js';
  import { route, navigate } from './router.js';
  import ServerDashboard from './routes/ServerDashboard.svelte';
  import ModsPage from './routes/ModsPage.svelte';
  import SettingsPage from './routes/SettingsPage.svelte';
  import { setupIpcListeners } from './modules/serverListeners.js';
  import { saveInstances } from './modules/instanceUtils.js';
  
  // Components
  import SetupWizard from './components/setup/SetupWizard.svelte';
  import PlayerList from './components/players/PlayerList.svelte';
  import Backups from './components/Backups.svelte';
  import ClientInterface from './components/client/ClientInterface.svelte';
  import ClientSetupWizard from './components/client/ClientSetupWizard.svelte';
  import StatusManager from './components/common/StatusManager.svelte';
  import ConfirmationDialog from './components/common/ConfirmationDialog.svelte';
  import { showExitConfirmation } from './stores/exitStore.js';
  
  // --- Flow & Tabs ---
  let step = 'loading'; // loading → chooseFolder → chooseVersion → done
  const tabs = ['dashboard', 'players', 'mods', 'backups', 'settings'];
  let path = '';
  let isLoading = true; // Add loading state
  
  // Save instances whenever they change
  $: if (step === 'done' && instances) {
    saveInstances(instances);
  }
  
  // Sidebar and instance management
  let isSidebarOpen = false;
  let instances = [];
  let currentInstance = null;
  let instanceType = 'server'; // 'server' or 'client'
  let showInstanceSelector = false;
  
  // Instance renaming functionality
  let editId = null;
  let editName = '';

  function startRenaming(instance, event) {
    // Prevent triggering the instance selection
    event.stopPropagation();
    
    editId = instance.id;
    editName = instance.name;
  }

  async function confirmRename(event) {
    // Prevent triggering the instance selection
    event.stopPropagation();
    
    const result = await window.electron.invoke('rename-instance', {
      id: editId,
      newName: editName.trim()
    });

    if (result.success) {
      instances = result.instances;

      // If we're renaming the current instance, update it
      if (currentInstance && currentInstance.id === editId) {
        currentInstance = instances.find(i => i.id === editId);
      }

      // Explicitly save instances to ensure persistence
      await saveInstances(instances);
    }
    
    // Reset edit state
    editId = null;
    editName = '';
  }

  function cancelRename(event) {
    // Prevent triggering the instance selection
    event.stopPropagation();
    
    // Just reset the edit state
    editId = null;
    editName = '';
  }
  // Access globally shared serverPath - only for server instances
  $: {
    // When path updates from server components, sync to global store
    // Client instances should not affect the global serverPath
    if (path && instanceType === 'server') {
      window.serverPath.set(path);
    }
  }
  
  
  
  // Save instances to persistent storage
  
  onMount(() => {
    setupIpcListeners();
    
    // 1) First, set up the restoration listeners BEFORE anything else
    window.electron.on('update-server-path', (newPath) => {
      if (newPath) {
        path = newPath;
        
        // Find and select the instance with this path
        const matchingInstance = instances.find(instance => 
          instance.type === 'server' && instance.path === newPath
        );
        
        if (matchingInstance) {
          currentInstance = matchingInstance;
          instanceType = 'server';
          step = 'done';
        }
      }
    });
    
    window.electron.on('restore-server-settings', (settings) => {
      if (settings) {
        // Update the serverState store with restored settings
        serverState.update(state => ({
          ...state,
          port: settings.port || state.port,
          maxRam: settings.maxRam || state.maxRam
        }));
      }
    });

    // Show exit confirmation when main process requests it
    window.electron.on('app-close-request', () => {
      showExitConfirmation.set(true);
    });
    
    // 2) Check for initial instances loaded by main.js
    const checkExistingSetup = async () => {
      try {
        // Finish loading immediately to prevent "Loading" screen
        isLoading = false;
        
        // Try to get pre-loaded instances from main.js first
        let initialInstances = [];
        if (window.getInitialInstances) {
          const store = window.getInitialInstances();
          if (store.loaded && Array.isArray(store.instances)) {
            initialInstances = store.instances;
          }
        }
        
        // If no pre-loaded instances, fetch them (fallback)
        if (initialInstances.length === 0) {
          const instancesResult = await window.electron.invoke('get-instances');
          if (Array.isArray(instancesResult)) {
            initialInstances = instancesResult;
          }
        }
        
        if (initialInstances.length > 0) {
          // Valid instances found
          instances = initialInstances;
          
          // Find the server instance to use as current (if exists)
          currentInstance = instances.find(i => i.type === 'server') || instances[0];
          
          // Set path and type based on current instance
          if (currentInstance) {
            if (currentInstance.type === 'server') {
              path = currentInstance.path;
              instanceType = 'server';
            } else {
              instanceType = 'client';
            }
            
            // Get settings for server instances
            if (currentInstance.type === 'server') {
              const settingsResult = await window.electron.invoke('get-settings');
              if (settingsResult && settingsResult.success) {
                const { settings } = settingsResult;
                
                // Update server state with settings
                if (settings.port || settings.maxRam) {
                  serverState.update(state => ({
                    ...state,
                    port: settings.port || state.port,
                    maxRam: settings.maxRam || state.maxRam
                  }));
                }
              }
            }
            
            // Set step to done to show the main UI
            step = 'done';
          }
        } else {
          // No valid instances, show instance selection screen
          showInstanceSelector = true;
          step = 'loading'; // Keep in loading to avoid showing setup wizard
        }
        
        // Open sidebar by default only if we have instances
        isSidebarOpen = instances.length > 0;
      } catch (error) {
        // If any error occurs, show the instance selector
        showInstanceSelector = true;
        step = 'loading';
        isLoading = false;
      }
    };
    
    checkExistingSetup();
  });
  
  // Handle setup completion
  function handleSetupComplete(event) {
    const newPath = event.detail.path;
    // Update path to the selected folder for the new instance
    path = newPath;
    
    // If no instances exist, this is the initial setup
    if (instances.length === 0) {
      const inst = {
        id: 'default-server',
        name: 'Default Server',
        type: 'server',
        path: newPath
      };
      instances = [inst];
      currentInstance = inst;
    } else if (instanceType === 'server') {
      // Check if a server instance already exists
      const hasServer = instances.some(i => i.type === 'server');
      
      if (hasServer) {
        errorMessage.set('You can only have one server instance. Please delete the existing server instance first.');
        setTimeout(() => errorMessage.set(''), 5000);
        step = 'done';
        return;
      }
      
      // Create a new server instance
      const inst = {
        id: `server-${Date.now()}`,
        name: 'Server',
        type: 'server',
        path: newPath
      };
      instances = [...instances, inst];
      currentInstance = inst;
    }
    
    // Save settings as well to ensure path is remembered
    window.electron.invoke('update-settings', {
      serverPath: newPath
    });
    
    // Persist the updated instances list - this part is crucial
    window.electron.invoke('save-instances', instances)
      .then(result => {
        if (!result || !result.success) {
        } else {
        }
        // Return to main view
        step = 'done';
      })
      .catch(() => {
        // Return to main view anyway
        step = 'done';
      });
  }

  // Toggle sidebar visibility
  function toggleSidebar() {
    isSidebarOpen = !isSidebarOpen;
  }

  // Show instance selection screen
  function showAddInstanceScreen() {
    // Check if we already have both types of instances
    const hasServer = instances.some(i => i.type === 'server');
    const hasClient = instances.some(i => i.type === 'client');
    
    if (hasServer && hasClient) {
      errorMessage.set('You can only have one server instance and one client instance. Please delete an existing instance first.');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    showInstanceSelector = true;
  }

  // Select instance type and proceed to setup
  function selectInstanceType(type) {
    // Check if an instance of this type already exists
    const hasInstanceOfType = instances.some(i => i.type === type);
    
    if (hasInstanceOfType) {
      // Show error notification instead of alert
      errorMessage.set(`You can only have one ${type} instance. Please delete the existing ${type} instance first.`);
      // Clear the error after 5 seconds
      setTimeout(() => {
        errorMessage.set('');
      }, 5000);
      showInstanceSelector = false;
      return;
    }
    
    instanceType = type;
    
    if (type === 'server') {
      // Set step to chooseFolder to show setup wizard
      setTimeout(() => {
        step = 'chooseFolder';
      }, 100);
    } else {
      // Create a new client instance skeleton
      // The actual configuration will be done in the setup wizard
      const newInstance = {
        id: `client-${Date.now()}`,
        name: 'New Client',
        type: 'client',
        path: '',
        serverIp: '',
        serverPort: '8080'  // Management server port, not Minecraft port
      };
      instances = [...instances, newInstance];
      currentInstance = newInstance;
      
      // Set step to chooseFolder to show the client setup wizard
      setTimeout(() => {
        step = 'chooseFolder';
      }, 100);
    }
    showInstanceSelector = false;
  }

  // Handle client setup completion
  function handleClientSetupComplete(event) {
    const { path, serverIp, serverPort } = event.detail;
    
    // Update the current client instance with the configured settings
    if (currentInstance && currentInstance.type === 'client') {
      currentInstance.path = path;
      currentInstance.serverIp = serverIp;
      currentInstance.serverPort = serverPort;
      
      // Update the instances array
      instances = instances.map(inst => 
        inst.id === currentInstance.id ? currentInstance : inst
      );
      
      // Save instances to persistent storage
      window.electron.invoke('save-instances', instances)
        .then(result => {
          if (!result || !result.success) {
          } else {
          }
          step = 'done';
        })
        .catch(() => {
          step = 'done';
        });
    }
  }

  // Switch between instances
  function switchInstance(instance) {
    currentInstance = instance;
    if (instance.type === 'server') {
      path = instance.path;
      instanceType = 'server';
    } else {
      instanceType = 'client';
    }
  }
</script>

<main class="app-container">
  <!-- Sidebar toggle button -->
  <button class="sidebar-toggle" on:click={toggleSidebar}>
    ☰
  </button>
  {#if isSidebarOpen}
    <div class="sidebar-overlay" role="button" tabindex="0" on:click={() => isSidebarOpen = false} on:keydown={(e) => e.key === 'Escape' && (isSidebarOpen = false)}></div>
  {/if}

  <!-- Sidebar -->
  <div class="sidebar" class:open={isSidebarOpen}>
    <h2>Instances</h2>
    <div class="instances-list">      {#each instances as instance}
        <div 
          class="instance-item" 
          class:active={currentInstance && currentInstance.id === instance.id}
          role="button"
          tabindex="0"
          on:click={() => switchInstance(instance)}
          on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && switchInstance(instance)}
        >
          <span class="instance-icon">{instance.type === 'server' ? '🖥️' : '👤'}</span>          {#if editId === instance.id}            <!-- Edit mode -->
            <div class="rename-controls" role="group">              <input 
                type="text" 
                bind:value={editName} 
                class="rename-input"
                on:click|stopPropagation
                on:keydown={e => {
                  e.stopPropagation();
                  if (e.key === 'Enter') confirmRename(e);
                  if (e.key === 'Escape') cancelRename(e);
                }}
              />              <div class="rename-actions">
                <button class="rename-btn confirm" on:click={(e) => {e.stopPropagation(); confirmRename(e);}} title="Save">✓</button>
                <button class="rename-btn cancel" on:click={(e) => {e.stopPropagation(); cancelRename(e);}} title="Cancel">✕</button>
              </div>
            </div>
          {:else}
            <!-- Display mode -->
            <span class="instance-name">{instance.name}</span>
            <button 
              class="edit-btn" 
              on:click={(e) => startRenaming(instance, e)}
              title="Rename"
            >
              ✏️
            </button>
          {/if}
        </div>
      {/each}
    </div>
    <button class="add-instance-btn" on:click={showAddInstanceScreen}>
      <span class="plus-icon">+</span> Add Instance
    </button>
  </div>

  <!-- Instance type selector modal -->  {#if showInstanceSelector}    <div class="modal-overlay" role="dialog" aria-modal="true" tabindex="0" on:click={() => showInstanceSelector = false} on:keydown={(e) => e.key === 'Escape' && (showInstanceSelector = false)}>
      <div class="modal-content welcome-modal" role="document">
        <h1>Welcome to Minecraft Core</h1>
        <p>Choose an instance type to get started:</p>
        <div class="instance-type-container">
          {#if instances.some(i => i.type === 'server')}
            <div class="instance-type-card disabled">
              <div class="instance-type-icon">🖥️</div>
              <h3>Server Manager</h3>
              <p>Create and manage Minecraft servers</p>
              <div class="disabled-notice">You already have a server instance</div>
            </div>          {:else}
            <div class="instance-type-card" role="button" tabindex="0" on:click={() => {
              instanceType = 'server';
              showInstanceSelector = false;
              step = 'chooseFolder';
            }} on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && (() => {
              instanceType = 'server';
              showInstanceSelector = false;
              step = 'chooseFolder';
            })()}>
              <div class="instance-type-icon">🖥️</div>
              <h3>Server Manager</h3>
              <p>Create and manage Minecraft servers</p>
            </div>
          {/if}
          
          {#if instances.some(i => i.type === 'client')}
            <div class="instance-type-card disabled">
              <div class="instance-type-icon">👤</div>
              <h3>Client Interface</h3>
              <p>Connect to Minecraft servers as a player</p>
              <div class="disabled-notice">You already have a client instance</div>
            </div>          {:else}
            <div class="instance-type-card" role="button" tabindex="0" on:click={() => selectInstanceType('client')} on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectInstanceType('client')}>
              <div class="instance-type-icon">👤</div>
              <h3>Client Interface</h3>
              <p>Connect to Minecraft servers as a player</p>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <div class="main-content">
    {#if step === 'chooseFolder'}
      <div class="setup-container">
        {#if instanceType === 'server'}
          <SetupWizard on:setup-complete={(event) => {
            handleSetupComplete(event);
          }} />
        {:else if instanceType === 'client'}
          <ClientSetupWizard on:setup-complete={(event) => {
            handleClientSetupComplete(event);
          }} />
        {/if}
      </div>
    {:else if isLoading}
      <!-- Loading screen -->
      <div class="loading-screen">
        <p>Loading your Minecraft server...</p>
      </div>
    {:else if step === 'done'}
      {#if instanceType === 'server'}
        <header class="app-header">
          <h1>Minecraft Core</h1>
          <nav class="tabs-container">
            {#each tabs as t}
              <button
                class="tab-button"
                class:active={$route === '/' + t}
                on:click={() => navigate('/' + t)}
              >
                {#if t === 'dashboard'}
                  <span class="tab-icon">📊</span>
                {:else if t === 'players'}
                  <span class="tab-icon">👥</span>
                {:else if t === 'mods'}
                  <span class="tab-icon">🧩</span>
                {:else if t === 'backups'}
                  <span class="tab-icon">💾</span>
                {:else if t === 'settings'}
                  <span class="tab-icon">⚙️</span>
                {/if}
                <span class="tab-text">{t[0].toUpperCase() + t.slice(1)}</span>
              </button>
            {/each}
          </nav>
        </header>
        
        <!-- Tab content container -->
        <div class="tab-content">
          {#if $route === '/dashboard'}
            <ServerDashboard serverPath={path} />
          {:else if $route === '/players'}
            <div class="content-panel">
              <PlayerList serverPath={path} />
            </div>
          {:else if $route === '/mods'}
            <ModsPage serverPath={path} />
          {:else if $route === '/backups'}
            <div class="content-panel">
              <Backups serverPath={path} />
            </div>          {:else if $route === '/settings'}
            <SettingsPage 
              serverPath={path} 
              currentInstance={currentInstance} 
              on:deleted={(e) => {
                // Remove the instance from the list
                instances = instances.filter(i => i.id !== e.detail.id);
                
                // Switch to a different instance if available, otherwise show selection screen
                if (instances.length > 0) {
                  currentInstance = instances[0];
                  if (currentInstance.type === 'server') {
                    path = currentInstance.path;
                    instanceType = 'server';
                  } else {
                    instanceType = 'client';
                  }
                } else {
                  showInstanceSelector = true;
                }
              }}
            />
          {/if}
        </div>
      {:else if instanceType === 'client'}
        <ClientInterface 
          instance={currentInstance} 
          on:deleted={(e) => {
            // Remove the instance from the list
            instances = instances.filter(i => i.id !== e.detail.id);
            
            // Switch to a different instance if available, otherwise show selection screen
            if (instances.length > 0) {
              currentInstance = instances[0];
              if (currentInstance.type === 'server') {
                path = currentInstance.path;
                instanceType = 'server';
              } else {
                instanceType = 'client';
              }
            } else {
              showInstanceSelector = true;
            }
          }}
        />
      {/if}
    {/if}
  </div>
  <ConfirmationDialog
    bind:visible={$showExitConfirmation}
    title="Minecraft Server Running"
    message="The Minecraft server is still running. Stop the server and quit?"
    confirmText="Quit"
    cancelText="Cancel"
    confirmType="danger"
    backdropClosable={false}
    on:confirm={() => {
      window.electron.invoke('app-close-response', true);
      showExitConfirmation.set(false);
    }}
    on:cancel={() => {
      window.electron.invoke('app-close-response', false);
      showExitConfirmation.set(false);
    }}
  />
  <StatusManager />
</main>

<style>
  /* Main layout */
  .app-container {
    display: flex;
    width: 100%;
    min-height: 100vh;
    position: relative;
    background-color: #1a1a1a;
    color: #ffffff;
  }

  .main-content {
    flex: 1;
    padding: 0;
    margin-left: 0;
  }

  /* Setup container */
  .setup-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
    text-align: center;
  }

  .setup-container :global(h1),
  .setup-container :global(h2) {
    color: white;
    margin-bottom: 2rem;
  }

  .setup-container :global(button) {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 2rem;
    font-size: 1rem;
    cursor: pointer;
    margin: 1rem 0;
  }

  .setup-container :global(select) {
    padding: 0.75rem;
    margin: 0.5rem 0 1.5rem;
    width: 100%;
    max-width: 400px;
    font-size: 1rem;
    background-color: #2d3748;
    color: white;
    border: 1px solid #4b5563;
    border-radius: 4px;
  }

  .setup-container :global(label) {
    display: block;
    margin: 1rem 0;
    font-size: 1rem;
  }

  /* App header and tabs */
  .app-header {
    background-color: #1f2937;
    padding: 1rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-bottom: 1px solid #374151;
  }

  h1 {
    margin-bottom: 1.5rem;
    color: white;
    text-align: center;
  }

  .tabs-container {
    display: flex;
    width: 100%;
    background-color: #2d3748;
    border-radius: 8px;
    padding: 0.5rem;
    justify-content: space-between;
    margin-bottom: 0;
  }

  .tab-button {
    flex: 1;
    padding: 0.75rem 1rem;
    border: none;
    background: transparent;
    color: #a0aec0;
    cursor: pointer;
    border-radius: 6px;
    margin: 0 0.25rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    transition: all 0.2s ease;
  }

  .tab-button:hover {
    color: white;
    background-color: #374151;
  }

  .tab-button.active {
    background: #3b82f6;
    color: white;
  }

  .tab-icon {
    font-size: 1.25rem;
    margin-bottom: 0.25rem;
  }
  .tab-text {
    font-weight: 500;
  }

  /* Tab content */
  .tab-content {
    padding: 2rem;
  }

  .content-panel {
    max-width: 1200px;
    margin: 0 auto;
  }

  /* Sidebar styles */
  .sidebar {
    position: fixed;
    left: -250px;
    top: 0;
    width: 250px;
    height: 100%;
    background-color: #1f2937;
    color: white;
    transition: left 0.3s ease;
    z-index: 10;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .sidebar.open {
    left: 0;
  }

  .sidebar-toggle {
    position: fixed;
    top: 10px;
    left: 10px;
    z-index: 20;
    background-color: #1f2937;
    color: white;
    border: none;
    border-radius: 4px;
    width: 40px;
    height: 40px;
    font-size: 1.5rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .sidebar-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.3);
    z-index: 5;
  }

  .instances-list {
    flex: 1;
    margin-bottom: 1rem;
  }

  .instance-item {
    padding: 0.75rem;
    border-radius: 4px;
    margin-bottom: 0.5rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    background-color: #374151;
    position: relative;
  }

  .instance-item.active {
    background-color: #3b82f6;
  }

  .instance-icon {
    margin-right: 0.5rem;
    font-size: 1.2rem;
    flex-shrink: 0;
  }
  
  .instance-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .rename-controls {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    width: calc(100% - 2.5rem);
  }

  .rename-input {
    flex: 1;
    padding: 0.35rem;
    border: 1px solid #4b5563;
    border-radius: 4px;
    background-color: #2d3748;
    color: white;
    font-size: 0.9rem;
    min-width: 0;
    width: 100%;
  }

  .rename-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .rename-btn {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
  }

  .rename-btn.confirm {
    background-color: #10b981;
  }

  .rename-btn.cancel {
    background-color: #ef4444;
  }

  .edit-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    margin-left: auto;
    color: rgba(255, 255, 255, 0.6);
    opacity: 0;
    transition: opacity 0.2s;
    flex-shrink: 0;
  }
  
  .instance-item:hover .edit-btn {
    opacity: 1;
  }

  .edit-btn:hover {
    color: white;
  }

  .add-instance-btn {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
  }

  .plus-icon {
    margin-right: 0.5rem;
    font-size: 1.2rem;
  }

  /* Modal styles */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
  }

  .modal-content {
    background-color: #2d3748;
    color: white;
    border-radius: 8px;
    padding: 2rem;
    width: 80%;
    max-width: 800px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
  }

  .welcome-modal {
    text-align: center;
  }
  
  .welcome-modal h1 {
    color: #3b82f6;
    margin-bottom: 1rem;
  }
  
  .welcome-modal p {
    margin-bottom: 2rem;
    font-size: 1.1rem;
  }

  .instance-type-container {
    display: flex;
    justify-content: space-between;
    margin: 2rem 0;
  }

  .instance-type-card {
    flex: 1;
    margin: 0 1rem;
    padding: 2rem;
    border-radius: 8px;
    border: 2px solid #4b5563;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s ease;
    background-color: #374151;
    position: relative;
  }

  .instance-type-card:hover:not(.disabled) {
    border-color: #3b82f6;
    transform: translateY(-5px);
  }
  
  .instance-type-card.disabled {
    opacity: 0.6;
    cursor: not-allowed;
    border-color: #6b7280;
  }
  
  .disabled-notice {
    position: absolute;
    bottom: 1rem;
    left: 0;
    right: 0;
    text-align: center;
    color: #ef4444;
    font-size: 0.9rem;
    font-weight: bold;
  }
  .instance-type-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
  }

  /* Loading screen */
  .loading-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
  }

  /* Ensure client components use consistent styling */
  :global(.client-container) {
    background-color: #1a1a1a;
    color: white;
    padding: 0;
  }
  
  :global(.client-container h2),
  :global(.client-container h3) {
    color: white;
  }
  
  :global(.client-container .connection-form),
  :global(.client-container .server-list) {
    background-color: #2d3748;
    border: 1px solid #4b5563;
  }
  
  :global(.client-container .empty-state) {
    background-color: #374151;
    color: #a0aec0;
  }
  
  :global(.client-container th) {
    background-color: #1f2937;
  }
  
  :global(.client-container td) {
    border-bottom: 1px solid #4b5563;
  }
</style>
