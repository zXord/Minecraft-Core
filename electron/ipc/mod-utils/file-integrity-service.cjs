const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { getLoggerHandlers } = require('../logger-handlers.cjs');

const logger = getLoggerHandlers();

/**
 * File integrity verification service
 * Handles checksum calculation, storage, and corruption detection
 */
class FileIntegrityService {
  constructor() {
    this.checksumCache = new Map();
    this.corruptionAlerts = new Map();
    
    logger.info('File integrity service initialized', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'constructor'
      }
    });
  }

  /**
   * Calculate file checksum using streaming for large files
   * @param {string} filePath - Path to the file
   * @param {string} algorithm - Hash algorithm (default: sha1)
   * @returns {Promise<string>} File checksum
   */
  async calculateFileChecksum(filePath, algorithm = 'sha1') {
    const startTime = Date.now();
    
    logger.debug('Calculating file checksum', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'calculateFileChecksum',
        filePath,
        algorithm
      }
    });

    try {
      const hash = crypto.createHash(algorithm);
      const fileHandle = await fs.open(filePath, 'r');
      
      try {
        const stream = fileHandle.createReadStream();
        
        for await (const chunk of stream) {
          hash.update(chunk);
        }
        
        const checksum = hash.digest('hex');
        const duration = Date.now() - startTime;
        
        logger.debug('File checksum calculated successfully', {
          category: 'storage',
          data: {
            service: 'FileIntegrityService',
            operation: 'calculateFileChecksum',
            filePath,
            algorithm,
            checksum,
            duration
          }
        });
        
        return checksum;
      } finally {
        await fileHandle.close();
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`File checksum calculation failed: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'calculateFileChecksum',
          filePath,
          algorithm,
          errorType: error.constructor.name,
          duration
        }
      });
      
      throw error;
    }
  }

  /**
   * Store file checksum metadata
   * @param {string} filePath - Path to the file
   * @param {string} checksum - File checksum
   * @param {string} algorithm - Hash algorithm
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<void>}
   */
  async storeFileChecksum(filePath, checksum, algorithm = 'sha1', metadata = {}) {
    logger.debug('Storing file checksum', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'storeFileChecksum',
        filePath,
        checksum,
        algorithm,
        hasMetadata: Object.keys(metadata).length > 0
      }
    });

    try {
      const checksumData = {
        filePath,
        checksum,
        algorithm,
        timestamp: Date.now(),
        fileSize: (await fs.stat(filePath)).size,
        ...metadata
      };

      // Store in memory cache
      this.checksumCache.set(filePath, checksumData);

      // Store in filesystem for persistence
      const checksumDir = path.join(path.dirname(filePath), '.integrity');
      await fs.mkdir(checksumDir, { recursive: true });
      
      const checksumFile = path.join(checksumDir, `${path.basename(filePath)}.checksum.json`);
      await fs.writeFile(checksumFile, JSON.stringify(checksumData, null, 2));

      logger.debug('File checksum stored successfully', {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'storeFileChecksum',
          filePath,
          checksumFile,
          algorithm
        }
      });
    } catch (error) {
      logger.error(`Failed to store file checksum: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'storeFileChecksum',
          filePath,
          errorType: error.constructor.name
        }
      });
      
      throw error;
    }
  }

  /**
   * Retrieve stored file checksum
   * @param {string} filePath - Path to the file
   * @returns {Promise<Object|null>} Stored checksum data or null if not found
   */
  async getStoredChecksum(filePath) {
    logger.debug('Retrieving stored file checksum', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'getStoredChecksum',
        filePath
      }
    });

    try {
      // Check memory cache first
      if (this.checksumCache.has(filePath)) {
        const cachedData = this.checksumCache.get(filePath);
        
        logger.debug('File checksum retrieved from cache', {
          category: 'storage',
          data: {
            service: 'FileIntegrityService',
            operation: 'getStoredChecksum',
            filePath,
            source: 'cache',
            algorithm: cachedData.algorithm
          }
        });
        
        return cachedData;
      }

      // Check filesystem
      const checksumDir = path.join(path.dirname(filePath), '.integrity');
      const checksumFile = path.join(checksumDir, `${path.basename(filePath)}.checksum.json`);
      
      try {
        const checksumData = JSON.parse(await fs.readFile(checksumFile, 'utf8'));
        
        // Update cache
        this.checksumCache.set(filePath, checksumData);
        
        logger.debug('File checksum retrieved from filesystem', {
          category: 'storage',
          data: {
            service: 'FileIntegrityService',
            operation: 'getStoredChecksum',
            filePath,
            source: 'filesystem',
            algorithm: checksumData.algorithm
          }
        });
        
        return checksumData;
      } catch (fsError) {
        if (fsError.code !== 'ENOENT') {
          logger.warn(`Error reading checksum file: ${fsError.message}`, {
            category: 'storage',
            data: {
              service: 'FileIntegrityService',
              operation: 'getStoredChecksum',
              filePath,
              checksumFile,
              errorType: fsError.constructor.name
            }
          });
        }
        
        return null;
      }
    } catch (error) {
      logger.error(`Failed to retrieve stored checksum: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'getStoredChecksum',
          filePath,
          errorType: error.constructor.name
        }
      });
      
      return null;
    }
  }

  /**
   * Verify file integrity against stored checksum
   * @param {string} filePath - Path to the file
   * @param {string} [expectedChecksum] - Expected checksum (optional, will use stored if not provided)
   * @param {string} [algorithm] - Hash algorithm
   * @returns {Promise<Object>} Verification result
   */
  async verifyFileIntegrity(filePath, expectedChecksum = null, algorithm = 'sha1') {
    const startTime = Date.now();
    
    logger.debug('Verifying file integrity', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'verifyFileIntegrity',
        filePath,
        hasExpectedChecksum: !!expectedChecksum,
        algorithm
      }
    });

    try {
      // Get expected checksum from parameter or stored data
      let expected = expectedChecksum;
      let storedData = null;
      
      if (!expected) {
        storedData = await this.getStoredChecksum(filePath);
        if (storedData) {
          expected = storedData.checksum;
          algorithm = storedData.algorithm;
        }
      }

      if (!expected) {
        logger.warn('No expected checksum available for verification', {
          category: 'storage',
          data: {
            service: 'FileIntegrityService',
            operation: 'verifyFileIntegrity',
            filePath,
            hasStoredData: !!storedData
          }
        });
        
        return {
          isValid: null,
          reason: 'no_expected_checksum',
          filePath,
          algorithm
        };
      }

      // Calculate current checksum
      const actualChecksum = await this.calculateFileChecksum(filePath, algorithm);
      const isValid = actualChecksum === expected;
      const duration = Date.now() - startTime;

      const result = {
        isValid,
        expected,
        actual: actualChecksum,
        algorithm,
        filePath,
        verificationTime: Date.now(),
        duration
      };

      if (isValid) {
        logger.debug('File integrity verification passed', {
          category: 'storage',
          data: {
            service: 'FileIntegrityService',
            operation: 'verifyFileIntegrity',
            filePath,
            algorithm,
            duration
          }
        });
      } else {
        logger.warn('File integrity verification failed', {
          category: 'storage',
          data: {
            service: 'FileIntegrityService',
            operation: 'verifyFileIntegrity',
            filePath,
            algorithm,
            expected,
            actual: actualChecksum,
            duration
          }
        });
        
        // Track corruption
        await this.trackCorruption(filePath, result);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`File integrity verification failed: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'verifyFileIntegrity',
          filePath,
          algorithm,
          errorType: error.constructor.name,
          duration
        }
      });
      
      return {
        isValid: false,
        error: error.message,
        filePath,
        algorithm,
        verificationTime: Date.now(),
        duration
      };
    }
  }

  /**
   * Track file corruption for monitoring and alerting
   * @param {string} filePath - Path to the corrupted file
   * @param {Object} verificationResult - Verification result
   * @returns {Promise<void>}
   */
  async trackCorruption(filePath, verificationResult) {
    logger.info('Tracking file corruption', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'trackCorruption',
        filePath,
        expected: verificationResult.expected,
        actual: verificationResult.actual,
        algorithm: verificationResult.algorithm
      }
    });

    try {
      const corruptionData = {
        filePath,
        timestamp: Date.now(),
        verificationResult,
        alertCount: 1
      };

      // Check if we've seen this corruption before
      if (this.corruptionAlerts.has(filePath)) {
        const existing = this.corruptionAlerts.get(filePath);
        corruptionData.alertCount = existing.alertCount + 1;
        corruptionData.firstSeen = existing.timestamp;
      }

      this.corruptionAlerts.set(filePath, corruptionData);

      // Log corruption alert
      logger.error('File corruption detected', {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'trackCorruption',
          filePath,
          alertCount: corruptionData.alertCount,
          expected: verificationResult.expected,
          actual: verificationResult.actual,
          algorithm: verificationResult.algorithm,
          firstSeen: corruptionData.firstSeen
        }
      });

      // Store corruption log
      const corruptionDir = path.join(path.dirname(filePath), '.integrity', 'corruption');
      await fs.mkdir(corruptionDir, { recursive: true });
      
      const corruptionFile = path.join(corruptionDir, `${path.basename(filePath)}.corruption.json`);
      await fs.writeFile(corruptionFile, JSON.stringify(corruptionData, null, 2));

    } catch (error) {
      logger.error(`Failed to track corruption: ${error.message}`, {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'trackCorruption',
          filePath,
          errorType: error.constructor.name
        }
      });
    }
  }

  /**
   * Get corruption alerts for monitoring
   * @returns {Array<Object>} Array of corruption alerts
   */
  getCorruptionAlerts() {
    const alerts = Array.from(this.corruptionAlerts.values());
    
    logger.debug('Retrieved corruption alerts', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'getCorruptionAlerts',
        alertCount: alerts.length
      }
    });
    
    return alerts;
  }

  /**
   * Clear corruption alert for a file
   * @param {string} filePath - Path to the file
   * @returns {boolean} True if alert was cleared
   */
  clearCorruptionAlert(filePath) {
    const cleared = this.corruptionAlerts.delete(filePath);
    
    if (cleared) {
      logger.info('Corruption alert cleared', {
        category: 'storage',
        data: {
          service: 'FileIntegrityService',
          operation: 'clearCorruptionAlert',
          filePath
        }
      });
    }
    
    return cleared;
  }

  /**
   * Perform integrity check on multiple files
   * @param {Array<string>} filePaths - Array of file paths to check
   * @param {Function} progressCallback - Progress callback function
   * @returns {Promise<Object>} Batch verification results
   */
  async batchVerifyIntegrity(filePaths, progressCallback = null) {
    const startTime = Date.now();
    
    logger.info('Starting batch integrity verification', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'batchVerifyIntegrity',
        fileCount: filePaths.length
      }
    });

    const results = {
      total: filePaths.length,
      valid: 0,
      invalid: 0,
      errors: 0,
      files: []
    };

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      
      try {
        const result = await this.verifyFileIntegrity(filePath);
        results.files.push(result);
        
        if (result.isValid === true) {
          results.valid++;
        } else if (result.isValid === false) {
          results.invalid++;
        } else {
          results.errors++;
        }
        
        if (progressCallback) {
          progressCallback({
            current: i + 1,
            total: filePaths.length,
            progress: ((i + 1) / filePaths.length) * 100,
            currentFile: filePath,
            result
          });
        }
      } catch (error) {
        results.errors++;
        results.files.push({
          isValid: false,
          error: error.message,
          filePath,
          verificationTime: Date.now()
        });
        
        logger.error(`Batch verification error for ${filePath}: ${error.message}`, {
          category: 'storage',
          data: {
            service: 'FileIntegrityService',
            operation: 'batchVerifyIntegrity',
            filePath,
            errorType: error.constructor.name
          }
        });
      }
    }

    const duration = Date.now() - startTime;
    
    logger.info('Batch integrity verification completed', {
      category: 'storage',
      data: {
        service: 'FileIntegrityService',
        operation: 'batchVerifyIntegrity',
        total: results.total,
        valid: results.valid,
        invalid: results.invalid,
        errors: results.errors,
        duration
      }
    });

    return results;
  }
}

// Create singleton instance
const fileIntegrityService = new FileIntegrityService();

module.exports = {
  FileIntegrityService,
  fileIntegrityService
};