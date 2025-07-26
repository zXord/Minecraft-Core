// Minecraft launcher service for client launching with Microsoft authentication

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { EventEmitter } = require('events');
const { JavaManager } = require('./java-manager.cjs');
const { XMCLAuthHandler } = require('./xmcl-auth-handler.cjs');
const { ClientDownloader } = require('./client-downloader.cjs');
const XMCLClientDownloader = require('./xmcl-client-downloader.cjs');
const { ProperMinecraftLauncher } = require('./proper-launcher.cjs');
const { getLoggerHandlers } = require('../../ipc/logger-handlers.cjs');

// Initialize logger
const logger = getLoggerHandlers();

// Console hiding removed - fixing the root cause instead (using javaw.exe)

// Add global error handling for unhandled promise rejections
process.on('unhandledRejection', (reason) => {

  // Handle common authentication network errors gracefully
  if (reason instanceof Error) {
    if (reason.message.includes('ENOTFOUND') ||
      reason.message.includes('authserver.mojang.com') ||
      reason.message.includes('api.minecraftservices.com')) {
      return; // Don't crash the app for authentication network issues
    }
  }

  // For other critical errors, we might want to log them differently
});

class MinecraftLauncher extends EventEmitter {
  constructor() {
    super();
    this.isLaunching = false;
    this.client = null;    // this.authData = null; // Moved to AuthHandler
    this.clientPath = null;
    this.javaManager = new JavaManager(); // Initialize without client path initially
    this.authHandler = new XMCLAuthHandler(this); // Use new XMCL auth handler

    logger.info('Minecraft launcher service initialized', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        hasJavaManager: !!this.javaManager,
        hasAuthHandler: !!this.authHandler
      }
    });

    // NEW: buffered auth logs which are emitted before debug console is ready
    this.pendingAuthLogs = [];
    this.on('auth-log', (entry) => {
      if (this.debugWindow && !this.debugWindow.isDestroyed()) {
        this.debugWindow.webContents.send('debug-log', entry);
      } else {
        // Store for later flush when debug console opens
        this.pendingAuthLogs.push(entry);
      }
    });

    // Hybrid approach: Use XMCL downloader with legacy fallback during migration
    this.legacyClientDownloader = new ClientDownloader(this.javaManager, this);
    this.xmclClientDownloader = new XMCLClientDownloader(this.javaManager, this, this.legacyClientDownloader);
    this.useXMCLDownloader = true; // Using XMCL downloader (modern, efficient)

    // Set the active downloader based on flag
    this.clientDownloader = this.useXMCLDownloader ?
      this.xmclClientDownloader : this.legacyClientDownloader;

    // Add proper launcher for fixing LogUtils issues
    this.properLauncher = new ProperMinecraftLauncher();

    // Our new approach logs directly from the spawned Java process


    // utils.logSystemInfo(); // Use util function

  }



  // Get the correct Java version for a Minecraft version - MOVED to utils.cjs
  // getRequiredJavaVersion(minecraftVersion) { ... }

  // Microsoft Authentication
  async authenticateWithMicrosoft() {
    logger.info('Starting Microsoft authentication', {
      category: 'auth',
      data: {
        service: 'MinecraftLauncher',
        operation: 'authenticateWithMicrosoft'
      }
    });

    try {
      const result = await this.authHandler.authenticateWithMicrosoft();

      logger.info('Microsoft authentication completed', {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'authenticateWithMicrosoft',
          success: !!result,
          hasAccessToken: !!(result && result.access_token)
        }
      });

      return result;
    } catch (error) {
      logger.error(`Microsoft authentication failed: ${error.message}`, {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'authenticateWithMicrosoft',
          errorType: error.constructor.name,
          errorCode: error.code
        }
      });
      throw error;
    }
  }

  // Save authentication data to file
  async saveAuthData(clientPath) {
    logger.debug('Saving authentication data', {
      category: 'auth',
      data: {
        service: 'MinecraftLauncher',
        operation: 'saveAuthData',
        clientPath: clientPath ? path.basename(clientPath) : null
      }
    });

    try {
      const result = await this.authHandler.saveAuthData(clientPath);

      logger.info('Authentication data saved successfully', {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'saveAuthData',
          success: true
        }
      });

      return result;
    } catch (error) {
      logger.error(`Failed to save authentication data: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'saveAuthData',
          errorType: error.constructor.name,
          clientPath: clientPath ? path.basename(clientPath) : null
        }
      });
      throw error;
    }
  }

  // Load saved authentication data
  async loadAuthData(clientPath) {
    logger.debug('Loading authentication data', {
      category: 'auth',
      data: {
        service: 'MinecraftLauncher',
        operation: 'loadAuthData',
        clientPath: clientPath ? path.basename(clientPath) : null
      }
    });

    try {
      const result = await this.authHandler.loadAuthData(clientPath);

      logger.info('Authentication data loaded', {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'loadAuthData',
          success: !!result,
          hasValidAuth: !!(result && result.access_token)
        }
      });

      return result;
    } catch (error) {
      logger.error(`Failed to load authentication data: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'loadAuthData',
          errorType: error.constructor.name,
          clientPath: clientPath ? path.basename(clientPath) : null
        }
      });
      throw error;
    }
  }

  // Reset launcher state - used when launcher gets stuck
  resetLauncherState() {
    logger.warn('Resetting launcher state', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'resetLauncherState',
        wasLaunching: this.isLaunching,
        hadClient: !!this.client
      }
    });

    this.isLaunching = false;
    this.client = null;

    logger.info('Launcher state reset completed', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'resetLauncherState'
      }
    });
  }

  // Check if authentication is valid and refresh if needed
  async checkAndRefreshAuth(forceRefresh = false) {
    logger.debug('Checking and refreshing authentication', {
      category: 'auth',
      data: {
        service: 'MinecraftLauncher',
        operation: 'checkAndRefreshAuth',
        forceRefresh
      }
    });

    try {
      const result = await this.authHandler.checkAndRefreshAuth(forceRefresh);

      logger.info('Authentication check completed', {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'checkAndRefreshAuth',
          success: result.success,
          refreshed: result.refreshed,
          requiresAuth: result.requiresAuth
        }
      });

      return result;
    } catch (error) {
      logger.error(`Authentication check failed: ${error.message}`, {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'checkAndRefreshAuth',
          errorType: error.constructor.name,
          forceRefresh
        }
      });
      throw error;
    }
  }

  // Clear authentication data (for force re-authentication)
  clearAuthData() {
    logger.info('Clearing authentication data', {
      category: 'auth',
      data: {
        service: 'MinecraftLauncher',
        operation: 'clearAuthData'
      }
    });

    try {
      const result = this.authHandler.clearAuthData();

      logger.info('Authentication data cleared successfully', {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'clearAuthData',
          success: true
        }
      });

      return result;
    } catch (error) {
      logger.error(`Failed to clear authentication data: ${error.message}`, {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'clearAuthData',
          errorType: error.constructor.name
        }
      });
      throw error;
    }
  }

  // Check Java installation 
  async checkJavaInstallation() {
    logger.debug('Checking Java installation', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'checkJavaInstallation',
        platform: process.platform
      }
    });

    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);


      // Try different Java commands - prioritize javaw on Windows to avoid console
      const javaCommands = process.platform === 'win32' ? [
        'javaw', // Windows java without console - PREFERRED
        'java', // Standard java command
        path.join(process.env.JAVA_HOME || '', 'bin', 'javaw'), // JAVA_HOME javaw
        path.join(process.env.JAVA_HOME || '', 'bin', 'java') // JAVA_HOME java
      ] : [
        'java', // Standard java command
        path.join(process.env.JAVA_HOME || '', 'bin', 'java') // JAVA_HOME
      ];

      const validCommands = javaCommands.filter(cmd => cmd && cmd !== 'bin\\java' && cmd !== 'bin\\javaw'); // Filter out invalid paths

      for (const javaCommand of validCommands) {
        try {
          const { stdout, stderr } = await execAsync(`"${javaCommand}" -version`, { timeout: 5000 });
          const output = stdout + stderr; // Java version info often goes to stderr

          if (output.includes('version')) {

            // Check Java architecture (32-bit vs 64-bit)
            let is64Bit = false;
            try {
              await execAsync(`"${javaCommand}" -d64 -version`, { timeout: 3000 });
              is64Bit = true;
            } catch {
              is64Bit = false;
            }

            // Check if it's a reasonable Java version (8 or higher)
            const versionMatch = output.match(/version "?(\d+)\.?(\d*)/);
            if (versionMatch) {
              const majorVersion = parseInt(versionMatch[1]);
              const minorVersion = parseInt(versionMatch[2] || '0');

              // Java 8 is version 1.8, Java 9+ is version 9+
              const isValidVersion = majorVersion >= 9 || (majorVersion === 1 && minorVersion >= 8);

              if (isValidVersion) {
                const result = {
                  success: true,
                  javaPath: javaCommand,
                  version: versionMatch[0],
                  is64Bit: is64Bit,
                  architecture: is64Bit ? '64-bit' : '32-bit'
                };

                logger.info('Java installation found', {
                  category: 'client',
                  data: {
                    service: 'MinecraftLauncher',
                    operation: 'checkJavaInstallation',
                    javaPath: javaCommand,
                    version: result.version,
                    architecture: result.architecture,
                    majorVersion
                  }
                });

                return result;
              }
            } else {
              return {
                success: true,
                javaPath: javaCommand,
                version: 'unknown',
                is64Bit: is64Bit,
                architecture: is64Bit ? '64-bit' : '32-bit'
              };
            }
          }
        } catch {
          continue;
        }
      }

      // If no Java found, provide helpful error message
      const errorResult = {
        success: false,
        error: 'Java not found. Please install Java 8 or higher from https://adoptopenjdk.net/ or https://www.oracle.com/java/technologies/downloads/'
      };

      logger.error('Java installation not found', {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'checkJavaInstallation',
          platform: process.platform,
          testedCommands: validCommands.length
        }
      });

      return errorResult;

    } catch (error) {
      logger.error(`Java installation check failed: ${error.message}`, {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'checkJavaInstallation',
          errorType: error.constructor.name,
          platform: process.platform
        }
      });

      return {
        success: false,
        error: `Failed to check Java installation: ${error.message}`
      };
    }
  }

  // Download Minecraft client files for a specific version (simplified approach)
  async downloadMinecraftClientSimple(clientPath, minecraftVersion, options = {}) {
    logger.info('Starting Minecraft client download', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'downloadMinecraftClientSimple',
        minecraftVersion,
        clientPath: clientPath ? path.basename(clientPath) : null,
        useXMCLDownloader: this.useXMCLDownloader,
        options: Object.keys(options)
      }
    });

    try {
      const result = await this.clientDownloader.downloadMinecraftClientSimple(clientPath, minecraftVersion, options);

      logger.info('Minecraft client download completed', {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'downloadMinecraftClientSimple',
          minecraftVersion,
          success: result.success,
          downloadedFiles: result.downloadedFiles || 0
        }
      });

      return result;
    } catch (error) {
      logger.error(`Minecraft client download failed: ${error.message}`, {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'downloadMinecraftClientSimple',
          minecraftVersion,
          errorType: error.constructor.name,
          clientPath: clientPath ? path.basename(clientPath) : null
        }
      });
      throw error;
    }
  }

  // Launch Minecraft client
  async launchMinecraft(options) {
    const {
      clientPath,
      minecraftVersion,
      serverIp,
      serverPort,
      requiredMods = [],
      serverInfo = null,
      maxMemory = null, // Accept memory setting from client
      showDebugTerminal = false
    } = options;

    logger.info('Starting Minecraft launch process', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'launchMinecraft',
        minecraftVersion,
        serverIp,
        serverPort,
        requiredModsCount: requiredMods.length,
        loaderType: serverInfo?.loaderType,
        maxMemory,
        showDebugTerminal,
        clientPath: clientPath ? path.basename(clientPath) : null
      }
    });


    // CRITICAL: Check vanilla JAR immediately for LogUtils issue


    // PHASE 4 ENHANCEMENT: Continue with actual Minecraft launch
    try {

      // Determine launch version and setup
      const needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
      const fabricVersion = serverInfo?.loaderVersion || 'latest';
      let launchVersion = minecraftVersion;

      logger.debug('Determining launch configuration', {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'launchMinecraft',
          needsFabric,
          fabricVersion,
          minecraftVersion
        }
      });

      if (needsFabric) {
        // Use latest Fabric version if needed
        let actualFabricVersion = fabricVersion;
        if (fabricVersion === 'latest') {
          try {
            logger.debug('Fetching latest Fabric version', {
              category: 'network',
              data: {
                service: 'MinecraftLauncher',
                operation: 'fetchFabricVersion',
                url: 'https://meta.fabricmc.net/v2/versions/loader'
              }
            });

            const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
            const loaders = await response.json();
            actualFabricVersion = loaders[0].version;

            logger.info('Latest Fabric version retrieved', {
              category: 'network',
              data: {
                service: 'MinecraftLauncher',
                operation: 'fetchFabricVersion',
                fabricVersion: actualFabricVersion
              }
            });
          } catch (error) {
            actualFabricVersion = '0.16.14';
            logger.warn(`Failed to fetch latest Fabric version, using fallback: ${error.message}`, {
              category: 'network',
              data: {
                service: 'MinecraftLauncher',
                operation: 'fetchFabricVersion',
                fallbackVersion: actualFabricVersion,
                errorType: error.constructor.name
              }
            });
          }
        }
        launchVersion = `fabric-loader-${actualFabricVersion}-${minecraftVersion}`;

        logger.info('Fabric launch configuration determined', {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'launchMinecraft',
            launchVersion,
            fabricVersion: actualFabricVersion
          }
        });
      }

      // Get Java path
      const requiredJavaVersion = require('./utils.cjs').getRequiredJavaVersion(minecraftVersion);

      logger.debug('Ensuring Java availability', {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'ensureJava',
          requiredJavaVersion,
          minecraftVersion
        }
      });

      const javaResult = await this.javaManager.ensureJava(requiredJavaVersion);

      if (!javaResult.success) {
        logger.error(`Java ${requiredJavaVersion} not available: ${javaResult.error}`, {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'ensureJava',
            requiredJavaVersion,
            error: javaResult.error
          }
        });
        throw new Error(`Java ${requiredJavaVersion} not available: ${javaResult.error}`);
      }

      const javaPath = javaResult.javaPath;

      logger.info('Java path resolved', {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'ensureJava',
          javaPath: path.basename(javaPath),
          requiredJavaVersion
        }
      });

      // Prepare launch arguments
      const versionsDir = path.join(clientPath, 'versions');
      const launchJsonPath = path.join(versionsDir, launchVersion, `${launchVersion}.json`);

      logger.debug('Loading launch profile', {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'loadLaunchProfile',
          launchVersion,
          launchJsonPath: path.basename(launchJsonPath)
        }
      });

      if (!fs.existsSync(launchJsonPath)) {
        logger.error(`Launch profile not found: ${launchJsonPath}`, {
          category: 'storage',
          data: {
            service: 'MinecraftLauncher',
            operation: 'loadLaunchProfile',
            launchVersion,
            launchJsonPath
          }
        });
        throw new Error(`Launch profile not found: ${launchJsonPath}`);
      }

      const launchJson = JSON.parse(fs.readFileSync(launchJsonPath, 'utf8'));

      logger.info('Launch profile loaded successfully', {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'loadLaunchProfile',
          launchVersion,
          mainClass: launchJson.mainClass,
          librariesCount: launchJson.libraries?.length || 0
        }
      });

      // Build classpath
      const classpath = [];

      // Add vanilla JAR first
      const vanillaJarPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
      if (fs.existsSync(vanillaJarPath)) {
        classpath.push(vanillaJarPath);
      } else {
        throw new Error(`Vanilla JAR not found: ${vanillaJarPath}`);
      }

      // Helper function to get library priority (higher number = higher priority)
      const getLibraryPriority = (name) => {
        if (name.includes('asm')) {
          // For ASM libraries, prefer higher versions
          const versionMatch = name.match(/asm[^:]*:(\d+\.?\d*)/);
          if (versionMatch) {
            return parseFloat(versionMatch[1]);
          }
        }
        return 0;
      };

      // Helper function to normalize library name for deduplication
      const normalizeLibraryName = (name) => {
        // Don't normalize native libraries - they're separate from their main libraries
        if (name.includes('-natives-')) {
          return name; // Keep full name for natives (e.g., "org.lwjgl:lwjgl:3.3.3:natives-windows")
        }

        // Remove version to get base library name for non-natives
        const parts = name.split(':');
        if (parts.length >= 2) {
          return `${parts[0]}:${parts[1]}`;
        }
        return name;
      };

      // Process libraries with deduplication
      const libraryMap = new Map();
      for (const lib of launchJson.libraries) {
        if (!lib.name) continue;

        // Handle regular libraries (downloads.artifact)
        if (lib.downloads?.artifact) {
          const libPath = path.join(clientPath, 'libraries', lib.downloads.artifact.path);

          if (fs.existsSync(libPath)) {
            const normalizedName = normalizeLibraryName(lib.name);
            const priority = getLibraryPriority(lib.name);

            // Check if we already have this library
            if (libraryMap.has(normalizedName)) {
              const existing = libraryMap.get(normalizedName);
              if (priority > existing.priority) {
                libraryMap.set(normalizedName, { name: lib.name, path: libPath, priority });
              }
            } else {
              libraryMap.set(normalizedName, { name: lib.name, path: libPath, priority });
            }
          }
        }        // Handle native libraries (downloads.classifiers) - CRITICAL for LWJGL natives
        if (lib.downloads?.classifiers) {
          const platform = process.platform === 'win32' ? 'windows' :
            process.platform === 'darwin' ? 'osx' : 'linux';

          // Look for platform-specific natives
          for (const [classifier, download] of Object.entries(lib.downloads.classifiers)) {
            if (classifier.includes(`natives-${platform}`)) {
              const nativeLibPath = path.join(clientPath, 'libraries', download.path);

              if (fs.existsSync(nativeLibPath)) {
                const nativeLibName = `${lib.name}:${classifier}`;
                libraryMap.set(nativeLibName, {
                  name: nativeLibName,
                  path: nativeLibPath,
                  priority: 100
                });
              }
            }
          }
        }
        // Handle native libraries as separate entries (modern Minecraft format)
        if (lib.downloads?.artifact && lib.name.includes(':natives-')) {
          const platform = process.platform === 'win32' ? 'windows' :
            process.platform === 'darwin' ? 'macos' : 'linux';

          // Check if this native library matches our platform
          if (lib.name.includes(`natives-${platform}`)) {
            const nativeLibPath = path.join(clientPath, 'libraries', lib.downloads.artifact.path);

            if (fs.existsSync(nativeLibPath)) {
              libraryMap.set(lib.name, {
                name: lib.name,
                path: nativeLibPath,
                priority: 100
              });
            }
          }
        }
      }
      // Add deduplicated libraries to classpath
      for (const [, libInfo] of libraryMap) {
        classpath.push(libInfo.path);
      }

      // Setup authentication - Check and refresh token before launch
      logger.debug('Setting up authentication for launch', {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'setupAuthentication',
          hasAuthData: !!this.authHandler.authData
        }
      });

      if (!this.authHandler.authData) {
        logger.error('No authentication data available for launch', {
          category: 'auth',
          data: {
            service: 'MinecraftLauncher',
            operation: 'setupAuthentication'
          }
        });
        throw new Error('No authentication data available. Please authenticate first.');
      }

      const refreshResult = await this.checkAndRefreshAuth(true); // Force refresh on every launch

      if (refreshResult.success && refreshResult.refreshed) {
        // Save the refreshed token immediately
        logger.info('Authentication token refreshed, saving to disk', {
          category: 'auth',
          data: {
            service: 'MinecraftLauncher',
            operation: 'setupAuthentication',
            tokenRefreshed: true
          }
        });
        await this.saveAuthData(clientPath).catch((error) => {
          logger.warn(`Failed to save refreshed auth data: ${error.message}`, {
            category: 'storage',
            data: {
              service: 'MinecraftLauncher',
              operation: 'saveRefreshedAuth',
              errorType: error.constructor.name
            }
          });
        });
      } else if (!refreshResult.success) {
        if (refreshResult.requiresAuth) {
          // Clear expired token and require fresh authentication
          logger.error('Authentication expired, requires fresh authentication', {
            category: 'auth',
            data: {
              service: 'MinecraftLauncher',
              operation: 'setupAuthentication',
              requiresAuth: true
            }
          });
          throw new Error('Authentication expired. Please authenticate again through the Settings page.');
        } else {
          logger.error(`Authentication failed: ${refreshResult.error}`, {
            category: 'auth',
            data: {
              service: 'MinecraftLauncher',
              operation: 'setupAuthentication',
              error: refreshResult.error
            }
          });
          throw new Error(`Authentication failed: ${refreshResult.error}`);
        }
      }

      const authData = this.authHandler.authData;

      // Verify we still have valid auth data after refresh check
      if (!authData) {
        logger.error('Authentication data missing after refresh check', {
          category: 'auth',
          data: {
            service: 'MinecraftLauncher',
            operation: 'setupAuthentication',
            refreshSuccess: refreshResult.success
          }
        });
        throw new Error('Authentication data missing after refresh check. Please authenticate again.');
      }

      logger.info('Authentication setup completed successfully', {
        category: 'auth',
        data: {
          service: 'MinecraftLauncher',
          operation: 'setupAuthentication',
          playerName: authData.name,
          hasAccessToken: !!authData.access_token,
          hasUuid: !!authData.uuid
        }
      });

      // Try both UUID formats to see which one works
      const uuidWithDashes = authData.uuid.includes('-') ?
        authData.uuid : // Already has dashes, use as-is
        authData.uuid.length === 32 ?
          `${authData.uuid.substring(0, 8)}-${authData.uuid.substring(8, 12)}-${authData.uuid.substring(12, 16)}-${authData.uuid.substring(16, 20)}-${authData.uuid.substring(20)}` :
          authData.uuid;

      // Use the dashed UUID format as Minecraft expects it
      const minecraftUuid = uuidWithDashes;

      // Build launch arguments
      const gameArgs = [];
      // Process game arguments from profile
      if (launchJson.arguments?.game) {
        for (const arg of launchJson.arguments.game) {
          if (typeof arg === 'string') {
            let processedArg = arg
              .replace(/\$\{auth_playerName\}/g, authData.name)
              .replace(/\$\{auth_player_name\}/g, authData.name)
              .replace(/\$\{auth_uuid\}/g, minecraftUuid) // Use properly formatted UUID
              .replace(/\$\{auth_accessToken\}/g, authData.access_token)
              .replace(/\$\{auth_access_token\}/g, authData.access_token)
              .replace(/\$\{auth_userType\}/g, 'msa')
              .replace(/\$\{auth_user_type\}/g, 'msa')
              .replace(/\$\{version_name\}/g, launchVersion)
              .replace(/\$\{game_directory\}/g, clientPath)
              .replace(/\$\{assets_root\}/g, path.join(clientPath, 'assets'))
              .replace(/\$\{assets_index_name\}/g, launchJson.assetIndex?.id || minecraftVersion)
              .replace(/\$\{version_type\}/g, 'release');

            gameArgs.push(processedArg);
          } else {
            gameArgs.push(arg);
          }
        }
      }

      // Add server connection arguments if provided
      if (serverIp && serverPort) {
        gameArgs.push('--server', serverIp);
        gameArgs.push('--port', serverPort.toString());
      }

      // Build JVM arguments
      const jvmArgs = [
        `-Xmx${maxMemory || 4096}M`,
        `-Xms1024M`,
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        '-XX:+PerfDisableSharedMem',
        '-XX:MaxTenuringThreshold=1'
      ];

      // Add native library paths - CRITICAL for LWJGL
      const nativesDir = path.join(clientPath, 'versions', launchVersion, 'natives');

      // Ensure natives directory exists and extract natives if needed
      if (!fs.existsSync(nativesDir)) {
        fs.mkdirSync(nativesDir, { recursive: true });
      }      // Extract native libraries from JARs
      for (const [, libInfo] of libraryMap) {
        // Look for native JAR files (containing DLL/SO files)
        // Support both old format (:natives-) and new format (separate native entries)
        if ((libInfo.name.includes(':natives-') || libInfo.name.includes(':natives-')) && libInfo.path.endsWith('.jar')) {
          try {
            const zip = new (/** @type {any} */ (AdmZip))(libInfo.path);
            const entries = zip.getEntries();

            for (const entry of entries) {
              if (!entry.isDirectory && (entry.entryName.endsWith('.dll') || entry.entryName.endsWith('.so') || entry.entryName.endsWith('.dylib'))) {
                const nativePath = path.join(nativesDir, path.basename(entry.entryName));
                if (!fs.existsSync(nativePath)) {
                  fs.writeFileSync(nativePath, entry.getData());
                }
              }
            }
          } catch {
            // TODO: Add proper logging - Failed to extract from ${libInfo.name}:
          }
        }
      }
      // Add native library system properties - MULTIPLE WAYS for maximum compatibility
      jvmArgs.push(
        `-Djava.library.path=${nativesDir}`,
        `-Dorg.lwjgl.librarypath=${nativesDir}`,
        `-Djna.tmpdir=${nativesDir}`,
        `-Dorg.lwjgl.system.SharedLibraryExtractPath=${nativesDir}`,
        `-Dio.netty.native.workdir=${nativesDir}`
      );

      // Add classpath
      jvmArgs.push('-cp', classpath.join(process.platform === 'win32' ? ';' : ':'));

      // Add additional JVM args from profile
      if (launchJson.arguments?.jvm) {
        for (const arg of launchJson.arguments.jvm) {
          if (typeof arg === 'string' && !jvmArgs.includes(arg)) {
            let processedArg = arg
              .replace(/\$\{natives_directory\}/g, nativesDir)
              .replace(/\$\{launcher_name\}/g, 'minecraft-core')
              .replace(/\$\{launcher_version\}/g, '1.0.0');
            jvmArgs.push(processedArg);
          }
        }
      }

      // Final arguments
      const allArgs = [
        ...jvmArgs,
        launchJson.mainClass || 'net.minecraft.client.main.Main',
        ...gameArgs
      ];

      // Launch Minecraft
      const { spawn } = require('child_process');

      logger.info('Preparing to spawn Minecraft process', {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'spawnMinecraft',
          launchVersion,
          javaPath: path.basename(javaPath),
          showDebugTerminal,
          maxMemory,
          classpathEntries: classpath.length,
          jvmArgsCount: jvmArgs.length,
          gameArgsCount: gameArgs.length
        }
      });

      this.isLaunching = true;      // Configure stdio based on debug terminal setting      // Launch Minecraft with the configured arguments
      try {
        // Configure spawn options for debug terminal
        const spawnOptions = {
          cwd: clientPath,
          detached: true  // Allow Minecraft to continue running after app closes
        };

        // Declare variables for debug mode outside the if block to fix scope
        let debugJavaPath = javaPath;
        let debugWindow = null;

        // Configure spawn options for debug vs normal launch
        if (showDebugTerminal && process.platform === 'win32') {
          // For debug mode, use java.exe instead of javaw.exe to get console output
          debugJavaPath = javaPath.replace('javaw.exe', 'java.exe');

          // Create debug window and capture output
          const { BrowserWindow } = require('electron');
          debugWindow = new BrowserWindow({
            width: 800,
            height: 500,
            title: `Minecraft Debug Console - ${launchVersion}`,
            backgroundColor: '#1a1a1a',
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              preload: path.join(__dirname, '../../preload.cjs')
            },
            icon: path.join(__dirname, '../../icon.png'),
            show: false,
            resizable: true,
            minimizable: true,
            maximizable: true
          });

          // Load debug console HTML
          debugWindow.loadFile(path.join(__dirname, '../../debug-console.html'));

          // Show window when ready
          debugWindow.once('ready-to-show', () => {
            debugWindow.show();

            // Immediately send header + flush; if content not yet ready it queues automatically
            if (debugWindow && !debugWindow.isDestroyed()) {
              // Flush any auth logs captured before console was visible
              if (this.pendingAuthLogs && this.pendingAuthLogs.length > 0) {
                for (const logEntry of this.pendingAuthLogs) {
                  debugWindow.webContents.send('debug-log', logEntry);
                }
                this.pendingAuthLogs.length = 0;
              }

              debugWindow.webContents.send('debug-log', {
                type: 'header',
                message: `========================================
    MINECRAFT DEBUG CONSOLE
========================================

Java Executable: ${debugJavaPath}
Working Directory: ${clientPath}
Launch Version: ${launchVersion}

========================================
Starting Minecraft with console output...
========================================
`
              });
            }
          });

          // Launch Java with captured output
          spawnOptions.stdio = ['pipe', 'pipe', 'pipe'];
          spawnOptions.windowsHide = true;
        } else if (showDebugTerminal) {
          // On Unix-like systems, inherit stdio for terminal output
          spawnOptions.stdio = 'inherit';
        } else {
          // Normal launch without debug terminal
          spawnOptions.stdio = ['ignore', 'pipe', 'pipe'];
          if (process.platform === 'win32') {
            spawnOptions.windowsHide = true;
          }
        }

        // Continue with normal launch process (this ensures Fabric still works!)
        logger.info('Spawning Minecraft process', {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'spawnProcess',
            javaExecutable: showDebugTerminal ? path.basename(debugJavaPath) : path.basename(javaPath),
            argumentsCount: allArgs.length,
            workingDirectory: path.basename(clientPath),
            detached: spawnOptions.detached
          }
        });

        const child = spawn(showDebugTerminal ? debugJavaPath : javaPath, allArgs, spawnOptions);

        // If debug terminal is enabled, capture and forward output
        if (showDebugTerminal && debugWindow) {
          // Store reference to debug window for cleanup
          this.debugWindow = debugWindow;

          // Capture stdout
          if (child.stdout) {
            child.stdout.on('data', (data) => {
              const output = data.toString();
              if (debugWindow && !debugWindow.isDestroyed()) {
                debugWindow.webContents.send('debug-log', {
                  type: 'info',
                  message: output
                });
              }
            });
          }

          // Capture stderr (errors)
          if (child.stderr) {
            child.stderr.on('data', (data) => {
              const output = data.toString();
              if (debugWindow && !debugWindow.isDestroyed()) {
                debugWindow.webContents.send('debug-log', {
                  type: 'error',
                  message: output
                });
              }
            });
          }

          // Handle process close
          child.on('close', (code) => {
            if (debugWindow && !debugWindow.isDestroyed()) {
              debugWindow.webContents.send('debug-log', {
                type: code === 0 ? 'success' : 'error',
                message: `\n========================================\nMinecraft process ended with code: ${code}\n${code === 0 ? '✅ SUCCESS: Minecraft closed normally' : '❌ ERROR: Minecraft crashed or failed to start!'}\n========================================\n`
              });
            }
          });

          // Clean up debug window reference when it's closed
          debugWindow.on('closed', () => {
            this.debugWindow = null;
          });
        }

        // Properly detach the process so it continues running after app closes
        if (!showDebugTerminal) {
          child.unref();
        }

        this.client = { child };

        logger.info('Minecraft process spawned successfully', {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'processSpawned',
            pid: child.pid,
            launchVersion
          }
        });

        child.on('close', (code, signal) => {
          logger.info('Minecraft process closed', {
            category: 'client',
            data: {
              service: 'MinecraftLauncher',
              operation: 'processClose',
              exitCode: code,
              signal,
              launchVersion
            }
          });

          this.isLaunching = false;
          this.client = null;
          this.emit('minecraft-stopped');
        });

        child.on('error', (error) => {
          logger.error(`Minecraft process error: ${error.message}`, {
            category: 'client',
            data: {
              service: 'MinecraftLauncher',
              operation: 'processError',
              errorType: error.constructor.name,
              errorCode: 'code' in error ? error.code : 'unknown',
              launchVersion
            }
          });

          this.isLaunching = false;
          this.client = null;
          this.emit('minecraft-stopped');
        });

        // Wait a moment to see if launch fails immediately
        logger.debug('Waiting for process stability check', {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'stabilityCheck',
            pid: child.pid
          }
        });

        await new Promise(resolve => setTimeout(resolve, 3000));

        if (child.killed || child.exitCode !== null) {
          logger.error(`Minecraft failed to start. Exit code: ${child.exitCode}`, {
            category: 'client',
            data: {
              service: 'MinecraftLauncher',
              operation: 'launchFailure',
              exitCode: child.exitCode,
              killed: child.killed,
              launchVersion
            }
          });
          throw new Error(`Minecraft failed to start. Exit code: ${child.exitCode}`);
        }

        const result = {
          success: true,
          message: `Minecraft ${launchVersion} launched successfully`,
          pid: child.pid,
          version: launchVersion,
          vanillaVersion: minecraftVersion,
          needsFabric: needsFabric
        };

        logger.info('Minecraft launch completed successfully', {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'launchSuccess',
            pid: child.pid,
            launchVersion,
            vanillaVersion: minecraftVersion,
            needsFabric,
            maxMemory,
            showDebugTerminal
          }
        });

        return result;
      } catch (error) {
        logger.error(`Minecraft launch failed: ${error.message}`, {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'launchMinecraft',
            errorType: error.constructor.name,
            minecraftVersion,
            launchVersion: launchVersion || minecraftVersion,
            errorStack: error.stack
          }
        });

        this.isLaunching = false;
        this.client = null;

        return {
          success: false,
          error: error.message, message: `Failed to launch Minecraft: ${error.message}`
        };
      }
    } catch (mainError) {
      logger.error(`Critical Minecraft launch failure: ${mainError.message}`, {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'launchMinecraft',
          errorType: mainError.constructor.name,
          minecraftVersion,
          critical: true,
          errorStack: mainError.stack
        }
      });

      this.isLaunching = false;
      this.client = null;

      return {
        success: false,
        error: mainError.message,
        message: `Failed to launch Minecraft: ${mainError.message}`
      };
    }
  }

  // Stop Minecraft if running
  async stopMinecraft() {
    logger.info('Attempting to stop Minecraft', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'stopMinecraft',
        hasClient: !!this.client,
        isLaunching: this.isLaunching,
        platform: process.platform
      }
    });

    try {

      let stopped = false;

      // Method 1: Stop via direct process if available
      if (this.client && this.client.child) {
        try {
          logger.info('Stopping Minecraft via direct process', {
            category: 'client',
            data: {
              service: 'MinecraftLauncher',
              operation: 'stopDirect',
              pid: this.client.child.pid,
              killed: this.client.child.killed
            }
          });

          // We have direct access to the child process from our spawn call
          this.client.child.kill('SIGTERM');

          // Wait a moment, then force kill if necessary
          setTimeout(() => {
            if (this.client && this.client.child && !this.client.child.killed) {
              logger.warn('Force killing Minecraft process after timeout', {
                category: 'client',
                data: {
                  service: 'MinecraftLauncher',
                  operation: 'forceKill',
                  pid: this.client.child.pid
                }
              });
              this.client.child.kill('SIGKILL');
            }
          }, 3000);

          stopped = true;

          logger.info('Minecraft process termination signal sent', {
            category: 'client',
            data: {
              service: 'MinecraftLauncher',
              operation: 'stopDirect',
              success: true
            }
          });
        } catch (error) {
          logger.error(`Failed to stop Minecraft process directly: ${error.message}`, {
            category: 'client',
            data: {
              service: 'MinecraftLauncher',
              operation: 'stopDirect',
              errorType: error.constructor.name,
              pid: this.client?.child?.pid
            }
          });
        }
      }

      // Method 2: Targeted Java process killing (Windows-specific fallback)
      if (process.platform === 'win32') {
        try {
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);

          logger.debug('Attempting Windows-specific process termination', {
            category: 'client',
            data: {
              service: 'MinecraftLauncher',
              operation: 'stopWindows',
              clientPath: this.clientPath ? path.basename(this.clientPath) : null,
              hasPid: !!(this.client?.child?.pid)
            }
          });

          // CRITICAL FIX: Only kill Java processes that are specifically related to this client
          // DO NOT kill all Java processes as this would stop the Minecraft server!

          // Try to kill only processes running from our client directory
          if (this.clientPath) {
            const clientPathEscaped = this.clientPath.replace(/\\/g, '\\\\');

            try {
              logger.debug('Terminating Java processes by client path', {
                category: 'client',
                data: {
                  service: 'MinecraftLauncher',
                  operation: 'terminateByPath',
                  clientPath: path.basename(this.clientPath)
                }
              });

              // Kill only Java processes with our client path in the command line
              await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='java.exe'" call terminate`, {
                windowsHide: true,
                timeout: 5000
              });

              await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='javaw.exe'" call terminate`, {
                windowsHide: true,
                timeout: 5000
              });

              stopped = true;

              logger.info('Java processes terminated by client path', {
                category: 'client',
                data: {
                  service: 'MinecraftLauncher',
                  operation: 'terminateByPath',
                  success: true
                }
              });

            } catch (pathError) {
              logger.warn(`Failed to terminate by path, trying PID: ${pathError.message}`, {
                category: 'client',
                data: {
                  service: 'MinecraftLauncher',
                  operation: 'terminateByPath',
                  errorType: pathError.constructor.name
                }
              });

              if (this.client && this.client.child && this.client.child.pid) {
                try {
                  await execAsync(`taskkill /F /PID ${this.client.child.pid}`, { windowsHide: true });
                  stopped = true;

                  logger.info('Process terminated by PID', {
                    category: 'client',
                    data: {
                      service: 'MinecraftLauncher',
                      operation: 'terminateByPid',
                      pid: this.client.child.pid,
                      success: true
                    }
                  });
                } catch (pidError) {
                  logger.error(`Failed to terminate by PID: ${pidError.message}`, {
                    category: 'client',
                    data: {
                      service: 'MinecraftLauncher',
                      operation: 'terminateByPid',
                      pid: this.client.child.pid,
                      errorType: pidError.constructor.name
                    }
                  });
                }
              }
            }
          }

        } catch {
          // TODO: Add proper logging - Failed to kill Java processes
        }
      }

      // Reset launcher state
      this.isLaunching = false;
      this.client = null;
      this.emit('minecraft-stopped');

      if (stopped) {
        logger.info('Minecraft stopped successfully', {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'stopMinecraft',
            success: true,
            stopped: true
          }
        });
        return { success: true, message: 'Minecraft stopped successfully' };
      } else {
        logger.info('Minecraft process cleanup completed (no active process found)', {
          category: 'client',
          data: {
            service: 'MinecraftLauncher',
            operation: 'stopMinecraft',
            success: true,
            stopped: false,
            reason: 'no_active_process'
          }
        });
        return { success: true, message: 'Minecraft process cleanup completed (no active process found)' };
      }

    } catch (error) {
      logger.error(`Failed to stop Minecraft: ${error.message}`, {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'stopMinecraft',
          errorType: error.constructor.name,
          errorStack: error.stack
        }
      });

      // Reset state even on error
      this.isLaunching = false;
      this.client = null;
      this.emit('minecraft-stopped');
      return { success: false, error: error.message };
    }
  }

  // Calculate file checksum for mod verification - MOVED to utils.cjs
  // calculateFileChecksum(filePath) { ... }

  // Get launcher status
  getStatus() {
    logger.debug('Getting launcher status', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'getStatus',
        isLaunching: this.isLaunching,
        hasClient: !!this.client,
        hasChildProcess: !!(this.client && this.client.child)
      }
    });

    let isRunning = false;

    // Check if we actually have a running process
    if (this.client && this.client.child) {
      try {
        // Check if the process is still alive
        const pid = this.client.child.pid;
        if (pid) {
          // On Windows, we can check if the process exists
          try {
            process.kill(pid, 0); // Signal 0 just tests if process exists
            isRunning = true;

            logger.debug('Process status check: running', {
              category: 'client',
              data: {
                service: 'MinecraftLauncher',
                operation: 'processStatusCheck',
                pid,
                isRunning: true
              }
            });
          } catch {
            // Process doesn't exist anymore
            logger.debug('Process status check: not running', {
              category: 'client',
              data: {
                service: 'MinecraftLauncher',
                operation: 'processStatusCheck',
                pid,
                isRunning: false,
                reason: 'process_not_found'
              }
            });

            this.isLaunching = false;
            this.client = null;
            isRunning = false;
          }
        }
      } catch {
        isRunning = false;
      }
    }

    const status = {
      isAuthenticated: !!this.authHandler.authData, // Changed to this.authHandler.authData
      isLaunching: this.isLaunching,
      isRunning: isRunning,
      username: this.authHandler.authData?.name || null, // Changed to this.authHandler.authData
      clientPath: this.clientPath
    };

    logger.debug('Launcher status retrieved', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'getStatus',
        isAuthenticated: status.isAuthenticated,
        isLaunching: status.isLaunching,
        isRunning: status.isRunning,
        hasUsername: !!status.username,
        hasClientPath: !!status.clientPath
      }
    });

    return status;
  }

  // Check if Minecraft client files are present and up to date
  async checkMinecraftClient(clientPath, requiredVersion, options = {}) {
    logger.debug('Checking Minecraft client files', {
      category: 'client',
      data: {
        service: 'MinecraftLauncher',
        operation: 'checkMinecraftClient',
        requiredVersion,
        clientPath: clientPath ? path.basename(clientPath) : null,
        options: Object.keys(options)
      }
    });

    try {
      const result = await this.clientDownloader.checkMinecraftClient(clientPath, requiredVersion, options);

      logger.info('Minecraft client check completed', {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'checkMinecraftClient',
          requiredVersion,
          success: result.success,
          upToDate: result.upToDate,
          missingFiles: result.missingFiles || 0
        }
      });

      return result;
    } catch (error) {
      logger.error(`Minecraft client check failed: ${error.message}`, {
        category: 'client',
        data: {
          service: 'MinecraftLauncher',
          operation: 'checkMinecraftClient',
          requiredVersion,
          errorType: error.constructor.name,
          clientPath: clientPath ? path.basename(clientPath) : null
        }
      });
      throw error;
    }
  }

  // Clear Minecraft client files for re-download (smart repair - only core files)
  async clearMinecraftClient(clientPath, minecraftVersion) {
    logger.info('Clearing Minecraft client files (smart repair)', {
      category: 'storage',
      data: {
        service: 'MinecraftLauncher',
        operation: 'clearMinecraftClient',
        minecraftVersion,
        clientPath: clientPath ? path.basename(clientPath) : null,
        repairType: 'smart'
      }
    });

    try {
      const result = await this.clientDownloader.clearMinecraftClient(clientPath, minecraftVersion);

      logger.info('Minecraft client files cleared successfully', {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'clearMinecraftClient',
          minecraftVersion,
          success: result.success,
          filesRemoved: result.filesRemoved || 0
        }
      });

      return result;
    } catch (error) {
      logger.error(`Failed to clear Minecraft client files: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'clearMinecraftClient',
          minecraftVersion,
          errorType: error.constructor.name,
          clientPath: clientPath ? path.basename(clientPath) : null
        }
      });
      throw error;
    }
  }

  // Full clear - removes EVERYTHING including libraries and assets
  async clearMinecraftClientFull(clientPath, minecraftVersion) {
    logger.warn('Clearing Minecraft client files (full clear)', {
      category: 'storage',
      data: {
        service: 'MinecraftLauncher',
        operation: 'clearMinecraftClientFull',
        minecraftVersion,
        clientPath: clientPath ? path.basename(clientPath) : null,
        repairType: 'full',
        warning: 'removes_everything'
      }
    });

    try {
      const result = await this.clientDownloader.clearMinecraftClientFull(clientPath, minecraftVersion);

      logger.info('Minecraft client files fully cleared', {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'clearMinecraftClientFull',
          minecraftVersion,
          success: result.success,
          filesRemoved: result.filesRemoved || 0,
          includedLibraries: true,
          includedAssets: true
        }
      });

      return result;
    } catch (error) {
      logger.error(`Failed to fully clear Minecraft client files: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'MinecraftLauncher',
          operation: 'clearMinecraftClientFull',
          minecraftVersion,
          errorType: error.constructor.name,
          clientPath: clientPath ? path.basename(clientPath) : null
        }
      });
      throw error;
    }
  }

  // Force clear just assets directory - useful when assets are corrupted
  async clearAssets(clientPath) {
    // Use the active downloader (XMCL now has this method)
    return this.clientDownloader.clearAssets(clientPath);
  }

  // Inject vanilla downloads.client and merge vanilla libraries into Fabric profile
  async injectVanillaDownloadsAndLibraries(clientPath, profileName, vanillaVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      const fabricJsonPath = path.join(versionsDir, profileName, `${profileName}.json`);
      const vanillaJsonPath = path.join(versionsDir, vanillaVersion, `${vanillaVersion}.json`);

      if (!fs.existsSync(fabricJsonPath)) {
        throw new Error(`Fabric profile not found: ${fabricJsonPath}`);
      }

      if (!fs.existsSync(vanillaJsonPath)) {
        throw new Error(`Vanilla version not found: ${vanillaJsonPath}`);
      }

      const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
      const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));


      // 1) Inject downloads.client if missing
      fabricJson.downloads = fabricJson.downloads || {};
      if (!fabricJson.downloads.client && vanillaJson.downloads?.client) {
        fabricJson.downloads.client = vanillaJson.downloads.client;
      }

      // 1a) Inject vanilla asset index & asset downloads for sounds and textures
      if (vanillaJson.assetIndex && !fabricJson.assetIndex) {
        fabricJson.assetIndex = vanillaJson.assetIndex;
      }

      if (vanillaJson.downloads?.assets && !fabricJson.downloads.assets) {
        fabricJson.downloads.assets = vanillaJson.downloads.assets;
      }

      // 2) Merge vanilla libraries *except* ASM to avoid conflicts
      if (Array.isArray(vanillaJson.libraries) && vanillaJson.libraries.length > 0) {
        // Initialize Fabric libraries array if it doesn't exist
        fabricJson.libraries = fabricJson.libraries || [];

        // Function to detect ASM libraries that should be skipped
        const skipASM = lib => {
          if (!lib.name) return false;
          // Skip ASM libraries since Fabric provides its own version
          return /^org\.ow2\.asm:asm(?:-|$)/.test(lib.name);
        };

        // Create a set of existing library names to avoid duplicates
        const existing = new Set(fabricJson.libraries.map(lib => lib.name).filter(Boolean));

        // Filter vanilla libraries to exclude ASM and duplicates
        const toInject = (vanillaJson.libraries || [])
          .filter(lib => {
            // Must have a name
            if (!lib.name) return false;

            // Skip ASM libraries
            if (skipASM(lib)) {
              return false;
            }

            // Skip if already exists
            if (existing.has(lib.name)) {
              return false;
            }

            // Add to existing set to prevent future duplicates
            existing.add(lib.name);
            return true;
          })
          .map(vanillaLib => {
            // CRITICAL FIX: Copy natives metadata from vanilla libraries
            // This ensures LWJGL and other native libraries have proper download metadata
            const libCopy = { ...vanillaLib };

            // If vanillaLib had a "natives" block, copy it verbatim
            if (vanillaLib.natives) {
              libCopy.natives = { ...vanillaLib.natives };
            }

            // If vanillaLib already had download metadata for classifiers, copy it too
            if (vanillaLib.downloads && vanillaLib.downloads.classifiers) {
              libCopy.downloads = libCopy.downloads || {};
              libCopy.downloads.classifiers = { ...vanillaLib.downloads.classifiers };
            }

            return libCopy;
          });

        // Merge vanilla libraries at the front of the array
        fabricJson.libraries = [...toInject, ...fabricJson.libraries];

        // 3) Explicit ASM cleanup - remove ALL ASM versions except Fabric's 9.8
        fabricJson.libraries = fabricJson.libraries.filter(lib => {
          // If it's not an ASM library, keep it
          if (!lib.name?.startsWith('org.ow2.asm:asm:')) return true;
          // If it's ASM, only keep version 9.8.x (Fabric's version)
          const keepASM = /^org\.ow2\.asm:asm:9\.8/.test(lib.name);
          return keepASM;
        });

      }

      // 5) Ensure proper inheritance and type for MCLC
      fabricJson.inheritsFrom = fabricJson.inheritsFrom || vanillaVersion;
      fabricJson.type = fabricJson.type || 'release';

      // Write the updated Fabric profile
      fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2), 'utf8');

      return { success: true };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Validate session token against Mojang's servers (from debugging guide)
  async validateSessionToken(accessToken, uuid) {
    try {
      const fetch = require('node-fetch');

      const payload = {
        accessToken: accessToken,
        selectedProfile: uuid,
        serverId: ""  // empty string means "just validate token"
      };

      const response = await fetch('https://sessionserver.mojang.com/session/minecraft/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 10000
      });

      if (response.status === 204) {
        return true;
      }
      await response.text();
      return false;
    } catch {
      return false;
    }
  }

  // Validate Fabric version.json for authentication placeholders (from debugging guide)
  async verifyAndRepairLibraries(clientPath, fabricProfileName, vanillaVersion) {
    try {

      const versionsDir = path.join(clientPath, 'versions');
      const fabricJsonPath = path.join(versionsDir, fabricProfileName, `${fabricProfileName}.json`);
      const vanillaJsonPath = path.join(versionsDir, vanillaVersion, `${vanillaVersion}.json`);

      if (!fs.existsSync(fabricJsonPath)) {
        throw new Error(`Fabric profile JSON not found: ${fabricJsonPath}`);
      }

      const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));

      // List of critical libraries that must be present for Minecraft to launch
      const criticalLibraries = [
        'net.sf.jopt-simple:jopt-simple',
        'com.mojang:brigadier',
        'com.mojang:authlib',
        'com.mojang:datafixerupper',
        'com.google.guava:guava',
        'org.apache.commons:commons-lang3'
      ];

      const missingLibraries = [];
      const presentLibraries = [];

      // Check which critical libraries are missing from the Fabric profile
      for (const requiredLib of criticalLibraries) {
        const found = fabricJson.libraries?.find(lib => lib.name?.startsWith(requiredLib));
        if (found) {
          // Verify the actual JAR file exists
          const parts = found.name.split(':');
          if (parts.length >= 3) {
            const groupPath = parts[0].replace(/\./g, '/');
            const artifact = parts[1];
            const version = parts[2];
            const libFileName = `${artifact}-${version}.jar`;
            const libPath = path.join(clientPath, 'libraries', groupPath, artifact, version, libFileName);

            if (fs.existsSync(libPath)) {
              presentLibraries.push(found.name);
            } else {
              missingLibraries.push(requiredLib);
            }
          }
        } else {
          missingLibraries.push(requiredLib);
        }
      }

      if (missingLibraries.length === 0) {
        return { success: true, message: `All critical libraries present` };
      }


      // Try to repair by merging vanilla libraries if vanilla profile exists
      if (fs.existsSync(vanillaJsonPath)) {

        const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
        let repairedCount = 0;

        if (vanillaJson.libraries && Array.isArray(vanillaJson.libraries)) {
          // Create a map of existing Fabric libraries to avoid duplicates
          const fabricLibNames = new Set(fabricJson.libraries?.map(lib => lib.name) || []);

          // Find missing libraries in vanilla profile
          for (const missingLib of missingLibraries) {
            const vanillaLib = vanillaJson.libraries.find(lib => lib.name?.startsWith(missingLib));
            if (vanillaLib && !fabricLibNames.has(vanillaLib.name)) {
              fabricJson.libraries = fabricJson.libraries || [];
              fabricJson.libraries.unshift(vanillaLib); // Add at beginning for priority
              fabricLibNames.add(vanillaLib.name);
              repairedCount++;
            }
          }

          if (repairedCount > 0) {
            // Save the updated Fabric profile
            fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2), 'utf8');

            // Re-verify after repair
            const stillMissing = [];
            for (const requiredLib of criticalLibraries) {
              const found = fabricJson.libraries.find(lib => lib.name?.startsWith(requiredLib));
              if (!found) {
                stillMissing.push(requiredLib);
              }
            }

            if (stillMissing.length === 0) {
              return { success: true, message: `Successfully repaired ${repairedCount} missing libraries` };
            } else {
              return {
                success: false,
                error: `Still missing ${stillMissing.length} libraries after repair: ${stillMissing.join(', ')}`,
                stillMissing: stillMissing
              };
            }
          } else {
            return {
              success: false,
              error: `Could not find ${missingLibraries.length} missing libraries in vanilla profile`,
              missingLibraries: missingLibraries
            };
          }
        } else {
          return {
            success: false,
            error: `Vanilla profile has no libraries to merge`,
            missingLibraries: missingLibraries
          };
        }
      } else {
        return {
          success: false,
          error: `Vanilla profile not found for library repair: ${vanillaJsonPath}`,
          missingLibraries: missingLibraries
        };
      }

    } catch (error) {
      return {
        success: false,
        error: `Library verification error: ${error.message}`
      };
    }
  }

  validateFabricProfile(clientPath, profileName) {
    try {
      const profilePath = path.join(clientPath, 'versions', profileName, `${profileName}.json`);

      if (!fs.existsSync(profilePath)) {
        return false;
      }

      const profileJson = JSON.parse(fs.readFileSync(profilePath, 'utf8'));


      // Check for required authentication placeholders in game arguments
      const gameArgs = profileJson.arguments?.game || [];
      const requiredPlaceholders = [
        '${auth_player_name}',
        '${auth_uuid}',
        '${auth_access_token}',
        '${auth_user_type}'
      ];

      const missingPlaceholders = [];
      requiredPlaceholders.forEach(placeholder => {
        const found = gameArgs.some(arg =>
          typeof arg === 'string' && arg.includes(placeholder)
        );
        if (!found) {
          missingPlaceholders.push(placeholder);
        }
      });

      if (missingPlaceholders.length > 0) {
        // Don't fail validation - let the enrichment process fix this
        return true;
      }
      return true;

    } catch {
      return false;
    }
  }

  // New method: Use proper launcher for LogUtils fix
  async launchMinecraftProper(options) {
    try {

      // Set authentication data
      if (this.authHandler.authData) {
        this.properLauncher.setAuthData(this.authHandler.authData);
      } else {
        throw new Error('No authentication data available. Please authenticate first.');
      }

      // Forward the call to the proper launcher
      const result = await this.properLauncher.launchMinecraft(options);

      // Update our state to match
      if (result.success) {
        this.isLaunching = this.properLauncher.isLaunching;
        this.client = this.properLauncher.client;
        this.clientPath = options.clientPath;

        // Forward events
        this.properLauncher.on('minecraft-stopped', () => {
          this.emit('minecraft-stopped');
        });
      }

      return result;

    } catch (error) {
      return {
        success: false, error: error.message,
        message: `Failed to launch with proper launcher: ${error.message}`
      };
    }
  }

  /**
   * Enable XMCL downloader for testing
   * This can be called to switch to the new @xmcl/installer implementation
   */
  enableXMCLDownloader(enable = true) {
    this.useXMCLDownloader = enable;
    this.clientDownloader = this.useXMCLDownloader ?
      this.xmclClientDownloader : this.legacyClientDownloader;
    // TODO: Add proper logging - Switched client downloader
  }

  /**
   * Get current downloader status
   */
  getDownloaderStatus() {
    return {
      usingXMCL: this.useXMCLDownloader,
      currentDownloader: this.useXMCLDownloader ? 'XMCL' : 'Legacy'
    };
  }
}

// Singleton instance
let launcherInstance = null;

function getMinecraftLauncher() {
  if (!launcherInstance) {
    launcherInstance = new MinecraftLauncher();
  }
  return launcherInstance;
}

module.exports = {
  MinecraftLauncher,
  getMinecraftLauncher
};
