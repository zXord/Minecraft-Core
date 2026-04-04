<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import logger from "../../utils/logger.js";

  // Event dispatcher to communicate with parent component
  const dispatch = createEventDispatcher();

  onMount(() => {
    logger.info("SetupWizard component mounted", {
      category: "ui",
      data: {
        component: "SetupWizard",
        lifecycle: "onMount",
        initialStep: step,
      },
    });
  });

  onDestroy(() => {
    logger.debug("SetupWizard component destroyed", {
      category: "ui",
      data: {
        component: "SetupWizard",
        lifecycle: "onDestroy",
      },
    });
  });

  // State variables
  let path = "";
  let mcVersions = [];
  let fabricVersions = [];
  let selectedLoader = "fabric";
  let selectedMC = null;
  let selectedFabric = null;
  let acceptEula = false;
  let installing = false;
  let installProgress = 0;
  let installSpeed = "0 MB/s";
  let installLogs = [];
  let step = "chooseFolder"; // chooseFolder → chooseVersion → done

  // Functions
  async function selectFolder() {
    logger.info("Starting folder selection process", {
      category: "ui",
      data: {
        component: "SetupWizard",
        function: "selectFolder",
      },
    });

    try {
      const result = await window.electron.invoke("select-folder");
      if (!result) {
        logger.debug("Folder selection cancelled by user", {
          category: "ui",
          data: {
            component: "SetupWizard",
            function: "selectFolder",
            result: "cancelled",
          },
        });
        return;
      }

      path = result;

      logger.info("Folder selected successfully", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "selectFolder",
          selectedPath: path,
        },
      });

      // Update global server path
      if (window.serverPath) {
        window.serverPath.set(path);
      }

      const config = await window.electron.invoke("read-config", path);
      if (config?.version && (config?.loader || config?.fabric)) {
        // Existing configuration found
        selectedMC = config.version;
        selectedLoader = config.loader || (config.fabric ? "fabric" : "vanilla");
        selectedFabric = config.loaderVersion || config.fabric || null;

        logger.info("Existing configuration found, skipping to completion", {
          category: "ui",
          data: {
            component: "SetupWizard",
            function: "selectFolder",
            mcVersion: selectedMC,
            loader: selectedLoader,
            loaderVersion: selectedFabric,
            flow: "existing_config",
          },
        });

        // Skip to completion
        dispatchSetupComplete();
      } else {
        selectedMC = config?.version || null;
        selectedLoader = config?.loader || (config?.fabric ? "fabric" : "fabric");
        selectedFabric = config?.loaderVersion || config?.fabric || null;

        // Need to configure
        logger.info(
          "No existing configuration found, proceeding to version selection",
          {
            category: "ui",
            data: {
              component: "SetupWizard",
              function: "selectFolder",
              detectedVersion: selectedMC,
              detectedLoader: selectedLoader,
              detectedLoaderVersion: selectedFabric,
              flow: "new_config",
            },
          },
        );

        step = "chooseVersion";
        await fetchMinecraftVersions();
        if (selectedMC) {
          if (!mcVersions.includes(selectedMC)) {
            mcVersions = [selectedMC, ...mcVersions];
          }
          await onMCVersionChange(selectedFabric);
        }
      }
    } catch (err) {
      logger.error("Error during folder selection", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "selectFolder",
          errorMessage: err.message,
        },
      });
    }
  }

  async function fetchMinecraftVersions() {
    logger.info("Fetching Minecraft versions from Fabric API", {
      category: "ui",
      data: {
        component: "SetupWizard",
        function: "fetchMinecraftVersions",
        apiUrl: "https://meta.fabricmc.net/v2/versions/game",
      },
    });

    try {
      const res = await fetch("https://meta.fabricmc.net/v2/versions/game");
      if (!res.ok) {
        const error = new Error(
          `Failed to fetch Minecraft versions: ${res.status}`,
        );
        logger.error("Failed to fetch Minecraft versions from API", {
          category: "ui",
          data: {
            component: "SetupWizard",
            function: "fetchMinecraftVersions",
            status: res.status,
            statusText: res.statusText,
            errorMessage: error.message,
          },
        });
        throw error;
      }

      const data = await res.json();
      mcVersions = data.filter((v) => v.stable).map((v) => v.version);

      logger.info("Minecraft versions fetched successfully", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "fetchMinecraftVersions",
          totalVersions: data.length,
          stableVersions: mcVersions.length,
        },
      });
    } catch (err) {
      logger.error("Error fetching Minecraft versions", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "fetchMinecraftVersions",
          errorMessage: err.message,
          fallback: "empty_array",
        },
      });
      mcVersions = [];
    }
  }

  async function onMCVersionChange(eventOrPreferredFabric = null) {
    logger.info("Minecraft version changed, fetching loader versions", {
      category: "ui",
      data: {
        component: "SetupWizard",
        function: "onMCVersionChange",
        selectedMC,
        selectedLoader,
      },
    });

    const preservedFabric =
      typeof eventOrPreferredFabric === "string"
        ? eventOrPreferredFabric
        : selectedFabric;
    selectedFabric = null;
    try {
      if (selectedLoader === "vanilla") {
        fabricVersions = [];
        return;
      }

      const result = await window.electron.invoke("get-loader-versions", {
        loader: selectedLoader,
        mcVersion: selectedMC,
      });
      if (!result?.success) {
        throw new Error(result?.error || `Failed to fetch ${selectedLoader} versions`);
      }

      fabricVersions = result.versions || [];
      if (preservedFabric && fabricVersions.includes(preservedFabric)) {
        selectedFabric = preservedFabric;
      }

      logger.info("Fabric versions fetched successfully", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "onMCVersionChange",
          selectedMC,
          loaderVersionsCount: fabricVersions.length,
        },
      });
    } catch (err) {
      logger.error("Error fetching loader versions", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "onMCVersionChange",
          selectedMC,
          selectedLoader,
          errorMessage: err.message,
          fallback: "empty_array",
        },
      });
      fabricVersions = [];
    }
  }

  async function onLoaderChange() {
    selectedFabric = null;
    await onMCVersionChange();
  }

  async function saveVersionSelection() {
    logger.info("Starting server installation process", {
      category: "ui",
      data: {
        component: "SetupWizard",
        function: "saveVersionSelection",
        path,
        selectedMC,
        selectedLoader,
        selectedFabric,
        acceptEula,
      },
    });

    try {
      installing = true;
      installLogs = [];
      installProgress = 0;
      installSpeed = "Starting...";

      // Register event handlers for installation progress
      setupInstallationListeners();

      // Add initial log message
      installLogs = [...installLogs, "Starting server setup..."];

      // Save configuration
      installLogs = [...installLogs, "Saving configuration..."];
      logger.debug("Saving version selection configuration", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "saveVersionSelection",
          step: "save_config",
          path,
          mcVersion: selectedMC,
          loader: selectedLoader,
          loaderVersion: selectedFabric,
        },
      });

      await window.electron.invoke("save-version-selection", {
        path,
        mcVersion: selectedMC,
        loader: selectedLoader,
        loaderVersion: selectedFabric,
        fabricVersion: selectedFabric,
      });

      // Download Minecraft server
      installLogs = [
        ...installLogs,
        `Downloading Minecraft server version ${selectedMC}...`,
      ];
      logger.debug("Starting Minecraft server download", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "saveVersionSelection",
          step: "download_minecraft",
          mcVersion: selectedMC,
          targetPath: path,
        },
      });

      await window.electron.invoke("download-minecraft-server", {
        mcVersion: selectedMC,
        targetPath: path,
      });

      // Accept EULA if checked
      if (acceptEula) {
        installLogs = [...installLogs, "Accepting Minecraft EULA..."];
        logger.debug("Writing EULA acceptance", {
          category: "ui",
          data: {
            component: "SetupWizard",
            function: "saveVersionSelection",
            step: "write_eula",
            path,
          },
        });
        await window.electron.invoke("write-eula", {
          path,
          content: "eula=true\n",
        });
      }

      // Install selected loader
      installLogs = [
        ...installLogs,
        selectedLoader === "vanilla"
          ? "Using Vanilla server..."
          : `Installing ${selectedLoader} ${selectedFabric}...`,
      ];
      logger.debug("Starting loader installation", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "saveVersionSelection",
          step: "install_loader",
          mcVersion: selectedMC,
          loader: selectedLoader,
          loaderVersion: selectedFabric,
          path,
        },
      });

      await window.electron.invoke("download-and-install-loader", {
        path,
        mcVersion: selectedMC,
        loader: selectedLoader,
        loaderVersion: selectedFabric,
        fabricVersion: selectedFabric,
      });

      // Download Java for the server
      installLogs = [...installLogs, "Checking Java requirements..."];
      logger.debug("Starting Java setup for server", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "saveVersionSelection",
          step: "java_setup",
          minecraftVersion: selectedMC,
          serverPath: path,
        },
      });

      try {
        const javaResult = await window.electron.invoke("server-java-ensure", {
          minecraftVersion: selectedMC,
          serverPath: path,
        });

        if (javaResult.success) {
          installLogs = [...installLogs, "Java ready for server!"];
          logger.info("Java setup completed successfully", {
            category: "ui",
            data: {
              component: "SetupWizard",
              function: "saveVersionSelection",
              step: "java_setup",
              result: "success",
            },
          });
        } else {
          // Java setup failed, but don't fail the whole setup - repair can reinstall it later
          installLogs = [
            ...installLogs,
            `Java setup skipped: ${javaResult.error || "Use Server Maintenance to repair Java before starting if needed"}`,
          ];
          logger.warn("Java setup failed but continuing with installation", {
            category: "ui",
            data: {
              component: "SetupWizard",
              function: "saveVersionSelection",
              step: "java_setup",
              result: "skipped",
              error: javaResult.error,
            },
          });
        }
      } catch (javaError) {
        // Java setup failed, but don't fail the whole setup
        installLogs = [
          ...installLogs,
          "Java setup skipped - use Server Maintenance to repair Java before starting if needed",
        ];
        logger.warn("Java setup failed with exception but continuing", {
          category: "ui",
          data: {
            component: "SetupWizard",
            function: "saveVersionSelection",
            step: "java_setup",
            result: "exception",
            errorMessage: javaError.message,
          },
        });
      }

      // Complete setup
      installLogs = [...installLogs, "Setup completed successfully!"];
      installing = false;

      logger.info("Server installation completed successfully", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "saveVersionSelection",
          result: "success",
          path,
          mcVersion: selectedMC,
          loader: selectedLoader,
          loaderVersion: selectedFabric,
          eulaAccepted: acceptEula,
        },
      });

      dispatchSetupComplete();
    } catch (err) {
      installing = false;
      const errorMsg = `Error: ${err.message || "Unknown error during installation"}`;
      installLogs = [...installLogs, errorMsg];

      logger.error("Server installation failed", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "saveVersionSelection",
          result: "error",
          errorMessage: err.message,
          path,
          mcVersion: selectedMC,
          loader: selectedLoader,
          loaderVersion: selectedFabric,
        },
      });
    }
  }

  function setupInstallationListeners() {
    logger.debug("Setting up installation event listeners", {
      category: "ui",
      data: {
        component: "SetupWizard",
        function: "setupInstallationListeners",
      },
    });

    // Remove any existing listeners first to prevent duplicates
    window.electron.removeAllListeners("minecraft-server-progress");
    window.electron.removeAllListeners("fabric-install-progress");
    window.electron.removeAllListeners("loader-install-progress");
    window.electron.removeAllListeners("install-log");
    window.electron.removeAllListeners("server-java-download-progress");

    // Add new listeners
    window.electron.on("minecraft-server-progress", (data) => {
      if (data && typeof data === "object") {
        logger.debug("Minecraft server download progress received", {
          category: "ui",
          data: {
            component: "SetupWizard",
            event: "minecraft-server-progress",
            percent: data.percent,
            speed: data.speed,
          },
        });
        installProgress = data.percent || 0;
        installSpeed = data.speed || "0 MB/s";
      }
    });

    window.electron.on("fabric-install-progress", (data) => {
      if (data && typeof data === "object") {
        logger.debug("Fabric installation progress received", {
          category: "ui",
          data: {
            component: "SetupWizard",
            event: "fabric-install-progress",
            percent: data.percent,
            speed: data.speed,
          },
        });
        installProgress = data.percent || 0;
        installSpeed = data.speed || "0 MB/s";
      }
    });

    window.electron.on("loader-install-progress", (data) => {
      if (data && typeof data === "object") {
        installProgress = data.percent || 0;
        installSpeed = data.speed || "0 MB/s";
      }
    });

    window.electron.on("install-log", (line) => {
      if (line && typeof line === "string") {
        // Disabled debug logging to prevent excessive logs
        // logger.debug('Installation log message received', {
        //   category: 'ui',
        //   data: {
        //     component: 'SetupWizard',
        //     event: 'install-log',
        //     logLine: line
        //   }
        // });
        installLogs = [...installLogs, line];
      }
    });

    window.electron.on("server-java-download-progress", (data) => {
      if (data && typeof data === "object") {
        logger.debug("Server Java download progress received", {
          category: "ui",
          data: {
            component: "SetupWizard",
            event: "server-java-download-progress",
            progress: data.progress,
            downloadedMB: data.downloadedMB,
            totalMB: data.totalMB,
            task: data.task,
          },
        });
        installProgress = data.progress || 0;
        installSpeed =
          data.downloadedMB && data.totalMB
            ? `${data.downloadedMB}/${data.totalMB} MB`
            : "";
        installLogs = [...installLogs, `Java: ${data.task}`];
      }
    });
  }

  function dispatchSetupComplete() {
    logger.info("Dispatching setup completion event", {
      category: "ui",
      data: {
        component: "SetupWizard",
        function: "dispatchSetupComplete",
        path,
        mcVersion: selectedMC,
        loader: selectedLoader,
        loaderVersion: selectedFabric,
        hasPath: !!path,
      },
    });

    // Make sure path is not empty
    if (!path || path.trim() === "") {
      logger.warn("Cannot dispatch setup complete - no path provided", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "dispatchSetupComplete",
          path,
          reason: "empty_path",
        },
      });
      return;
    }

    // Use a setTimeout to ensure the event is dispatched after the current execution
    setTimeout(() => {
      logger.info("Setup completion event dispatched successfully", {
        category: "ui",
        data: {
          component: "SetupWizard",
          function: "dispatchSetupComplete",
          event: "setup-complete",
          eventData: {
            path,
            mcVersion: selectedMC,
            loader: selectedLoader,
            loaderVersion: selectedFabric,
          },
        },
      });

      dispatch("setup-complete", {
        path,
        mcVersion: selectedMC,
        loader: selectedLoader,
        loaderVersion: selectedFabric,
        fabricVersion: selectedFabric,
      });
    }, 0);
  }

  // Track step changes
  $: if (step !== undefined) {
    logger.debug("Setup wizard step changed", {
      category: "ui",
      data: {
        component: "SetupWizard",
        event: "stepChanged",
        newStep: step,
        path,
        mcVersion: selectedMC,
        loader: selectedLoader,
        loaderVersion: selectedFabric,
      },
    });
  }

  onMount(() => {
    // Setup listeners on mount to catch any delayed events
    setupInstallationListeners();

    // Clean up event listeners when component is unmounted
    return () => {
      logger.debug("Cleaning up SetupWizard event listeners", {
        category: "ui",
        data: {
          component: "SetupWizard",
          lifecycle: "cleanup",
        },
      });

      window.electron.removeAllListeners("minecraft-server-progress");
      window.electron.removeAllListeners("fabric-install-progress");
      window.electron.removeAllListeners("loader-install-progress");
      window.electron.removeAllListeners("install-log");
      window.electron.removeAllListeners("server-java-download-progress");
    };
  });
</script>

<div class="setup-wizard">
  {#if step === "chooseFolder"}
    <h1>Select a folder to set up Minecraft Core</h1>
    <p>Click the button below to choose a folder for your Minecraft server</p>
    <button class="action-button large-button" on:click={selectFolder}>
      📁 Choose Folder
    </button>
  {:else if step === "chooseVersion"}
    <div class="version-selection">
      <h2>Choose Minecraft version</h2>
      <select bind:value={selectedMC} on:change={onMCVersionChange}>
        <option disabled selected value={null}>
          -- Select Minecraft Version --
        </option>
        {#each mcVersions as version (version)}
          <option value={version}>{version}</option>
        {/each}
      </select>

      {#if selectedMC}
        <h2>Choose server loader</h2>
        <select bind:value={selectedLoader} on:change={onLoaderChange}>
          <option value="vanilla">Vanilla</option>
          <option value="fabric">Fabric</option>
          <option value="forge">Forge</option>
        </select>
      {/if}

      {#if selectedMC && selectedLoader !== "vanilla"}
        <h2>Choose {selectedLoader} loader version</h2>
        <select bind:value={selectedFabric}>
          <option disabled selected value={null}>
            -- Select {selectedLoader} Loader --
          </option>
          {#each fabricVersions as fabricVersion (fabricVersion)}
            <option value={fabricVersion}>{fabricVersion}</option>
          {/each}
        </select>
      {/if}

      {#if selectedMC && (selectedLoader === "vanilla" || selectedFabric)}
        <label class="eula-label">
          <input type="checkbox" bind:checked={acceptEula} />
          <span>I accept the Minecraft EULA</span>
        </label>

        {#if !acceptEula}
          <p class="eula-warning">You must accept the EULA to continue</p>
        {/if}

        <button
          class="action-button"
          disabled={!acceptEula || installing}
          on:click={saveVersionSelection}
        >
          {installing ? "Installing..." : `Install ${selectedLoader === "vanilla" ? "Server" : `${selectedLoader} Server`}`}
        </button>
      {/if}

      {#if installing}
        <div class="installation-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: {installProgress}%"></div>
          </div>
          <p class="progress-text">
            Progress: {installProgress}% ({installSpeed})
          </p>

          <div class="install-logs">
            <h3>Installation Logs</h3>
            <div class="logs-container">
              {#each installLogs as log, index (index)}
                <p>{log}</p>
              {/each}
              <!-- Auto-scroll to bottom -->
              <div class="auto-scroll"></div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .setup-wizard {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    max-width: 800px;
    width: 100%;
    margin: 0 auto;
  }

  h1,
  h2,
  h3 {
    color: white;
    text-align: center;
    margin-bottom: 1.5rem;
  }

  .version-selection {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 500px;
  }

  select {
    width: 100%;
    padding: 0.75rem;
    margin-bottom: 2rem;
    background-color: #2d3748;
    color: white;
    border: 1px solid #4b5563;
    border-radius: 4px;
    font-size: 1rem;
  }

  .action-button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 2rem;
    font-size: 1rem;
    cursor: pointer;
    transition: background-color 0.2s;
    margin: 1rem 0;
    width: 100%;
    max-width: 300px;
  }

  .large-button {
    font-size: 1.25rem;
    padding: 1rem 2.5rem;
    margin-bottom: 1.5rem;
  }

  .eula-label {
    display: flex;
    align-items: center;
    margin: 1.5rem 0;
    color: white;
  }

  .eula-label input {
    margin-right: 0.5rem;
  }

  .eula-warning {
    color: #ef4444;
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .installation-progress {
    width: 100%;
    margin-top: 1.5rem;
  }

  .progress-bar {
    width: 100%;
    height: 0.75rem;
    background-color: #1f2937;
    border-radius: 0.375rem;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }

  .progress-fill {
    height: 100%;
    background-color: #3b82f6;
    transition: width 0.3s ease;
  }

  .progress-text {
    text-align: center;
    margin-bottom: 1rem;
    font-weight: 500;
  }

  .install-logs {
    margin-top: 1.5rem;
    width: 100%;
  }

  .logs-container {
    background-color: #1f2937;
    border-radius: 4px;
    padding: 1rem;
    max-height: 200px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 0.875rem;
    color: #d1d5db;
    position: relative;
  }

  .logs-container p {
    margin: 0.25rem 0;
  }

  .auto-scroll {
    float: left;
    clear: both;
  }

  .action-button:hover:not(:disabled) {
    background-color: #2563eb;
  }

  .action-button:disabled {
    background-color: #4b5563;
    cursor: not-allowed;
  }
</style>
