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
  import AppSettingsModal from './components/common/AppSettingsModal.svelte';
  import UpdateNotification from './components/common/UpdateNotification.svelte';
  import { Toaster } from 'svelte-sonner';
  import { showExitConfirmation } from './stores/exitStore.js';
  
  // --- Flow & Tabs ---
  let step = 'loading'; // loading → chooseFolder → chooseVersion → done
  const tabs = ['dashboard', 'players', 'mods', 'backups', 'settings'];
  let path = '';
  let isLoading = true; // Add loading state
  
  // Sidebar and instance management
  let isSidebarOpen = false;
  let instances = [];
  let currentInstance = null;
  let instanceType = 'server'; // 'server' or 'client'
  let showInstanceSelector = false;
  
  // Instance renaming functionality
  let editId = null;
  let editName = '';

  // App settings modal state
  let showAppSettings = false;

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
      saveInstancesIfNeeded();
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
  
  // Save instances to persistent storage
  
  onMount(() => {
    setupIpcListeners();
    
    // Start periodic update checks
    setTimeout(() => {
      window.electron.invoke('start-periodic-checks');
    }, 2000); // Start checking 2 seconds after app loads
    

    
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
          // No valid instances found - but don't show instance selector automatically
          // User can manually open it via the sidebar button
          step = 'done'; // Show the main UI with empty state
        }
        
        // Don't open sidebar automatically - let user open it manually if needed
        // isSidebarOpen = instances.length > 0;
      } catch (error) {
        // If any error occurs, don't show the instance selector automatically
        step = 'done';
        isLoading = false;
      }
    };
    
    checkExistingSetup();
    
    // Update content area width based on current window size
    updateContentAreaWidth();
    
    // Listen for window resize events
    window.addEventListener('resize', updateContentAreaWidth);
    

    
    // Cleanup on component destroy
    return () => {
      window.removeEventListener('resize', updateContentAreaWidth);
    };
  });
  
  // Helper functions to handle reactive behavior manually
  function saveInstancesIfNeeded() {
    if (step === 'done' && instances) {
      saveInstances(instances);
    }
  }
  
  function updateServerPath() {
    if (path && instanceType === 'server' && window.serverPath) {
      window.serverPath.set(path);
    }
  }
  
  // Handle setup completion
  function handleSetupComplete(event) {
    const newPath = event.detail.path;
    // Update path to the selected folder for the new instance
    path = newPath;
    updateServerPath();
    
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
      saveInstancesIfNeeded();
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
      saveInstancesIfNeeded();
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
      updateServerPath();
    } else {
      instanceType = 'client';
    }
  }

  // Update CSS variable for content area width based on window size
  function updateContentAreaWidth() {
    if (typeof window !== 'undefined') {
      const windowWidth = window.innerWidth;
      let contentWidth;

      if (windowWidth <= 1000) {
        contentWidth = Math.max(800, windowWidth - 200); // Small: minimum 800px with 200px buffer
      } else if (windowWidth <= 1200) {
        contentWidth = Math.max(900, windowWidth - 200); // Medium: minimum 900px
      } else {
        contentWidth = Math.max(1000, windowWidth - 200); // Large: minimum 1000px
      }

      // Update the CSS variable
      document.documentElement.style.setProperty('--content-area-width', `${contentWidth}px`);
      
      // Also ensure no horizontal scrolling on body/html
      document.documentElement.style.overflowX = 'hidden';
      document.body.style.overflowX = 'hidden';
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
    <h2>Instances</h2>    <div class="instances-list">      {#each instances as instance (instance.id)}
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
      </div>    {:else if step === 'done'}
      {#if currentInstance === null || instances.length === 0}
        <!-- Empty state - show welcome message -->
        <div class="empty-state">
          <div class="empty-state-content">
            <h1>Welcome to Minecraft Core</h1>
            <p>You haven't created any instances yet. Get started by creating your first server or client instance.</p>
            <button class="create-instance-btn" on:click={showAddInstanceScreen}>
              <span class="plus-icon">+</span> Create Your First Instance
            </button>
          </div>
        </div>
      {:else if instanceType === 'server'}
        <header class="server-header">
          <div class="header-title-row">
            <h1>Minecraft Core</h1>
            <button 
              class="app-settings-button" 
              on:click={() => showAppSettings = true}
              title="App Settings"
              aria-label="Open app settings"
            >
              ⚙️
            </button>
          </div>
          <div class="server-tabs">
            {#each tabs as t (t)}
              <button
                class="server-tab-button {$route === '/' + t ? 'active' : ''}"
                on:click={() => navigate('/' + t)}
              >
                {#if t === 'dashboard'}
                  📊 Dashboard
                {:else if t === 'players'}
                  👥 Players
                {:else if t === 'mods'}
                  🧩 Mods
                {:else if t === 'backups'}
                  💾 Backups
                {:else if t === 'settings'}
                  ⚙️ Settings
                {/if}
              </button>
            {/each}
          </div>
        </header>
        
        <!-- Tab content container -->
        <div class="tab-content">
          {#if $route === '/dashboard'}
            <div class="content-panel">
              <ServerDashboard serverPath={path} />
            </div>
          {:else if $route === '/players'}
            <div class="content-panel">
              <PlayerList serverPath={path} />
            </div>
          {:else if $route === '/mods'}
            <div class="content-panel">
              <ModsPage serverPath={path} />
            </div>
          {:else if $route === '/backups'}
            <div class="content-panel">
              <Backups serverPath={path} />
            </div>
          {:else if $route === '/settings'}
            <div class="content-panel">
              <SettingsPage
                serverPath={path} 
                currentInstance={currentInstance} 
                on:deleted={(e) => {
                  // Remove the instance from the list
                  instances = instances.filter(i => i.id !== e.detail.id);
                  
                  // Switch to a different instance if available, otherwise show empty state
                  if (instances.length > 0) {
                    currentInstance = instances[0];
                    if (currentInstance.type === 'server') {
                      path = currentInstance.path;
                      instanceType = 'server';
                    } else {
                      instanceType = 'client';
                    }
                  } else {
                    // Show empty state instead of forcing instance selector
                    currentInstance = null;
                    step = 'done';
                  }
                }}
              />
            </div>
          {/if}
        </div>
      {:else if instanceType === 'client'}        <ClientInterface 
          instance={currentInstance} 
          onOpenAppSettings={() => showAppSettings = true}
          on:deleted={(e) => {
            // Remove the instance from the list
            instances = instances.filter(i => i.id !== e.detail.id);
            
            // Switch to a different instance if available, otherwise show empty state
            if (instances.length > 0) {
              currentInstance = instances[0];
              if (currentInstance.type === 'server') {
                path = currentInstance.path;
                instanceType = 'server';
              } else {
                instanceType = 'client';
              }
            } else {
              // Show empty state instead of forcing instance selector
              currentInstance = null;
              step = 'done';
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
  <AppSettingsModal 
    bind:visible={showAppSettings}
    on:close={() => showAppSettings = false}
  />
  <StatusManager />
  <UpdateNotification />
  <Toaster richColors theme="dark" />
</main>

<style>
  /* Override global app.css styles that interfere with our layout */
  :global(body) {
    display: block !important;
    place-items: unset !important;
  }
  
  :global(#app) {
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    text-align: left !important;
    width: 100% !important;
    height: 100vh !important;
  }

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
    box-sizing: border-box; /* Match other containers */
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    position: relative;
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

  /* Server header design - matching client header style */
  .server-header {
    background-color: #1f2937;
    padding: 0.5rem 2rem 0 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-bottom: none;
    margin: 0;
    min-height: 120px; /* Same as client header */
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

  /* Server tabs - horizontal layout like client */
  .server-tabs {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .server-tab-button {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.8);
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .server-tab-button:hover:not(.active) {
    background: rgba(255, 255, 255, 0.15);
    color: white;
    border-color: rgba(255, 255, 255, 0.3);
    transform: translateY(-1px);
  }

  .server-tab-button.active {
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.4);
  }

  .server-tab-button.active:hover {
    background: rgba(59, 130, 246, 0.3);
    border-color: rgba(59, 130, 246, 0.6);
  }



  /* Tab content - FIXED HORIZONTAL SIZING FOR ALL TABS */
  .tab-content {
    padding: 0.25rem 2rem 2rem 2rem; /* Reduced top padding from 1rem to 0.25rem */
    position: relative;
    box-sizing: border-box;
    min-height: auto;
  }

  .content-panel {
    /* RESPONSIVE WIDTH FOR ALL TAB CONTENT */
    width: var(--content-area-width) !important;
    margin: 0 auto;
    box-sizing: border-box !important;
    padding: 0 !important; /* Consistent padding */
  }

  /* Force consistent dimensions for server tab content only - don't interfere with client */
  .content-panel > :global(.dashboard-panel),
  .content-panel > :global(.mod-manager),
  .content-panel > :global(.backups-tab),
  .content-panel > :global(.players-page-container),
  .content-panel > :global(.settings-page) {
    /* Prevent overflow while maintaining responsiveness */
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    padding: 1rem;
    overflow-x: hidden; /* Prevent horizontal overflow */
  }

  /* Override any component-specific size rules - SAFER APPROACH */
  :global(.backups-tab),
  :global(.mod-manager),
  :global(.dashboard-panel),
  :global(.players-page-container) {
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    padding: 1rem;
    overflow-x: hidden; /* Prevent horizontal overflow */
  }

  /* Sidebar styles */
  .sidebar {
    position: fixed;
    left: -250px;
    top: 0;
    width: 250px;
    height: 100vh;
    background-color: #1f2937;
    color: white;
    transition: left 0.3s ease;
    z-index: 10;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Ensure no visual leakage when closed */
    border-right: none;
    box-shadow: none;
    /* Completely hide when closed */
    visibility: hidden;
    box-sizing: border-box;
  }

  .sidebar.open {
    left: 0;
    box-shadow: 2px 0 10px rgba(0, 0, 0, 0.3);
    visibility: visible;
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
    overflow-y: auto;
    min-height: 0;
    max-height: calc(100vh - 180px);
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
    flex-shrink: 0;
    margin-top: auto;
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

  /* Empty state */
  .empty-state {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1;
    width: auto;
    height: auto;
  }

  .empty-state-content {
    text-align: center;
    max-width: 600px;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .empty-state-content h1 {
    color: #3b82f6;
    margin-bottom: 1rem;
    font-size: 2.5rem;
  }

  .empty-state-content p {
    color: #d1d5db;
    margin-bottom: 2rem;
    font-size: 1.2rem;
    line-height: 1.6;
  }

  .create-instance-btn {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 8px;
    padding: 1rem 2rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 1.1rem;
    transition: all 0.2s ease;
    gap: 0.5rem;
  }

  .create-instance-btn:hover {
    background-color: #2563eb;
    transform: translateY(-2px);
  }

  .create-instance-btn .plus-icon {
    font-size: 1.3rem;
  }

  /* Minimal client styling - let component handle its own layout */
  :global(.client-interface) {
    background-color: #1a1a1a;
    color: white;
  }
  
  :global(.client-interface h2),
  :global(.client-interface h3) {
    color: white;
  }
  
  :global(.client-interface .connection-form),
  :global(.client-interface .server-list) {
    background-color: #2d3748;
    border: 1px solid #4b5563;
  }
  
  :global(.client-interface .empty-state) {
    background-color: #374151;
    color: #a0aec0;
  }
  
  :global(.client-interface th) {
    background-color: #1f2937;
  }
  
  :global(.client-interface td) {
    border-bottom: 1px solid #4b5563;
  }
</style>
