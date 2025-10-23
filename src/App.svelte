<!-- @ts-ignore -->
<script>
  /// <reference path="./electron.d.ts" />
  import { onMount, onDestroy, setContext } from "svelte";
  import { serverState } from "./stores/serverState.js";
  import { errorMessage } from "./stores/modStore.js";
  import { route, navigate } from "./router.js";
  import { setupIpcListeners } from "./modules/serverListeners.js";

  // Dynamic route imports - components loaded on demand
  let ServerDashboard;
  let ModsPage;
  let SettingsPage;

  // Cache for loaded route components to prevent re-fetching
  async function loadRoute(routeName) {
    switch(routeName) {
      case 'dashboard':
        if (!ServerDashboard) {
          const module = await import('./routes/ServerDashboard.svelte');
          ServerDashboard = module.default;
        }
        return ServerDashboard;
      case 'mods':
        if (!ModsPage) {
          const module = await import('./routes/ModsPage.svelte');
          ModsPage = module.default;
        }
        return ModsPage;
      case 'settings':
        if (!SettingsPage) {
          const module = await import('./routes/SettingsPage.svelte');
          SettingsPage = module.default;
        }
        return SettingsPage;
    }
  }
  import { saveInstances } from "./modules/instanceUtils.js";
  import logger from "./utils/logger.js";

  // Components
  import SetupWizard from "./components/setup/SetupWizard.svelte";
  import PlayerList from "./components/players/PlayerList.svelte";
  import Backups from "./components/Backups.svelte";
  import ClientInterface from "./components/client/ClientInterface.svelte";
  import ClientSetupWizard from "./components/client/ClientSetupWizard.svelte";
  import StatusManager from "./components/common/StatusManager.svelte";
  import ConfirmationDialog from "./components/common/ConfirmationDialog.svelte";
  import AppSettingsModal from "./components/common/AppSettingsModal.svelte";
  import UpdateNotification from "./components/common/UpdateNotification.svelte";
  import { Toaster } from "svelte-sonner";
  import { showExitConfirmation } from "./stores/exitStore.js";
  import ModAvailabilityNotifications from "./components/common/ModAvailabilityNotifications.svelte";
  import { getUpdateCount } from "./stores/modStore.js";
  const updateCountStore = getUpdateCount();
  import { checkForUpdates, loadServerConfig, loadMods, loadContent, checkDisabledModUpdates } from "./utils/mods/modAPI.js";
  let updateIntervalId = null;

  // --- Flow & Tabs ---
  let step = "loading"; // loading → chooseFolder → chooseVersion → done
  const tabs = ["dashboard", "players", "mods", "backups", "settings"];
  let path = "";
  let isLoading = true; // Add loading state

  // Sidebar and instance management
  let isSidebarOpen = false;
  let instances = [];
  let currentInstance = null;
  let instanceType = "server"; // 'server' or 'client'
  let showInstanceSelector = false;

  // Instance renaming functionality
  let editId = null;
  let editName = "";

  // App settings modal state
  let showAppSettings = false;

  // Error boundary state
  let hasError = false;
  let errorInfo = null; // Used for storing error details for potential debugging display

  // Session tracking
  const sessionId = Date.now().toString();

  // Create error boundary handler
  function handleError(error, componentInfo) {
    hasError = true;
    errorInfo = { error, componentInfo };

    logger.error(`Error boundary activated: ${error.message}`, {
      category: "ui",
      data: {
        component: "App",
        errorType: error.constructor.name,
        componentInfo,
        stack: error.stack,
      },
    });

    // Log global state change for error boundary activation
    logger.info("Global state change: error boundary activated", {
      category: "core",
      data: {
        component: "App",
        stateChange: "errorBoundary",
        previousValue: false,
        newValue: true,
        trigger: "component-error",
      },
    });

    return true; // Indicates error was handled
  }

  // Set error boundary handler in context for child components
  setContext("errorBoundary", handleError);

  function startRenaming(instance, event) {
    // Prevent triggering the instance selection
    event.stopPropagation();

    logger.debug("Instance renaming started", {
      category: "ui",
      data: {
        component: "App",
        action: "startRenaming",
        instanceId: instance.id,
        currentName: instance.name,
        instanceType: instance.type,
      },
    });

    editId = instance.id;
    editName = instance.name;
  }

  async function confirmRename(event) {
    // Prevent triggering the instance selection
    event.stopPropagation();

    logger.info("Instance rename confirmed", {
      category: "ui",
      data: {
        component: "App",
        action: "confirmRename",
        instanceId: editId,
        newName: editName.trim(),
        oldName: instances.find((i) => i.id === editId)?.name,
      },
    });

    try {
      const result = await window.electron.invoke("rename-instance", {
        id: editId,
        newName: editName.trim(),
      });

      if (result.success) {
        logger.info("Instance renamed successfully", {
          category: "core",
          data: {
            component: "App",
            instanceId: editId,
            newName: editName.trim(),
          },
        });

        instances = result.instances;

        // If we're renaming the current instance, update it
        if (currentInstance && currentInstance.id === editId) {
          currentInstance = instances.find((i) => i.id === editId);
          storeCurrentInstance(currentInstance);
        }

        // Explicitly save instances to ensure persistence
        await saveInstances(instances);
        saveInstancesIfNeeded();
      } else {
        logger.error("Instance rename failed", {
          category: "core",
          data: {
            component: "App",
            instanceId: editId,
            error: result.error,
          },
        });
      }
    } catch (error) {
      logger.error(`Instance rename error: ${error.message}`, {
        category: "core",
        data: {
          component: "App",
          instanceId: editId,
          errorType: error.constructor.name,
        },
      });
    }

    // Reset edit state
    editId = null;
    editName = "";
  }

  function cancelRename(event) {
    // Prevent triggering the instance selection
    event.stopPropagation();

    logger.debug("Instance rename cancelled", {
      category: "ui",
      data: {
        component: "App",
        action: "cancelRename",
        instanceId: editId,
      },
    });

    // Just reset the edit state
    editId = null;
    editName = "";
  }

  // Save instances to persistent storage

  onMount(() => {
    // Enhanced component lifecycle logging
    logger.debug("App component mounted", {
      category: "ui",
      data: {
        component: "App",
        initialStep: step,
        initialInstanceType: instanceType,
        instanceCount: instances.length,
        windowSize: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        devicePixelRatio: window.devicePixelRatio,
      },
    });

    // Initialize logger instance detection
    logger.refreshInstanceDetection();

    // Enhanced user session logging
    logger.info("User session started", {
      category: "core",
      data: {
        component: "App",
        sessionId,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
        language: navigator.language,
        platform: (() => {
          try {
            // Check if userAgentData exists (experimental API)
            const nav = navigator;
            if ("userAgentData" in nav && nav.userAgentData) {
              const userAgentData = nav.userAgentData;
              if (
                userAgentData &&
                typeof userAgentData === "object" &&
                "platform" in userAgentData
              ) {
                return String(userAgentData.platform);
              }
            }
            return navigator.platform;
          } catch {
            return navigator.platform;
          }
        })(),
        screenSize: {
          width: window.screen.width,
          height: window.screen.height,
        },
      },
    });

    // Make session ID available to other components
    setContext("sessionId", sessionId);

    // Background periodic mod/shader/resource pack update check (every 30 min)
    const runUpdateCheck = async () => {
      try {
        if (path) {
          // Use force refresh to bypass cache and detect new releases
          // The checkForUpdates function will queue this if another check is running
          await checkForUpdates(path, true);
        }
      } catch (err) {
        // Log but don't crash on update check errors
        logger.debug('Background update check failed', {
          category: 'mods',
          data: {
            component: 'App',
            function: 'runUpdateCheck',
            error: err.message
          }
        });
      }
    };
    updateIntervalId = setInterval(runUpdateCheck, 30 * 60 * 1000);
    // Initial delayed check (wait a bit for initial loads)
    setTimeout(runUpdateCheck, 15 * 1000);

    // Set up navigation tracking
    const unsubscribeRoute = route.subscribe((currentRoute) => {
      if (currentRoute) {
        logger.info("Navigation occurred", {
          category: "ui",
          data: {
            component: "App",
            route: currentRoute,
            sessionId,
            timestamp: new Date().toISOString(),
          },
        });
      }
    });

    setupIpcListeners();

    // Start periodic update checks
    setTimeout(() => {
      logger.debug("Starting periodic update checks", {
        category: "core",
        data: { component: "App", delay: 2000 },
      });
      window.electron.invoke("start-periodic-checks");
    }, 2000); // Start checking 2 seconds after app loads

    // 1) First, set up the restoration listeners BEFORE anything else
    window.electron.on("update-server-path", (newPath) => {
      logger.info("Server path update received", {
        category: "core",
        data: {
          component: "App",
          newPath,
          hasPath: !!newPath,
        },
      });

      if (newPath) {
        path = newPath;

        // Find and select the instance with this path
        const matchingInstance = instances.find(
          (instance) => instance.type === "server" && instance.path === newPath,
        );

        if (matchingInstance) {
          logger.info("Matching server instance found and selected", {
            category: "core",
            data: {
              component: "App",
              instanceId: matchingInstance.id,
              instanceName: matchingInstance.name,
            },
          });
          currentInstance = matchingInstance;
          storeCurrentInstance(matchingInstance);
          instanceType = "server";
          step = "done";
        } else {
          logger.warn("No matching server instance found for path", {
            category: "core",
            data: {
              component: "App",
              newPath,
              availableInstances: instances.length,
            },
          });
        }
      }
    });

    window.electron.on("restore-server-settings", (settings) => {
      logger.info("Server settings restoration received", {
        category: "settings",
        data: {
          component: "App",
          hasSettings: !!settings,
          settingsKeys: settings ? Object.keys(settings) : [],
        },
      });

      if (settings) {
        // Update the serverState store with restored settings
        serverState.update((state) => {
          const newState = {
            ...state,
            port: settings.port || state.port,
            maxRam: settings.maxRam || state.maxRam,
          };

          logger.info(
            "Global state change: serverState updated with restored settings",
            {
              category: "core",
              data: {
                component: "App",
                stateChange: "serverState",
                previousPort: state.port,
                newPort: newState.port,
                previousMaxRam: state.maxRam,
                newMaxRam: newState.maxRam,
                source: "restored-settings",
              },
            },
          );

          return newState;
        });

        logger.debug("Server state updated with restored settings", {
          category: "settings",
          data: {
            component: "App",
            port: settings.port,
            maxRam: settings.maxRam,
          },
        });
      }
    });

    // Show exit confirmation when main process requests it
    window.electron.on("app-close-request", () => {
      logger.info("App close request received", {
        category: "core",
        data: {
          component: "App",
          currentStep: step,
          hasCurrentInstance: !!currentInstance,
        },
      });

      logger.info("Global state change: showExitConfirmation set to true", {
        category: "core",
        data: {
          component: "App",
          stateChange: "showExitConfirmation",
          previousValue: false,
          newValue: true,
          trigger: "app-close-request",
        },
      });

      showExitConfirmation.set(true);
    });

    // Show app settings modal when requested from client
    window.electron.on("open-app-settings-modal", () => {
      logger.info("App settings modal open request received", {
        category: "ui",
        data: { component: "App" },
      });
      showAppSettings = true;
    });

    // 2) Check for initial instances loaded by main.js
    const checkExistingSetup = async () => {
      logger.debug("Checking existing setup", {
        category: "core",
        data: { component: "App", function: "checkExistingSetup" },
      });

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
          const instancesResult = await window.electron.invoke("get-instances");
          if (Array.isArray(instancesResult)) {
            initialInstances = instancesResult;
          }
        }

        if (initialInstances.length > 0) {
          logger.info("Valid instances found during setup check", {
            category: "core",
            data: {
              component: "App",
              instanceCount: initialInstances.length,
              instanceTypes: initialInstances.map((i) => i.type),
            },
          });

          // Valid instances found
          instances = initialInstances;

          // Find the server instance to use as current (if exists)
          currentInstance =
            instances.find((i) => i.type === "server") || instances[0];
          storeCurrentInstance(currentInstance);

          // Set path and type based on current instance
          if (currentInstance) {
            if (currentInstance.type === "server") {
              path = currentInstance.path;
              instanceType = "server";
            } else {
              instanceType = "client";
            }

            // Get settings for server instances
            if (currentInstance.type === "server") {
              const settingsResult =
                await window.electron.invoke("get-settings");
              if (settingsResult && settingsResult.success) {
                const { settings } = settingsResult;

                // Update server state with settings
                if (settings.port || settings.maxRam) {
                  serverState.update((state) => {
                    const newState = {
                      ...state,
                      port: settings.port || state.port,
                      maxRam: settings.maxRam || state.maxRam,
                    };

                    logger.info(
                      "Global state change: serverState updated during setup check",
                      {
                        category: "core",
                        data: {
                          component: "App",
                          stateChange: "serverState",
                          previousPort: state.port,
                          newPort: newState.port,
                          previousMaxRam: state.maxRam,
                          newMaxRam: newState.maxRam,
                          source: "setup-check-settings",
                        },
                      },
                    );

                    return newState;
                  });
                }
              }
            }
            // Set step to done to show the main UI
            step = "done";
            // Prime server config, then content, then run update check so counts show on launch
            if (path) {
              (async () => {
                try {
                  await loadServerConfig(path); // ensure minecraftVersion populated before update check
                  await loadMods(path); // mods first so installedModInfo populated
                  // Load shaders then resourcepacks sequentially to avoid isLoading gate skipping one
                  try { await loadContent(path, 'shaders'); } catch {}
                  try { await loadContent(path, 'resourcepacks'); } catch {}
                  await checkForUpdates(path); // first pass
                  try { await checkDisabledModUpdates(path); } catch {}
                  // Safety: run a second pass shortly after to catch any late-loaded manifests (resource packs etc.)
                  setTimeout(() => { try { checkForUpdates(path); checkDisabledModUpdates(path); } catch {} }, 2000);
                } catch {
                  /* silent prime errors */
                }
              })();
            }
          }
        } else {
          logger.info("No valid instances found during setup check", {
            category: "core",
            data: { component: "App", showingEmptyState: true },
          });
          // No valid instances found - but don't show instance selector automatically
          // User can manually open it via the sidebar button
          step = "done"; // Show the main UI with empty state
        }

        // Don't open sidebar automatically - let user open it manually if needed
        // isSidebarOpen = instances.length > 0;
      } catch (error) {
        logger.error(`Setup check failed: ${error.message}`, {
          category: "core",
          data: {
            component: "App",
            function: "checkExistingSetup",
            errorType: error.constructor.name,
          },
        });
        // If any error occurs, don't show the instance selector automatically
        step = "done";
        isLoading = false;
      }
    };

    checkExistingSetup();

    // Update content area width based on current window size
    updateContentAreaWidth();

    // Listen for window resize events
    window.addEventListener("resize", updateContentAreaWidth);

    // Cleanup on component destroy
    return () => {
      logger.debug("App component cleanup", {
        category: "ui",
        data: {
          component: "App",
          finalStep: step,
          finalInstanceCount: instances.length,
          sessionDuration: Date.now() - parseInt(sessionId),
        },
      });

      // Clean up event listeners and subscriptions
      window.removeEventListener("resize", updateContentAreaWidth);
      if (unsubscribeRoute) unsubscribeRoute();

      logger.debug("Event listeners and subscriptions removed", {
        category: "ui",
        data: {
          component: "App",
          cleanupItems: ["resize", "route"],
        },
      });
    };
  });

  onDestroy(() => {
    if (updateIntervalId) {
      clearInterval(updateIntervalId);
      updateIntervalId = null;
    }
    // Enhanced component lifecycle logging for unmount
    logger.debug("App component unmounted", {
      category: "ui",
      data: {
        component: "App",
        finalInstanceCount: instances.length,
        currentInstanceType: instanceType,
        finalStep: step,
        sessionDuration: Date.now() - parseInt(sessionId),
      },
    });

    // Log user session end
    logger.info("User session ended", {
      category: "core",
      data: {
        component: "App",
        sessionId,
        sessionDuration: Date.now() - parseInt(sessionId),
        timestamp: new Date().toISOString(),
      },
    });
  });

  // Helper functions to handle reactive behavior manually
  function saveInstancesIfNeeded() {
    if (step === "done" && instances) {
      logger.debug("Auto-saving instances", {
        category: "storage",
        data: {
          component: "App",
          function: "saveInstancesIfNeeded",
          instanceCount: instances.length,
          trigger: "reactive-update",
        },
      });
      saveInstances(instances);
    }
  }

  function updateServerPath() {
    if (path && instanceType === "server" && window.serverPath) {
      logger.debug("Updating server path in global context", {
        category: "core",
        data: {
          component: "App",
          function: "updateServerPath",
          path,
          instanceType,
        },
      });
      window.serverPath.set(path);
    }
  }

  // Handle setup completion
  function handleSetupComplete(event) {
    const newPath = event.detail.path;
    logger.info("Setup completed", {
      category: "core",
      data: {
        component: "App",
        action: "handleSetupComplete",
        newPath,
        instanceType,
        existingInstanceCount: instances.length,
      },
    });

    // Update path to the selected folder for the new instance
    path = newPath;
    updateServerPath();

    // If no instances exist, this is the initial setup
    if (instances.length === 0) {
      const inst = {
        id: "default-server",
        name: "Default Server",
        type: "server",
        path: newPath,
      };
      instances = [inst];
      currentInstance = inst;
      storeCurrentInstance(inst);
      saveInstancesIfNeeded();
    } else if (instanceType === "server") {
      // Check if a server instance already exists
      const hasServer = instances.some((i) => i.type === "server");

      if (hasServer) {
        const errorMsg =
          "You can only have one server instance. Please delete the existing server instance first.";

        logger.info(
          "Global state change: errorMessage set for duplicate server",
          {
            category: "core",
            data: {
              component: "App",
              stateChange: "errorMessage",
              previousValue: "",
              newValue: errorMsg,
              trigger: "duplicate-server-attempt",
            },
          },
        );

        errorMessage.set(errorMsg);
        setTimeout(() => {
          logger.debug(
            "Global state change: errorMessage cleared after timeout",
            {
              category: "core",
              data: {
                component: "App",
                stateChange: "errorMessage",
                previousValue: errorMsg,
                newValue: "",
                trigger: "timeout-clear",
              },
            },
          );
          errorMessage.set("");
        }, 5000);
        step = "done";
        return;
      }

      // Create a new server instance
      const inst = {
        id: `server-${Date.now()}`,
        name: "Server",
        type: "server",
        path: newPath,
      };
      instances = [...instances, inst];
      currentInstance = inst;
      storeCurrentInstance(inst);
      saveInstancesIfNeeded();
    }

    // Save settings as well to ensure path is remembered
    window.electron.invoke("update-settings", {
      serverPath: newPath,
    });

    // Persist the updated instances list - this part is crucial
    window.electron
      .invoke("save-instances", instances)
      .then((result) => {
        if (!result || !result.success) {
          logger.error("Failed to save instances after setup", {
            category: "storage",
            data: {
              component: "App",
              instanceCount: instances.length,
              error: result?.error,
            },
          });
        } else {
          logger.info("Instances saved successfully after setup", {
            category: "storage",
            data: {
              component: "App",
              instanceCount: instances.length,
            },
          });
        }
        // Return to main view
        step = "done";
      })
      .catch((error) => {
        logger.error(`Failed to save instances: ${error.message}`, {
          category: "storage",
          data: {
            component: "App",
            errorType: error.constructor.name,
            instanceCount: instances.length,
          },
        });
        // Return to main view anyway
        step = "done";
      });
  }

  // Toggle sidebar visibility
  function toggleSidebar() {
    // Enhanced UI interaction logging
    logger.debug("Sidebar toggled", {
      category: "ui",
      data: {
        component: "App",
        action: "toggleSidebar",
        newState: !isSidebarOpen,
        instanceCount: instances.length,
        currentStep: step,
        timestamp: new Date().toISOString(),
      },
    });

    isSidebarOpen = !isSidebarOpen;

    // Log global state change
    logger.info("Global state change: sidebar visibility", {
      category: "ui",
      data: {
        component: "App",
        stateChange: "isSidebarOpen",
        previousValue: !isSidebarOpen,
        newValue: isSidebarOpen,
        trigger: "user-interaction",
      },
    });
  }

  // Show instance selection screen
  function showAddInstanceScreen() {
    logger.info("Add instance screen requested", {
      category: "ui",
      data: {
        component: "App",
        action: "showAddInstanceScreen",
        currentInstanceCount: instances.length,
      },
    });

    // Check if we already have both types of instances
    const hasServer = instances.some((i) => i.type === "server");
    const hasClient = instances.some((i) => i.type === "client");

    if (hasServer && hasClient) {
      logger.warn("Cannot add instance - both types already exist", {
        category: "ui",
        data: {
          component: "App",
          hasServer,
          hasClient,
          totalInstances: instances.length,
        },
      });

      const errorMsg =
        "You can only have one server instance and one client instance. Please delete an existing instance first.";

      logger.info("Global state change: errorMessage set for instance limit", {
        category: "core",
        data: {
          component: "App",
          stateChange: "errorMessage",
          previousValue: "",
          newValue: errorMsg,
          trigger: "instance-limit-reached",
        },
      });

      errorMessage.set(errorMsg);
      setTimeout(() => {
        logger.debug(
          "Global state change: errorMessage cleared after timeout",
          {
            category: "core",
            data: {
              component: "App",
              stateChange: "errorMessage",
              previousValue: errorMsg,
              newValue: "",
              trigger: "timeout-clear",
            },
          },
        );
        errorMessage.set("");
      }, 5000);
      return;
    }

    showInstanceSelector = true;
  }

  // Select instance type and proceed to setup
  function selectInstanceType(type) {
    logger.info("Instance type selected", {
      category: "ui",
      data: {
        component: "App",
        action: "selectInstanceType",
        selectedType: type,
        currentInstances: instances.map((i) => i.type),
      },
    });

    // Check if an instance of this type already exists
    const hasInstanceOfType = instances.some((i) => i.type === type);

    if (hasInstanceOfType) {
      logger.warn("Cannot create instance - type already exists", {
        category: "ui",
        data: {
          component: "App",
          requestedType: type,
          existingInstances: instances.filter((i) => i.type === type).length,
        },
      });
      // Show error notification instead of alert
      errorMessage.set(
        `You can only have one ${type} instance. Please delete the existing ${type} instance first.`,
      );
      // Clear the error after 5 seconds
      setTimeout(() => {
        errorMessage.set("");
      }, 5000);
      showInstanceSelector = false;
      return;
    }

    instanceType = type;

    if (type === "server") {
      // Set step to chooseFolder to show setup wizard
      setTimeout(() => {
        step = "chooseFolder";
      }, 100);
    } else {
      // For client instances, don't create the instance until setup is complete
      // This prevents incomplete instances from being created
      currentInstance = null;
      storeCurrentInstance(null);

      // Set step to chooseFolder to show the client setup wizard
      setTimeout(() => {
        step = "chooseFolder";
      }, 100);
    }
    showInstanceSelector = false;
  }

  // Handle client setup completion
  function handleClientSetupComplete(event) {
    const { path, serverIp, serverPort } = event.detail;

    logger.info("Client setup completed", {
      category: "core",
      data: {
        component: "App",
        action: "handleClientSetupComplete",
        hasPath: !!path,
        hasServerIp: !!serverIp,
        serverPort,
      },
    });

    // Create a new fully configured client instance
    const newInstance = {
      id: `client-${Date.now()}`,
      name: "Minecraft Client",
      type: "client",
      path: path,
      serverIp: serverIp,
      serverPort: serverPort,
    };

    // Add to instances array and set as current
    instances = [...instances, newInstance];
    currentInstance = newInstance;
    storeCurrentInstance(newInstance);

    // Save instances to persistent storage
    window.electron
      .invoke("save-instances", instances)
      .then((result) => {
        if (!result || !result.success) {
          logger.error("Failed to save client instance", {
            category: "storage",
            data: {
              component: "App",
              instanceId: newInstance.id,
              error: result?.error,
            },
          });
        } else {
          logger.info("Client instance saved successfully", {
            category: "storage",
            data: {
              component: "App",
              instanceId: newInstance.id,
              instanceName: newInstance.name,
            },
          });
        }
        step = "done";
      })
      .catch((error) => {
        logger.error(`Failed to save client instance: ${error.message}`, {
          category: "storage",
          data: {
            component: "App",
            instanceId: newInstance.id,
            errorType: error.constructor.name,
          },
        });
        step = "done";
      });
  }

  // Store current instance in localStorage for logger
  function storeCurrentInstance(instance) {
    try {
      if (instance && typeof window !== "undefined") {
        localStorage.setItem(
          "currentInstance",
          JSON.stringify({
            id: instance.id,
            name: instance.name,
            type: instance.type,
            path: instance.path,
          }),
        );

        // Update logger instance
        logger.setInstance(instance.name || `${instance.type}-${instance.id}`);

        // Notify backend about instance change
        try {
          window.electron.invoke("set-current-instance", {
            name: instance.name,
            path: instance.path,
            type: instance.type,
            id: instance.id,
          });
        } catch (error) {
          // Failed to notify backend about instance change
        }
      } else {
        localStorage.removeItem("currentInstance");
        logger.setInstance("system");

        // Notify backend about instance change
        try {
          window.electron.invoke("set-current-instance", null);
        } catch (error) {
          // Failed to notify backend about instance change
        }
      }
    } catch (error) {
      logger.warn("Failed to store current instance in localStorage", {
        category: "storage",
        data: {
          component: "App",
          error: error.message,
          instanceId: instance?.id,
        },
      });
    }
  }

  // Switch between instances
  function switchInstance(instance) {
    logger.info("Switching to instance", {
      category: "ui",
      data: {
        component: "App",
        action: "switchInstance",
        newInstanceId: instance.id,
        newInstanceType: instance.type,
        previousInstanceId: currentInstance?.id,
        previousInstanceType: currentInstance?.type,
      },
    });

    // Clean up any incomplete client instances before switching
    const originalCount = instances.length;
    instances = instances.filter((inst) => {
      if (inst.type === "client" && (!inst.path || !inst.serverIp)) {
        // This is an incomplete client instance, remove it
        return false;
      }
      return true;
    });

    if (instances.length !== originalCount) {
      logger.debug("Cleaned up incomplete client instances", {
        category: "core",
        data: {
          component: "App",
          removedCount: originalCount - instances.length,
        },
      });
    }

    currentInstance = instance;
    storeCurrentInstance(instance);

    if (instance.type === "server") {
      path = instance.path;
      instanceType = "server";
      updateServerPath();
    } else {
      instanceType = "client";
    }
  }

  // Update CSS variable for content area width based on window size
  function updateContentAreaWidth() {
    if (typeof window !== "undefined") {
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
      document.documentElement.style.setProperty(
        "--content-area-width",
        `${contentWidth}px`,
      );

      // Also ensure no horizontal scrolling on body/html
      document.documentElement.style.overflowX = "hidden";
      document.body.style.overflowX = "hidden";

      // Log layout adjustment for performance tracking
      logger.debug("Layout adjusted for window size", {
        category: "performance",
        data: {
          component: "App",
          function: "updateContentAreaWidth",
          windowWidth,
          contentWidth,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }
</script>

<main class="app-container">
  {#if hasError}
    <!-- Error boundary UI -->
    <div class="error-boundary">
      <h2>Something went wrong</h2>
      <p>
        The application encountered an error. Please try refreshing the page.
      </p>
      {#if errorInfo && errorInfo.error}
        <details
          style="margin: 10px 0; font-family: monospace; font-size: 12px;"
        >
          <summary>Error Details (for debugging)</summary>
          <pre>{errorInfo.error.message}</pre>
        </details>
      {/if}
      <button
        on:click={() => {
          hasError = false;
          errorInfo = null;
          logger.info("Error boundary reset by user", {
            category: "ui",
            data: {
              component: "App",
              action: "resetErrorBoundary",
              sessionId,
            },
          });
        }}
      >
        Try Again
      </button>
    </div>
  {:else}
    <!-- Sidebar toggle button -->
    <button class="sidebar-toggle" on:click={toggleSidebar}> ☰ </button>
    {#if isSidebarOpen}
      <div
        class="sidebar-overlay"
        role="button"
        tabindex="0"
        on:click={() => (isSidebarOpen = false)}
        on:keydown={(e) => e.key === "Escape" && (isSidebarOpen = false)}
      ></div>
    {/if}

    <!-- Sidebar -->
    <div class="sidebar" class:open={isSidebarOpen}>
      <h2>Instances</h2>
      <div class="instances-list">
        {#each instances as instance (instance.id)}
          <div
            class="instance-item"
            class:active={currentInstance && currentInstance.id === instance.id}
            role="button"
            tabindex="0"
            on:click={() => switchInstance(instance)}
            on:keydown={(e) =>
              (e.key === "Enter" || e.key === " ") && switchInstance(instance)}
          >
            <span class="instance-icon"
              >{instance.type === "server" ? "🖥️" : "👤"}</span
            >
            {#if editId === instance.id}
              <!-- Edit mode -->
              <div class="rename-controls" role="group">
                <input
                  type="text"
                  bind:value={editName}
                  class="rename-input"
                  on:click|stopPropagation
                  on:keydown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") confirmRename(e);
                    if (e.key === "Escape") cancelRename(e);
                  }}
                />
                <div class="rename-actions">
                  <button
                    class="rename-btn confirm"
                    on:click={(e) => {
                      e.stopPropagation();
                      confirmRename(e);
                    }}
                    title="Save">✓</button
                  >
                  <button
                    class="rename-btn cancel"
                    on:click={(e) => {
                      e.stopPropagation();
                      cancelRename(e);
                    }}
                    title="Cancel">✕</button
                  >
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
      {#if !window.IS_BROWSER_PANEL}
        <button class="add-instance-btn" on:click={showAddInstanceScreen}>
          <span class="plus-icon">+</span> Add Instance
        </button>
      {/if}
    </div>

    <!-- Instance type selector modal -->
    {#if showInstanceSelector}
      <div
        class="modal-overlay"
        role="dialog"
        aria-modal="true"
        tabindex="0"
        on:click={() => (showInstanceSelector = false)}
        on:keydown={(e) => e.key === "Escape" && (showInstanceSelector = false)}
      >
        <div class="modal-content welcome-modal" role="document">
          <h1>Welcome to Minecraft Core</h1>
          <p>Choose an instance type to get started:</p>
          <div class="instance-type-container">
            {#if instances.some((i) => i.type === "server")}
              <div class="instance-type-card disabled">
                <div class="instance-type-icon">🖥️</div>
                <h3>Server Manager</h3>
                <p>Create and manage Minecraft servers</p>
                <div class="disabled-notice">
                  You already have a server instance
                </div>
              </div>
            {:else}
              <div
                class="instance-type-card"
                role="button"
                tabindex="0"
                on:click={() => {
                  instanceType = "server";
                  showInstanceSelector = false;
                  step = "chooseFolder";
                }}
                on:keydown={(e) =>
                  (e.key === "Enter" || e.key === " ") &&
                  (() => {
                    instanceType = "server";
                    showInstanceSelector = false;
                    step = "chooseFolder";
                  })()}
              >
                <div class="instance-type-icon">🖥️</div>
                <h3>Server Manager</h3>
                <p>Create and manage Minecraft servers</p>
              </div>
            {/if}

            {#if instances.some((i) => i.type === "client")}
              <div class="instance-type-card disabled">
                <div class="instance-type-icon">👤</div>
                <h3>Client Interface</h3>
                <p>Connect to Minecraft servers as a player</p>
                <div class="disabled-notice">
                  You already have a client instance
                </div>
              </div>
            {:else}
              <div
                class="instance-type-card"
                role="button"
                tabindex="0"
                on:click={() => selectInstanceType("client")}
                on:keydown={(e) =>
                  (e.key === "Enter" || e.key === " ") &&
                  selectInstanceType("client")}
              >
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
      {#if step === "chooseFolder"}
        <div class="setup-container">
          {#if instanceType === "server"}
            <SetupWizard
              on:setup-complete={(event) => {
                handleSetupComplete(event);
              }}
            />
          {:else if instanceType === "client"}
            <ClientSetupWizard
              on:setup-complete={(event) => {
                handleClientSetupComplete(event);
              }}
            />
          {/if}
        </div>
      {:else if isLoading}
        <!-- Loading screen -->
        <div class="loading-screen">
          <p>Loading your Minecraft server...</p>
        </div>
      {:else if step === "done"}
        {#if currentInstance === null || instances.length === 0}
          <!-- Empty state - show welcome message -->
          <div class="empty-state">
            <div class="empty-state-content">
              <h1>Welcome to Minecraft Core</h1>
              <p>
                You haven't created any instances yet. Get started by creating
                your first server or client instance.
              </p>
              {#if !window.IS_BROWSER_PANEL}
                <button
                  class="create-instance-btn"
                  on:click={showAddInstanceScreen}
                >
                  <span class="plus-icon">+</span> Create Your First Instance
                </button>
              {/if}
            </div>
          </div>
        {:else if instanceType === "server"}
          <header class="server-header">
            <div class="header-title-row">
              <h1>Minecraft Core</h1>
              <button
                class="app-settings-button"
                on:click={() => {
                  logger.info("App settings button clicked", {
                    category: "ui",
                    data: {
                      component: "App",
                      action: "openAppSettings",
                    },
                  });
                  showAppSettings = true;
                }}
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
                  on:click={() => {
                    logger.info("Tab navigation", {
                      category: "ui",
                      data: {
                        component: "App",
                        action: "navigate",
                        fromRoute: $route,
                        toRoute: "/" + t,
                        tab: t,
                      },
                    });
                    navigate("/" + t);
                  }}
                >
                  {#if t === "dashboard"}
                    📊 Dashboard
                  {:else if t === "players"}
                    👥 Players
                  {:else if t === "mods"}
                    🧩 Mods {#if $updateCountStore > 0}<span class="nav-update-badge" title="Pending content updates">{$updateCountStore}</span>{/if}
                  {:else if t === "backups"}
                    💾 Backups
                  {:else if t === "settings"}
                    ⚙️ Settings
                  {/if}
                </button>
              {/each}
            </div>
          </header>

          <!-- Tab content container -->
          <div class="tab-content">
            {#if $route === "/dashboard"}
              <div class="content-panel">
                {#await loadRoute('dashboard')}
                  <div class="route-loading">
                    <div class="loading-spinner"></div>
                    <p>Loading Dashboard...</p>
                  </div>
                {:then Component}
                  <svelte:component this={Component} serverPath={path} />
                {:catch error}
                  <div class="route-error">
                    <p>Failed to load Dashboard. Please try again.</p>
                    <button on:click={() => {
                      logger.error(`Dashboard chunk load failed: ${error.message}`, {
                        category: "ui",
                        data: { component: "App", route: "dashboard", error: error.message }
                      });
                      window.location.reload();
                    }}>Refresh</button>
                  </div>
                {/await}
              </div>
            {:else if $route === "/players"}
              <div class="content-panel">
                <PlayerList serverPath={path} />
              </div>
            {:else if $route === "/mods"}
              <div class="content-panel">
                {#await loadRoute('mods')}
                  <div class="route-loading">
                    <div class="loading-spinner"></div>
                    <p>Loading Mods...</p>
                  </div>
                {:then Component}
                  <svelte:component this={Component} serverPath={path} />
                {:catch error}
                  <div class="route-error">
                    <p>Failed to load Mods page. Please try again.</p>
                    <button on:click={() => {
                      logger.error(`Mods chunk load failed: ${error.message}`, {
                        category: "ui",
                        data: { component: "App", route: "mods", error: error.message }
                      });
                      window.location.reload();
                    }}>Refresh</button>
                  </div>
                {/await}
              </div>
            {:else if $route === "/backups"}
              <div class="content-panel">
                <Backups serverPath={path} />
              </div>
            {:else if $route === "/settings"}
              <div class="content-panel">
                {#await loadRoute('settings')}
                  <div class="route-loading">
                    <div class="loading-spinner"></div>
                    <p>Loading Settings...</p>
                  </div>
                {:then Component}
                  <svelte:component this={Component}
                    serverPath={path}
                    {currentInstance}
                    on:deleted={(e) => {
                      logger.info("Instance deleted from settings", {
                        category: "core",
                        data: {
                          component: "App",
                          deletedInstanceId: e.detail.id,
                          remainingInstances: instances.length - 1,
                        },
                      });

                      // Remove the instance from the list
                      instances = instances.filter((i) => i.id !== e.detail.id);

                      // Switch to a different instance if available, otherwise show empty state
                      if (instances.length > 0) {
                        currentInstance = instances[0];
                        storeCurrentInstance(instances[0]);
                        logger.info(
                          "Switched to remaining instance after deletion",
                          {
                            category: "core",
                            data: {
                              component: "App",
                              newInstanceId: currentInstance.id,
                              newInstanceType: currentInstance.type,
                            },
                          },
                        );
                        if (currentInstance.type === "server") {
                          path = currentInstance.path;
                          instanceType = "server";
                        } else {
                          instanceType = "client";
                        }
                      } else {
                        logger.info(
                          "No instances remaining after deletion, showing empty state",
                          {
                            category: "core",
                            data: { component: "App" },
                          },
                        );
                        // Show empty state instead of forcing instance selector
                        currentInstance = null;
                        storeCurrentInstance(null);
                        step = "done";
                      }
                    }}
                  />
                {:catch error}
                  <div class="route-error">
                    <p>Failed to load Settings page. Please try again.</p>
                    <button on:click={() => {
                      logger.error(`Settings chunk load failed: ${error.message}`, {
                        category: "ui",
                        data: { component: "App", route: "settings", error: error.message }
                      });
                      window.location.reload();
                    }}>Refresh</button>
                  </div>
                {/await}
              </div>
            {/if}
          </div>
        {:else if instanceType === "client"}
          {#if currentInstance && currentInstance.path && currentInstance.serverIp}
            <ClientInterface
              instance={currentInstance}
              onOpenAppSettings={() => (showAppSettings = true)}
              on:deleted={(e) => {
                logger.info("Client instance deleted", {
                  category: "core",
                  data: {
                    component: "App",
                    deletedInstanceId: e.detail.id,
                    remainingInstances: instances.length - 1,
                  },
                });

                // Remove the instance from the list
                instances = instances.filter((i) => i.id !== e.detail.id);

                // Switch to a different instance if available, otherwise show empty state
                if (instances.length > 0) {
                  currentInstance = instances[0];
                  storeCurrentInstance(instances[0]);
                  logger.info(
                    "Switched to remaining instance after client deletion",
                    {
                      category: "core",
                      data: {
                        component: "App",
                        newInstanceId: currentInstance.id,
                        newInstanceType: currentInstance.type,
                      },
                    },
                  );
                  if (currentInstance.type === "server") {
                    path = currentInstance.path;
                    instanceType = "server";
                  } else {
                    instanceType = "client";
                  }
                } else {
                  logger.info(
                    "No instances remaining after client deletion, showing empty state",
                    {
                      category: "core",
                      data: { component: "App" },
                    },
                  );
                  // Show empty state instead of forcing instance selector
                  currentInstance = null;
                  storeCurrentInstance(null);
                  step = "done";
                }
              }}
            />
          {:else}
            <!-- Client instance exists but is not configured - show setup wizard -->
            <div class="setup-container">
              <ClientSetupWizard
                on:setup-complete={(event) => {
                  handleClientSetupComplete(event);
                }}
              />
            </div>
          {/if}
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
        logger.info("Exit confirmation accepted", {
          category: "core",
          data: {
            component: "App",
            action: "exitConfirmed",
          },
        });
        window.electron.invoke("app-close-response", true);
        showExitConfirmation.set(false);
      }}
      on:cancel={() => {
        logger.info("Exit confirmation cancelled", {
          category: "core",
          data: {
            component: "App",
            action: "exitCancelled",
          },
        });
        window.electron.invoke("app-close-response", false);
        showExitConfirmation.set(false);
      }}
    />
    <AppSettingsModal
      bind:visible={showAppSettings}
      on:close={() => (showAppSettings = false)}
    />
  <StatusManager />
  <ModAvailabilityNotifications />
    <UpdateNotification />
    <Toaster richColors theme="dark" />
  {/if}
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
    padding: 0 2rem 2rem 2rem; /* Reduced top padding from 1rem to 0.25rem */
    position: relative;
    box-sizing: border-box;
    min-height: auto;
  }

  /* Force remove all top spacing from mod manager */
  :global(.mod-manager) {
    margin-top: 0 !important;
    padding-top: 0 !important;
  }

  :global(.content-type-tabs) {
    margin-top: 0 !important;
    padding-top: 0 !important;
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
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    min-height: 100vh;
    width: 100%;
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

  /* Error boundary styles */
  .error-boundary {
    padding: 2rem;
    margin: 2rem auto;
    max-width: 600px;
    background-color: #fff1f0;
    border: 1px solid #ffccc7;
    border-radius: 4px;
    text-align: center;
    color: #333;
  }

  .error-boundary h2 {
    color: #cf1322;
    margin-bottom: 1rem;
  }

  .error-boundary p {
    margin-bottom: 1.5rem;
  }

  .error-boundary button {
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    background-color: #1890ff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .error-boundary button:hover {
      background-color: #40a9ff;
    }
    .nav-update-badge {background:#ef4444;color:#fff;font-size:0.55rem;padding:2px 6px;border-radius:10px;font-weight:600;margin-left:4px;display:inline-block;min-width:18px;text-align:center;}

  /* Route loading and error states */
  .route-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 2rem;
    color: rgba(255, 255, 255, 0.8);
  }

  .route-loading p {
    margin-top: 1rem;
    font-size: 1rem;
  }

  .loading-spinner {
    width: 40px;
    height: 40px;
    border: 4px solid rgba(59, 130, 246, 0.2);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .route-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 2rem;
    text-align: center;
  }

  .route-error p {
    color: #ef4444;
    font-size: 1.1rem;
    margin-bottom: 1.5rem;
  }

  .route-error button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .route-error button:hover {
    background-color: #2563eb;
    transform: translateY(-1px);
  }
  </style>
