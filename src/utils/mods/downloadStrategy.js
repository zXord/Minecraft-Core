/**
 * Download strategy manager with retry logic and fallback support
 */
/// <reference path="../../electron.d.ts" />
import { ChecksumValidator } from './checksumValidator.js';
import { globalErrorLogger } from './downloadErrorLogger.js';
import logger from '../logger.js';

// Download states enum
export const DOWNLOAD_STATES = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  RETRYING: 'retrying',
  FALLBACK: 'fallback',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Download sources enum
export const DOWNLOAD_SOURCES = {
  SERVER: 'server',
  MODRINTH: 'modrinth',
  CURSEFORGE: 'curseforge'
};

/**
 * Download strategy class that handles retry logic and fallback mechanisms
 */
export class DownloadStrategy {
  /**
   * Create a new download strategy
   * @param {Object} mod - Mod information
   * @param {Object} [options] - Strategy options
   * @param {number} [options.maxRetries] - Maximum retry attempts (default: 3)
   * @param {number} [options.fallbackDelay] - Delay before fallback in ms (default: 15 minutes)
   * @param {number} [options.initialRetryDelay] - Initial retry delay in ms (default: 1000)
   * @param {Function} [options.progressCallback] - Progress update callback
   * @param {Function} [options.stateCallback] - State change callback
   */
  constructor(mod, options = {}) {
    this.mod = mod;
    this.maxRetries = options.maxRetries || 3;
    this.fallbackDelay = options.fallbackDelay || 15 * 60 * 1000; // 15 minutes
    this.initialRetryDelay = options.initialRetryDelay || 1000;
    this.progressCallback = options.progressCallback || (() => { });
    this.stateCallback = options.stateCallback || (() => { });

    // State tracking
    this.currentAttempt = 0;
    this.fallbackTriggered = false;
    this.currentSource = DOWNLOAD_SOURCES.SERVER;
    this.lastAttemptedSource = null;
    this.totalAttempts = 0;
    this.checksumErrors = [];
    this.networkErrors = [];
    this.startTime = Date.now();
    this.fallbackStartTime = null;

    logger.info('Download strategy created', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.constructor',
        modName: mod?.name || 'unknown',
        modId: mod?.id || 'unknown',
        maxRetries: this.maxRetries,
        fallbackDelay: this.fallbackDelay,
        initialRetryDelay: this.initialRetryDelay
      }
    });
  }

  /**
   * Execute the download strategy
   * @returns {Promise<Object>} Download result
   */
  async execute() {
    const startTime = Date.now();

    logger.info('Starting download strategy execution', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.execute',
        modName: this.mod?.name || 'unknown',
        modId: this.mod?.id || 'unknown',
        startTime
      }
    });

    try {
      this._updateState(DOWNLOAD_STATES.QUEUED, 'Queued for download...');

      // Try server download first
      const serverResult = await this.tryServerDownload();
      if (serverResult.success) {
        const duration = Date.now() - startTime;

        logger.info('Download strategy completed successfully via server', {
          category: 'mods',
          data: {
            function: 'DownloadStrategy.execute',
            modName: this.mod?.name || 'unknown',
            source: 'server',
            totalAttempts: this.totalAttempts,
            duration
          }
        });

        return serverResult;
      }

      // Check if fallback should be triggered and wait for fallback delay
      if (this.shouldTriggerFallback()) {
        await this.waitForFallback();
        const fallbackResult = await this.tryFallbackDownload();

        const duration = Date.now() - startTime;

        if (fallbackResult.success) {
          logger.info('Download strategy completed successfully via fallback', {
            category: 'mods',
            data: {
              function: 'DownloadStrategy.execute',
              modName: this.mod?.name || 'unknown',
              source: fallbackResult.source,
              totalAttempts: this.totalAttempts,
              duration
            }
          });
        } else {
          logger.error('Download strategy failed on all sources', {
            category: 'mods',
            data: {
              function: 'DownloadStrategy.execute',
              modName: this.mod?.name || 'unknown',
              totalAttempts: this.totalAttempts,
              checksumErrors: this.checksumErrors.length,
              networkErrors: this.networkErrors.length,
              duration
            }
          });
        }

        return fallbackResult;
      } else {
        // No fallback needed, return server failure
        const duration = Date.now() - startTime;

        logger.info('Fallback not triggered, returning server failure', {
          category: 'mods',
          data: {
            function: 'DownloadStrategy.execute',
            modName: this.mod?.name || 'unknown',
            reason: 'fallback_conditions_not_met',
            duration
          }
        });

        return serverResult;
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(`Download strategy execution failed: ${error.message}`, {
        category: 'mods',
        data: {
          function: 'DownloadStrategy.execute',
          modName: this.mod?.name || 'unknown',
          errorType: error.constructor.name,
          totalAttempts: this.totalAttempts,
          duration
        }
      });

      this._updateState(DOWNLOAD_STATES.FAILED, `Download failed: ${error.message}`);

      return {
        success: false,
        source: this.currentSource,
        error: error.message,
        attempts: this.totalAttempts,
        checksumErrors: this.checksumErrors,
        networkErrors: this.networkErrors
      };
    }
  }

  /**
   * Try downloading from server with retry logic
   * @returns {Promise<Object>} Download result
   */
  async tryServerDownload() {
    logger.info('Starting server download attempts', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.tryServerDownload',
        modName: this.mod?.name || 'unknown',
        maxRetries: this.maxRetries
      }
    });

    this.currentSource = DOWNLOAD_SOURCES.SERVER;
    this.lastAttemptedSource = DOWNLOAD_SOURCES.SERVER;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      this.currentAttempt = attempt;
      this.totalAttempts++;

      try {
        this._updateState(
          attempt === 1 ? DOWNLOAD_STATES.DOWNLOADING : DOWNLOAD_STATES.RETRYING,
          attempt === 1 ? 'Downloading from server...' : `Retrying download (attempt ${attempt}/${this.maxRetries})...`
        );

        logger.debug('Attempting server download', {
          category: 'mods',
          data: {
            function: 'DownloadStrategy.tryServerDownload',
            modName: this.mod?.name || 'unknown',
            attempt,
            maxRetries: this.maxRetries,
            totalAttempts: this.totalAttempts
          }
        });

        const result = await this.downloadFromServer();

        // Validate download if checksum is available
        if (result.filePath && this.mod.expectedChecksum) {
          this._updateState(DOWNLOAD_STATES.VERIFYING, 'Verifying file integrity...');

          const validation = await this.validateDownload(result.filePath);

          if (validation.isValid) {
            logger.info('Server download completed successfully with valid checksum', {
              category: 'mods',
              data: {
                function: 'DownloadStrategy.tryServerDownload',
                modName: this.mod?.name || 'unknown',
                attempt,
                totalAttempts: this.totalAttempts,
                checksumAlgorithm: validation.algorithm
              }
            });

            this._updateState(DOWNLOAD_STATES.COMPLETED, 'Download completed successfully');
            return { success: true, source: DOWNLOAD_SOURCES.SERVER, ...result, validation };
          } else {
            this.logChecksumError(validation, attempt);
            if (attempt < this.maxRetries) {
              await this.delay(this.calculateRetryDelay(attempt));
            }
          }
        } else {
          // No checksum validation needed or available
          logger.info('Server download completed successfully (no checksum validation)', {
            category: 'mods',
            data: {
              function: 'DownloadStrategy.tryServerDownload',
              modName: this.mod?.name || 'unknown',
              attempt,
              totalAttempts: this.totalAttempts,
              hasChecksum: !!this.mod.expectedChecksum
            }
          });

          this._updateState(DOWNLOAD_STATES.COMPLETED, 'Download completed successfully');
          return { success: true, source: DOWNLOAD_SOURCES.SERVER, ...result };
        }
      } catch (error) {
        this.logDownloadError(error, DOWNLOAD_SOURCES.SERVER, attempt);
        if (attempt < this.maxRetries) {
          await this.delay(this.calculateRetryDelay(attempt));
        }
      }
    }

    logger.warn('All server download attempts failed', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.tryServerDownload',
        modName: this.mod?.name || 'unknown',
        totalAttempts: this.maxRetries,
        checksumErrors: this.checksumErrors.length,
        networkErrors: this.networkErrors.length
      }
    });

    return { success: false, source: DOWNLOAD_SOURCES.SERVER };
  }

  /**
   * Check if fallback should be triggered based on error conditions
   * @returns {boolean} True if fallback should be triggered
   */
  shouldTriggerFallback() {
    // Check if we have sufficient errors to justify fallback
    const totalErrors = this.checksumErrors.length + this.networkErrors.length;
    const hasRepeatedChecksumErrors = this.checksumErrors.length >= 2;
    const hasNetworkErrors = this.networkErrors.length > 0;
    const hasServerErrors = this.networkErrors.some(error =>
      error.type === 'server_error' || error.type === 'timeout'
    );

    logger.debug('Evaluating fallback trigger conditions', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.shouldTriggerFallback',
        modName: this.mod?.name || 'unknown',
        totalErrors,
        checksumErrors: this.checksumErrors.length,
        networkErrors: this.networkErrors.length,
        hasRepeatedChecksumErrors,
        hasNetworkErrors,
        hasServerErrors,
        maxRetries: this.maxRetries
      }
    });

    // Trigger fallback if:
    // 1. We have repeated checksum errors (indicates server-side file corruption)
    // 2. We have server errors or timeouts
    // 3. We've exhausted all retry attempts with any errors
    const shouldTrigger = hasRepeatedChecksumErrors || hasServerErrors ||
      (totalErrors > 0 && this.currentAttempt >= this.maxRetries);

    if (shouldTrigger) {
      logger.info('Fallback trigger conditions met', {
        category: 'mods',
        data: {
          function: 'DownloadStrategy.shouldTriggerFallback',
          modName: this.mod?.name || 'unknown',
          reason: hasRepeatedChecksumErrors ? 'repeated_checksum_errors' :
            hasServerErrors ? 'server_errors' : 'max_retries_exhausted',
          totalErrors,
          currentAttempt: this.currentAttempt
        }
      });
    }

    return shouldTrigger;
  }

  /**
   * Wait for fallback delay with progress updates
   * @returns {Promise<void>}
   */
  async waitForFallback() {
    if (this.fallbackDelay <= 0) {
      logger.debug('Skipping fallback delay (delay is 0)', {
        category: 'mods',
        data: {
          function: 'DownloadStrategy.waitForFallback',
          modName: this.mod?.name || 'unknown',
          fallbackDelay: this.fallbackDelay
        }
      });
      return;
    }

    this.fallbackStartTime = Date.now();
    const endTime = this.fallbackStartTime + this.fallbackDelay;

    logger.info('Starting fallback delay countdown', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.waitForFallback',
        modName: this.mod?.name || 'unknown',
        fallbackDelay: this.fallbackDelay,
        fallbackDelayMinutes: Math.round(this.fallbackDelay / 60000),
        fallbackStartTime: this.fallbackStartTime,
        endTime
      }
    });

    // Update progress every 30 seconds during fallback wait
    const updateInterval = 30000; // 30 seconds
    let updateCount = 0;

    while (Date.now() < endTime) {
      const remaining = endTime - Date.now();
      const remainingMinutes = Math.ceil(remaining / 60000);
      const remainingSeconds = Math.ceil(remaining / 1000);

      // Provide more detailed countdown for shorter remaining times
      let countdownMessage;
      if (remainingMinutes > 1) {
        countdownMessage = `Trying alternative source in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}...`;
      } else if (remainingSeconds > 60) {
        countdownMessage = `Trying alternative source in 1 minute...`;
      } else if (remainingSeconds > 10) {
        countdownMessage = `Trying alternative source in ${remainingSeconds} seconds...`;
      } else {
        countdownMessage = `Preparing alternative source...`;
      }

      this._updateState(
        DOWNLOAD_STATES.FALLBACK,
        countdownMessage,
        {
          fallbackCountdown: remaining,
          fallbackCountdownMinutes: remainingMinutes,
          fallbackCountdownSeconds: remainingSeconds
        }
      );

      const waitTime = Math.min(updateInterval, remaining);
      if (waitTime > 0) {
        await this.delay(waitTime);
        updateCount++;

        // Log periodic updates during long waits
        if (updateCount % 2 === 0) { // Every minute
          logger.debug('Fallback countdown progress', {
            category: 'mods',
            data: {
              function: 'DownloadStrategy.waitForFallback',
              modName: this.mod?.name || 'unknown',
              remainingMinutes,
              remainingSeconds,
              updateCount
            }
          });
        }
      }
    }

    logger.info('Fallback delay completed', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.waitForFallback',
        modName: this.mod?.name || 'unknown',
        actualDelay: Date.now() - this.fallbackStartTime,
        plannedDelay: this.fallbackDelay,
        updateCount
      }
    });
  }

  /**
   * Try downloading from fallback source with multiple source attempts
   * @returns {Promise<Object>} Download result
   */
  async tryFallbackDownload() {
    this.fallbackTriggered = true;

    // Get list of potential fallback sources in priority order
    const fallbackSources = this.getFallbackSourcePriority();

    logger.info('Starting fallback download with multiple sources', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.tryFallbackDownload',
        modName: this.mod?.name || 'unknown',
        fallbackSources,
        sourceCount: fallbackSources.length
      }
    });

    // Try each fallback source in order
    for (let i = 0; i < fallbackSources.length; i++) {
      const fallbackSource = fallbackSources[i];
      this.currentSource = fallbackSource;
      this.lastAttemptedSource = fallbackSource;

      logger.info(`Attempting fallback source ${i + 1}/${fallbackSources.length}`, {
        category: 'mods',
        data: {
          function: 'DownloadStrategy.tryFallbackDownload',
          modName: this.mod?.name || 'unknown',
          fallbackSource,
          attemptNumber: i + 1,
          totalSources: fallbackSources.length
        }
      });

      try {
        this._updateState(
          DOWNLOAD_STATES.DOWNLOADING,
          `Downloading from ${fallbackSource}${fallbackSources.length > 1 ? ` (${i + 1}/${fallbackSources.length})` : ''}...`
        );

        const result = await this.downloadFromFallbackSource(fallbackSource);

        // Validate download if checksum is available
        if (result.filePath && this.mod.expectedChecksum) {
          this._updateState(DOWNLOAD_STATES.VERIFYING, 'Verifying file integrity...');

          const validation = await this.validateDownload(result.filePath);

          if (validation.isValid) {
            logger.info('Fallback download completed successfully with valid checksum', {
              category: 'mods',
              data: {
                function: 'DownloadStrategy.tryFallbackDownload',
                modName: this.mod?.name || 'unknown',
                fallbackSource,
                attemptNumber: i + 1,
                checksumAlgorithm: validation.algorithm
              }
            });

            this._updateState(DOWNLOAD_STATES.COMPLETED, 'Download completed successfully');
            return { success: true, source: fallbackSource, ...result, validation };
          } else {
            this.logChecksumError(validation, 1, fallbackSource);
            logger.warn('Fallback source checksum validation failed, trying next source', {
              category: 'mods',
              data: {
                function: 'DownloadStrategy.tryFallbackDownload',
                modName: this.mod?.name || 'unknown',
                fallbackSource,
                attemptNumber: i + 1,
                hasMoreSources: i < fallbackSources.length - 1
              }
            });
            continue; // Try next source
          }
        } else {
          // No checksum validation needed or available
          logger.info('Fallback download completed successfully (no checksum validation)', {
            category: 'mods',
            data: {
              function: 'DownloadStrategy.tryFallbackDownload',
              modName: this.mod?.name || 'unknown',
              fallbackSource,
              attemptNumber: i + 1,
              hasChecksum: !!this.mod.expectedChecksum
            }
          });

          this._updateState(DOWNLOAD_STATES.COMPLETED, 'Download completed successfully');
          return { success: true, source: fallbackSource, ...result };
        }
      } catch (error) {
        this.logDownloadError(error, fallbackSource, 1);
        logger.warn('Fallback source failed, trying next source', {
          category: 'mods',
          data: {
            function: 'DownloadStrategy.tryFallbackDownload',
            modName: this.mod?.name || 'unknown',
            fallbackSource,
            attemptNumber: i + 1,
            error: error.message,
            hasMoreSources: i < fallbackSources.length - 1
          }
        });
        continue; // Try next source
      }
    }

    logger.error('All fallback sources failed', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.tryFallbackDownload',
        modName: this.mod?.name || 'unknown',
        triedSources: fallbackSources,
        totalAttempts: fallbackSources.length
      }
    });

    this._updateState(DOWNLOAD_STATES.FAILED, 'All download sources failed');
    return { success: false, source: this.currentSource };
  }

  /**
   * Get fallback sources in priority order
   * @returns {Array<string>} Array of fallback sources in priority order
   */
  getFallbackSourcePriority() {
    const sources = [];

    // First priority: original source if specified
    if (this.mod.originalSource &&
      this.mod.originalSource !== DOWNLOAD_SOURCES.SERVER) {
      sources.push(this.mod.originalSource);
    }

    // Second priority: Modrinth if we have identifiers
    if (this.mod.projectId || this.mod.modrinthId) {
      if (!sources.includes(DOWNLOAD_SOURCES.MODRINTH)) {
        sources.push(DOWNLOAD_SOURCES.MODRINTH);
      }
    }

    // Third priority: CurseForge if we have identifiers
    if (this.mod.curseforgeId) {
      if (!sources.includes(DOWNLOAD_SOURCES.CURSEFORGE)) {
        sources.push(DOWNLOAD_SOURCES.CURSEFORGE);
      }
    }

    // Fallback: Add Modrinth if not already included (most mods are available there)
    if (!sources.includes(DOWNLOAD_SOURCES.MODRINTH)) {
      sources.push(DOWNLOAD_SOURCES.MODRINTH);
    }

    logger.debug('Determined fallback source priority', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.getFallbackSourcePriority',
        modName: this.mod?.name || 'unknown',
        sources,
        originalSource: this.mod?.originalSource,
        hasProjectId: !!this.mod?.projectId,
        hasModrinthId: !!this.mod?.modrinthId,
        hasCurseforgeId: !!this.mod?.curseforgeId
      }
    });

    return sources;
  }

  /**
   * Download from server
   * @returns {Promise<Object>} Download result
   */
  async downloadFromServer() {
    if (!window.electron || !window.electron.invoke) {
      throw new Error('Electron IPC not available');
    }

    logger.debug('Invoking server download via IPC', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.downloadFromServer',
        modName: this.mod?.name || 'unknown',
        modId: this.mod?.id || 'unknown'
      }
    });

    const result = await window.electron.invoke('download-mod-from-server', {
      mod: this.mod,
      attempt: this.currentAttempt,
      totalAttempts: this.totalAttempts
    });

    return result;
  }

  /**
   * Download from fallback source
   * @param {string} source - Fallback source
   * @returns {Promise<Object>} Download result
   */
  async downloadFromFallbackSource(source) {
    if (!window.electron || !window.electron.invoke) {
      throw new Error('Electron IPC not available');
    }

    logger.debug('Invoking fallback download via IPC', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.downloadFromFallbackSource',
        modName: this.mod?.name || 'unknown',
        modId: this.mod?.id || 'unknown',
        source
      }
    });

    const result = await window.electron.invoke('download-mod-from-fallback', {
      mod: this.mod,
      source,
      attempt: 1,
      totalAttempts: this.totalAttempts
    });

    return result;
  }

  /**
   * Validate downloaded file
   * @param {string} filePath - Path to downloaded file
   * @returns {Promise<Object>} Validation result
   */
  async validateDownload(filePath) {
    if (!this.mod.expectedChecksum) {
      return { isValid: true, skipped: true };
    }

    logger.debug('Validating downloaded file', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.validateDownload',
        modName: this.mod?.name || 'unknown',
        filePath,
        expectedChecksum: this.mod.expectedChecksum,
        algorithm: this.mod.checksumAlgorithm || 'sha1'
      }
    });

    return await ChecksumValidator.validateFile(
      filePath,
      this.mod.expectedChecksum,
      this.mod.checksumAlgorithm || 'sha1'
    );
  }

  /**
   * Determine fallback source based on mod information
   * @returns {string} Fallback source
   */
  determineFallbackSource() {
    logger.debug('Determining fallback source', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.determineFallbackSource',
        modName: this.mod?.name || 'unknown',
        originalSource: this.mod?.originalSource,
        hasModrinthId: !!this.mod?.modrinthId,
        hasCurseforgeId: !!this.mod?.curseforgeId,
        hasProjectId: !!this.mod?.projectId
      }
    });

    // Prefer the original source if available
    if (this.mod.originalSource) {
      logger.info('Using original source for fallback', {
        category: 'mods',
        data: {
          function: 'DownloadStrategy.determineFallbackSource',
          modName: this.mod?.name || 'unknown',
          originalSource: this.mod.originalSource
        }
      });
      return this.mod.originalSource;
    }

    // Check for Modrinth identifiers (projectId is the primary identifier)
    if (this.mod.projectId || this.mod.modrinthId) {
      logger.info('Using Modrinth as fallback source', {
        category: 'mods',
        data: {
          function: 'DownloadStrategy.determineFallbackSource',
          modName: this.mod?.name || 'unknown',
          projectId: this.mod?.projectId,
          modrinthId: this.mod?.modrinthId
        }
      });
      return DOWNLOAD_SOURCES.MODRINTH;
    }

    // Check for CurseForge identifiers
    if (this.mod.curseforgeId) {
      logger.info('Using CurseForge as fallback source', {
        category: 'mods',
        data: {
          function: 'DownloadStrategy.determineFallbackSource',
          modName: this.mod?.name || 'unknown',
          curseforgeId: this.mod.curseforgeId
        }
      });
      return DOWNLOAD_SOURCES.CURSEFORGE;
    }

    // Default fallback to Modrinth
    logger.info('Using default Modrinth fallback source', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.determineFallbackSource',
        modName: this.mod?.name || 'unknown',
        reason: 'no_specific_identifiers'
      }
    });
    return DOWNLOAD_SOURCES.MODRINTH;
  }

  /**
   * Calculate retry delay with exponential backoff
   * @param {number} attempt - Current attempt number
   * @returns {number} Delay in milliseconds
   */
  calculateRetryDelay(attempt) {
    const delay = this.initialRetryDelay * Math.pow(2, attempt - 1);
    const maxDelay = 30000; // Cap at 30 seconds
    return Math.min(delay, maxDelay);
  }

  /**
   * Log checksum validation error
   * @param {Object} validation - Validation result
   * @param {number} attempt - Attempt number
   * @param {string} source - Download source
   */
  logChecksumError(validation, attempt, source = this.currentSource) {
    const error = {
      timestamp: Date.now(),
      source,
      attempt,
      type: 'checksum',
      expected: validation.expected,
      actual: validation.actual,
      algorithm: validation.algorithm
    };

    this.checksumErrors.push(error);

    // Log to enhanced error tracking system
    const downloadError = globalErrorLogger.logChecksumError(validation, {
      modId: this.mod?.id,
      modName: this.mod?.name,
      source,
      attempt,
      additionalData: {
        downloadId: this.mod?.downloadId,
        startTime: this.startTime,
        checksumAlgorithm: validation.algorithm,
        maxAttempts: this.maxRetries,
        totalAttempts: this.totalAttempts
      }
    });

    logger.error('Checksum validation failed', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.logChecksumError',
        modName: this.mod?.name || 'unknown',
        source,
        attempt,
        expected: validation.expected,
        actual: validation.actual,
        algorithm: validation.algorithm,
        errorId: downloadError?.id
      }
    });
  }

  /**
   * Log download error
   * @param {Error} error - Download error
   * @param {string} source - Download source
   * @param {number} attempt - Attempt number
   */
  logDownloadError(error, source, attempt) {
    const errorInfo = {
      timestamp: Date.now(),
      source,
      attempt,
      type: this.categorizeError(error),
      message: error.message,
      details: {
        errorType: error.constructor.name,
        stack: error.stack
      }
    };

    this.networkErrors.push(errorInfo);

    // Log to enhanced error tracking system
    const downloadError = globalErrorLogger.logError(error, {
      modId: this.mod?.id,
      modName: this.mod?.name,
      source,
      attempt,
      additionalData: {
        downloadId: this.mod?.downloadId,
        startTime: this.startTime,
        errorCategory: errorInfo.type,
        maxAttempts: this.maxRetries,
        totalAttempts: this.totalAttempts,
        networkDetails: {
          timeout: this.mod?.timeout,
          retryDelay: this.calculateRetryDelay(attempt)
        }
      }
    });

    logger.error(`Download attempt failed: ${error.message}`, {
      category: 'mods',
      data: {
        function: 'DownloadStrategy.logDownloadError',
        modName: this.mod?.name || 'unknown',
        source,
        attempt,
        errorType: error.constructor.name,
        errorCategory: errorInfo.type,
        errorId: downloadError?.id
      }
    });
  }

  /**
   * Categorize error type
   * @param {Error} error - Error to categorize
   * @returns {string} Error category
   */
  categorizeError(error) {
    const message = error.message.toLowerCase();

    if (message.includes('timeout') || message.includes('timed out')) {
      return 'timeout';
    }

    if (message.includes('network') || message.includes('connection')) {
      return 'network';
    }

    if (message.includes('404') || message.includes('not found')) {
      return 'not_found';
    }

    if (message.includes('403') || message.includes('forbidden')) {
      return 'forbidden';
    }

    if (message.includes('500') || message.includes('server error')) {
      return 'server_error';
    }

    return 'unknown';
  }

  /**
   * Delay execution
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update download state and notify callbacks
   * @param {string} state - New state
   * @param {string} message - Status message
   * @param {Object} additionalData - Additional data to include
   */
  _updateState(state, message, additionalData = {}) {
    const stateData = {
      state,
      statusMessage: message,
      source: this.currentSource,
      attempt: this.currentAttempt,
      maxAttempts: this.maxRetries,
      totalAttempts: this.totalAttempts,
      fallbackTriggered: this.fallbackTriggered,
      ...additionalData
    };

    logger.debug('Download state updated', {
      category: 'mods',
      data: {
        function: 'DownloadStrategy._updateState',
        modName: this.mod?.name || 'unknown',
        state,
        message,
        source: this.currentSource,
        attempt: this.currentAttempt
      }
    });

    // Notify state callback
    try {
      this.stateCallback(stateData);
    } catch (error) {
      logger.error(`State callback failed: ${error.message}`, {
        category: 'mods',
        data: {
          function: 'DownloadStrategy._updateState',
          modName: this.mod?.name || 'unknown',
          callbackError: error.constructor.name
        }
      });
    }
  }

  /**
   * Get current download statistics
   * @returns {Object} Download statistics
   */
  getStatistics() {
    return {
      totalAttempts: this.totalAttempts,
      currentAttempt: this.currentAttempt,
      maxRetries: this.maxRetries,
      currentSource: this.currentSource,
      lastAttemptedSource: this.lastAttemptedSource,
      fallbackTriggered: this.fallbackTriggered,
      checksumErrors: this.checksumErrors.length,
      networkErrors: this.networkErrors.length,
      duration: Date.now() - this.startTime,
      fallbackDelay: this.fallbackDelay
    };
  }
}

export default DownloadStrategy;