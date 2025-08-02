/**
 * Checksum validation utilities for mod downloads
 */
import logger from '../logger.js';

/**
 * Checksum validation class for verifying file integrity
 */
export class ChecksumValidator {
  /**
   * Validate a file against an expected checksum
   * @param {string} filePath - Path to the file to validate
   * @param {string} expectedChecksum - Expected checksum value
   * @param {string} algorithm - Hash algorithm to use (default: 'sha1')
   * @returns {Promise<Object>} Validation result with isValid, expected, actual, and algorithm
   */
  static async validateFile(filePath, expectedChecksum, algorithm = 'sha1') {
    const startTime = Date.now();
    
    logger.debug('Starting file checksum validation', {
      category: 'mods',
      data: {
        function: 'ChecksumValidator.validateFile',
        filePath,
        algorithm,
        hasExpectedChecksum: !!expectedChecksum
      }
    });

    try {
      if (!filePath || !expectedChecksum) {
        throw new Error('File path and expected checksum are required');
      }

      const actualChecksum = await this.calculateChecksum(filePath, algorithm);
      const isValid = actualChecksum === expectedChecksum;
      
      const result = {
        isValid,
        expected: expectedChecksum,
        actual: actualChecksum,
        algorithm,
        validationTime: Date.now() - startTime
      };

      logger.info('File checksum validation completed', {
        category: 'mods',
        data: {
          function: 'ChecksumValidator.validateFile',
          filePath,
          algorithm,
          isValid,
          duration: result.validationTime,
          expectedLength: expectedChecksum.length,
          actualLength: actualChecksum.length
        }
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`Checksum validation failed: ${error.message}`, {
        category: 'mods',
        data: {
          function: 'ChecksumValidator.validateFile',
          filePath,
          algorithm,
          expectedChecksum,
          duration,
          errorType: error.constructor.name
        }
      });

      throw new Error(`Checksum validation failed: ${error.message}`);
    }
  }

  /**
   * Calculate checksum for a file using Node.js crypto via IPC
   * @param {string} filePath - Path to the file
   * @param {string} algorithm - Hash algorithm to use (default: 'sha1')
   * @returns {Promise<string>} Calculated checksum
   */
  static async calculateChecksum(filePath, algorithm = 'sha1') {
    const startTime = Date.now();
    
    logger.debug('Calculating file checksum via IPC', {
      category: 'mods',
      data: {
        function: 'ChecksumValidator.calculateChecksum',
        filePath,
        algorithm
      }
    });

    try {
      if (!filePath) {
        throw new Error('File path is required');
      }

      if (!window.electron || !window.electron.invoke) {
        throw new Error('Electron IPC not available');
      }

      const checksum = await window.electron.invoke('calculate-file-checksum', {
        filePath,
        algorithm
      });

      const duration = Date.now() - startTime;

      logger.info('File checksum calculated successfully', {
        category: 'mods',
        data: {
          function: 'ChecksumValidator.calculateChecksum',
          filePath,
          algorithm,
          checksumLength: checksum ? checksum.length : 0,
          duration
        }
      });

      return checksum;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`Checksum calculation failed: ${error.message}`, {
        category: 'mods',
        data: {
          function: 'ChecksumValidator.calculateChecksum',
          filePath,
          algorithm,
          duration,
          errorType: error.constructor.name
        }
      });

      throw new Error(`Checksum calculation failed: ${error.message}`);
    }
  }

  /**
   * Validate multiple files against their expected checksums
   * @param {Array<Object>} files - Array of {filePath, expectedChecksum, algorithm} objects
   * @returns {Promise<Array<Object>>} Array of validation results
   */
  static async validateFiles(files) {
    const startTime = Date.now();
    
    logger.debug('Starting batch file checksum validation', {
      category: 'mods',
      data: {
        function: 'ChecksumValidator.validateFiles',
        fileCount: files ? files.length : 0
      }
    });

    try {
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('Files array is required and must not be empty');
      }

      const validationPromises = files.map(async (file, index) => {
        try {
          const result = await this.validateFile(
            file.filePath,
            file.expectedChecksum,
            file.algorithm || 'sha1'
          );
          return { ...result, index, filePath: file.filePath };
        } catch (error) {
          logger.error(`Batch validation failed for file ${index}: ${error.message}`, {
            category: 'mods',
            data: {
              function: 'ChecksumValidator.validateFiles',
              fileIndex: index,
              filePath: file.filePath,
              errorType: error.constructor.name
            }
          });
          return {
            index,
            filePath: file.filePath,
            isValid: false,
            error: error.message,
            expected: file.expectedChecksum,
            actual: null,
            algorithm: file.algorithm || 'sha1'
          };
        }
      });

      const results = await Promise.all(validationPromises);
      const duration = Date.now() - startTime;
      const validCount = results.filter(r => r.isValid).length;

      logger.info('Batch file checksum validation completed', {
        category: 'mods',
        data: {
          function: 'ChecksumValidator.validateFiles',
          totalFiles: files.length,
          validFiles: validCount,
          invalidFiles: files.length - validCount,
          duration
        }
      });

      return results;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`Batch checksum validation failed: ${error.message}`, {
        category: 'mods',
        data: {
          function: 'ChecksumValidator.validateFiles',
          fileCount: files ? files.length : 0,
          duration,
          errorType: error.constructor.name
        }
      });

      throw new Error(`Batch checksum validation failed: ${error.message}`);
    }
  }

  /**
   * Get supported hash algorithms
   * @returns {Array<string>} Array of supported algorithms
   */
  static getSupportedAlgorithms() {
    return ['sha1', 'sha256', 'md5'];
  }

  /**
   * Validate algorithm is supported
   * @param {string} algorithm - Algorithm to validate
   * @returns {boolean} True if algorithm is supported
   */
  static isAlgorithmSupported(algorithm) {
    return this.getSupportedAlgorithms().includes(algorithm.toLowerCase());
  }
}

export default ChecksumValidator;