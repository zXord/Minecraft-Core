/// <reference path="../../electron.d.ts" />

import { RetentionPolicy } from './retentionPolicy.js';
import logger from '../logger.js';

/**
 * Retention Policy Executor
 * Handles evaluation and execution of retention policies with conflict resolution
 */

/**
 * Retention Policy Executor class for managing multiple policies and executing cleanup
 */
export class RetentionPolicyExecutor {
  /**
   * Create a new retention policy executor
   * @param {Object} [options={}] - Executor configuration options
   * @param {boolean} [options.dryRun=false] - If true, only simulate deletions without actually deleting
   * @param {Function} [options.onProgress] - Progress callback function
   * @param {Function} [options.onError] - Error callback function
   */
  constructor(options = {}) {
    this.dryRun = options.dryRun || false;
    this.onProgress = options.onProgress || (() => {});
    this.onError = options.onError || (() => {});
    this.executionLog = [];
  }

  /**
   * Evaluate multiple retention policies and resolve conflicts with comprehensive error handling
   * @param {Array} backups - Array of backup objects
   * @param {Array<RetentionPolicy>} policies - Array of retention policies to apply
   * @returns {Promise<Object>} Evaluation result with backups to delete and conflict resolution
   */
  async evaluateMultiplePolicies(backups, policies) {
    const evaluationResult = {
      backupsToDelete: [],
      conflictResolution: 'no-policies',
      policyResults: [],
      finalResult: {
        totalBackups: 0,
        backupsToDelete: 0,
        backupsRemaining: 0,
        spaceSaved: 0
      },
      errors: [],
      warnings: [],
      partialFailure: false
    };

    try {
      // Input validation
      if (!Array.isArray(backups)) {
        throw new Error('Backups must be an array');
      }

      evaluationResult.finalResult.totalBackups = backups.length;

      if (!Array.isArray(policies)) {
        throw new Error('Policies must be an array');
      }

      if (policies.length === 0) {
        evaluationResult.warnings.push('No retention policies provided');
        evaluationResult.finalResult.backupsRemaining = backups.length;
        return evaluationResult;
      }

      // Validate backup objects
      const validBackups = [];
      for (let i = 0; i < backups.length; i++) {
        const backup = backups[i];
        try {
          this._validateBackupForEvaluation(backup, i);
          validBackups.push(backup);
        } catch (validationError) {
          evaluationResult.errors.push({
            type: 'backup_validation_error',
            backup: backup?.name || `backup[${i}]`,
            error: validationError.message
          });
          evaluationResult.partialFailure = true;
        }
      }

      if (validBackups.length === 0) {
        evaluationResult.warnings.push('No valid backups found to evaluate');
        return evaluationResult;
      }

      // Evaluate each policy individually with error handling
      const policyResults = [];
      const policyErrors = [];

      for (let i = 0; i < policies.length; i++) {
        const policy = policies[i];
        
        try {
          // Validate policy instance
          if (!(policy instanceof RetentionPolicy)) {
            throw new Error(`Policy at index ${i} is not a RetentionPolicy instance`);
          }

          // Check if policy has active rules
          if (!policy.hasActiveRules()) {
            evaluationResult.warnings.push(`Policy ${i + 1} has no active rules and will be ignored`);
            continue;
          }

          // Evaluate policy
          const policyEvaluationResult = await policy.evaluateBackups(validBackups);
          const impact = await policy.getPolicyImpact(validBackups);
          
          policyResults.push({
            policy,
            backupsToDelete: policyEvaluationResult.toDelete || policyEvaluationResult, // Handle both old and new format
            impact,
            description: policy.getDescription(),
            errors: policyEvaluationResult.errors || [],
            warnings: policyEvaluationResult.warnings || []
          });

          // Collect policy-specific errors and warnings
          if (policyEvaluationResult.errors && policyEvaluationResult.errors.length > 0) {
            evaluationResult.errors.push(...policyEvaluationResult.errors.map(err => ({
              ...err,
              policyIndex: i,
              policyDescription: policy.getDescription()
            })));
            evaluationResult.partialFailure = true;
          }

          if (policyEvaluationResult.warnings && policyEvaluationResult.warnings.length > 0) {
            evaluationResult.warnings.push(...policyEvaluationResult.warnings.map(warn => 
              `Policy ${i + 1}: ${warn}`
            ));
          }

        } catch (error) {
          const errorInfo = {
            type: 'policy_evaluation_error',
            policyIndex: i,
            policyDescription: policy?.getDescription?.() || 'Unknown policy',
            error: error.message
          };

          policyErrors.push(errorInfo);
          evaluationResult.errors.push(errorInfo);
          evaluationResult.partialFailure = true;

          logger.error('Failed to evaluate retention policy', {
            category: 'backup',
            data: errorInfo
          });
          
          this.onError({
            type: 'policy-evaluation-error',
            policyIndex: i,
            error: error.message
          });

          // Continue with other policies instead of failing completely
          continue;
        }
      }

      // Check if we have any successful policy evaluations
      if (policyResults.length === 0) {
        if (policyErrors.length > 0) {
          throw new Error(`All ${policies.length} retention policies failed to evaluate`);
        } else {
          evaluationResult.warnings.push('No active retention policies found');
          evaluationResult.finalResult.backupsRemaining = validBackups.length;
          return evaluationResult;
        }
      }

      // Resolve conflicts between policies (most restrictive wins)
      try {
        const conflictResolution = this._resolveConflicts(policyResults, validBackups);
        
        evaluationResult.backupsToDelete = conflictResolution.backupsToDelete;
        evaluationResult.conflictResolution = conflictResolution.strategy;
        evaluationResult.finalResult = conflictResolution.impact;
        evaluationResult.policyResults = policyResults;

        // Add safety checks
        if (evaluationResult.backupsToDelete.length === validBackups.length) {
          evaluationResult.warnings.push('All backups would be deleted - this is prevented by safety measures');
        }

        if (evaluationResult.backupsToDelete.length > validBackups.length * 0.9) {
          evaluationResult.warnings.push('More than 90% of backups would be deleted - please review retention settings');
        }

      } catch (conflictError) {
        evaluationResult.errors.push({
          type: 'conflict_resolution_error',
          error: conflictError.message
        });
        
        // Provide safe fallback
        evaluationResult.backupsToDelete = [];
        evaluationResult.conflictResolution = 'error-fallback';
        evaluationResult.finalResult.backupsRemaining = validBackups.length;
        evaluationResult.partialFailure = true;
      }

      return evaluationResult;

    } catch (error) {
      evaluationResult.errors.push({
        type: 'critical_evaluation_error',
        error: error.message
      });

      logger.error('Critical failure in retention policy evaluation', {
        category: 'backup',
        data: {
          error: error.message,
          backupsCount: backups?.length || 0,
          policiesCount: policies?.length || 0
        }
      });

      // Return safe fallback result
      evaluationResult.backupsToDelete = [];
      evaluationResult.conflictResolution = 'critical-error-fallback';
      evaluationResult.finalResult.backupsRemaining = backups?.length || 0;
      evaluationResult.partialFailure = true;

      return evaluationResult;
    }
  }

  /**
   * Validate a backup object for retention evaluation
   * @param {Object} backup - Backup object to validate
   * @param {number} index - Index of backup in array (for error reporting)
   * @private
   */
  _validateBackupForEvaluation(backup, index) {
    if (!backup || typeof backup !== 'object') {
      throw new Error(`Backup at index ${index} is not a valid object`);
    }

    if (!backup.name || typeof backup.name !== 'string') {
      throw new Error(`Backup at index ${index} missing or invalid name property`);
    }

    // Size is optional but should be a number if present
    if (backup.size !== undefined && backup.size !== null) {
      if (typeof backup.size !== 'number' || backup.size < 0) {
        throw new Error(`Backup '${backup.name}' has invalid size property`);
      }
    }

    // Check for required date information
    if (!backup.created && (!backup.metadata || !backup.metadata.timestamp)) {
      throw new Error(`Backup '${backup.name}' missing date information (created or metadata.timestamp)`);
    }
  }

  /**
   * Execute retention policy cleanup
   * @param {string} serverPath - Path to the server directory
   * @param {Array<RetentionPolicy>} policies - Array of retention policies to apply
   * @param {Object} [options={}] - Execution options
   * @param {boolean} [options.confirmBeforeDelete] - Whether to require confirmation before deletion
   * @param {Function} [options.confirmationCallback] - Callback for confirmation (if required)
   * @returns {Promise<Object>} Execution result
   */
  async executeRetentionCleanup(serverPath, policies, options = {}) {
    if (!serverPath || typeof serverPath !== 'string') {
      throw new Error('Server path must be a valid string');
    }

    const startTime = Date.now();
    this.executionLog = [];
    
    try {
      // Get current backups
      this.onProgress({ stage: 'fetching-backups', progress: 0 });
      
      const backupsResult = await window.electron.invoke('backups:list', { serverPath });
      if (!backupsResult.success) {
        throw new Error(backupsResult.error || 'Failed to fetch backups');
      }

      const backups = backupsResult.backups || [];
      
      logger.info('Starting retention policy execution', {
        category: 'backup',
        data: {
          serverPath,
          totalBackups: backups.length,
          policiesCount: policies.length,
          dryRun: this.dryRun
        }
      });

      // Evaluate policies
      this.onProgress({ stage: 'evaluating-policies', progress: 20 });
      
      const evaluation = await this.evaluateMultiplePolicies(backups, policies);
      
      if (evaluation.backupsToDelete.length === 0) {
        logger.info('No backups need to be deleted', {
          category: 'backup',
          data: {
            serverPath,
            totalBackups: backups.length,
            conflictResolution: evaluation.conflictResolution
          }
        });

        return {
          success: true,
          deletedBackups: [],
          spaceSaved: 0,
          executionTime: Date.now() - startTime,
          dryRun: this.dryRun,
          evaluation,
          executionLog: this.executionLog
        };
      }

      // Request confirmation if required
      if (options.confirmBeforeDelete && !this.dryRun) {
        this.onProgress({ stage: 'awaiting-confirmation', progress: 40 });
        
        const confirmed = await this._requestConfirmation(
          evaluation,
          options.confirmationCallback
        );
        
        if (!confirmed) {
          logger.info('Retention cleanup cancelled by user', {
            category: 'backup',
            data: { serverPath, backupsToDelete: evaluation.backupsToDelete.length }
          });

          return {
            success: false,
            cancelled: true,
            reason: 'User cancelled operation',
            evaluation,
            executionLog: this.executionLog
          };
        }
      }

      // Execute deletions
      this.onProgress({ stage: 'deleting-backups', progress: 60 });
      
      const deletionResults = await this._executeBackupDeletions(
        serverPath,
        evaluation.backupsToDelete
      );

      const successfulDeletions = deletionResults.filter(r => r.success);
      const failedDeletions = deletionResults.filter(r => !r.success);
      
      const spaceSaved = successfulDeletions.reduce((sum, result) => {
        const backup = evaluation.backupsToDelete.find(b => b.name === result.name);
        return sum + (backup ? backup.size || 0 : 0);
      }, 0);

      // Log results
      logger.info('Retention policy execution completed', {
        category: 'backup',
        data: {
          serverPath,
          totalBackups: backups.length,
          backupsToDelete: evaluation.backupsToDelete.length,
          successfulDeletions: successfulDeletions.length,
          failedDeletions: failedDeletions.length,
          spaceSaved,
          executionTime: Date.now() - startTime,
          dryRun: this.dryRun
        }
      });

      this.onProgress({ stage: 'completed', progress: 100 });

      return {
        success: true,
        deletedBackups: successfulDeletions,
        failedDeletions,
        spaceSaved,
        executionTime: Date.now() - startTime,
        dryRun: this.dryRun,
        evaluation,
        executionLog: this.executionLog
      };

    } catch (error) {
      logger.error('Retention policy execution failed', {
        category: 'backup',
        data: {
          serverPath,
          error: error.message,
          executionTime: Date.now() - startTime
        }
      });

      this.onError({
        type: 'execution-error',
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Resolve conflicts between multiple retention policies
   * @param {Array} policyResults - Results from individual policy evaluations
   * @param {Array} allBackups - All available backups
   * @returns {Object} Conflict resolution result
   * @private
   */
  _resolveConflicts(policyResults, allBackups) {
    if (policyResults.length === 0) {
      return {
        strategy: 'no-policies',
        backupsToDelete: [],
        impact: {
          totalBackups: allBackups.length,
          backupsToDelete: 0,
          backupsRemaining: allBackups.length,
          spaceSaved: 0
        }
      };
    }

    if (policyResults.length === 1) {
      return {
        strategy: 'single-policy',
        backupsToDelete: policyResults[0].backupsToDelete,
        impact: policyResults[0].impact
      };
    }

    // For multiple policies, use union approach (most restrictive wins)
    // A backup should be deleted if ANY policy says it should be deleted
    const allDeletions = new Set();
    
    policyResults.forEach(result => {
      result.backupsToDelete.forEach(backup => {
        allDeletions.add(backup.name);
      });
    });

    // Convert back to backup objects
    const backupsToDelete = allBackups.filter(backup => 
      allDeletions.has(backup.name)
    );

    // Calculate combined impact
    const totalSize = allBackups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    const deletedSize = backupsToDelete.reduce((sum, backup) => sum + (backup.size || 0), 0);

    const impact = {
      totalBackups: allBackups.length,
      backupsToDelete: backupsToDelete.length,
      backupsRemaining: allBackups.length - backupsToDelete.length,
      totalSize,
      deletedSize,
      remainingSize: totalSize - deletedSize,
      spaceSaved: deletedSize
    };

    this.executionLog.push({
      timestamp: new Date().toISOString(),
      type: 'conflict-resolution',
      data: {
        strategy: 'union-most-restrictive',
        policiesCount: policyResults.length,
        totalDeletions: backupsToDelete.length,
        impact
      }
    });

    return {
      strategy: 'union-most-restrictive',
      backupsToDelete,
      impact
    };
  }

  /**
   * Request confirmation from user before executing deletions
   * @param {Object} evaluation - Policy evaluation result
   * @param {Function} confirmationCallback - Callback function for confirmation
   * @returns {Promise<boolean>} True if confirmed, false otherwise
   * @private
   */
  async _requestConfirmation(evaluation, confirmationCallback) {
    if (typeof confirmationCallback !== 'function') {
      // Default to confirmed if no callback provided
      return true;
    }

    try {
      const confirmationData = {
        backupsToDelete: evaluation.backupsToDelete.length,
        spaceSaved: evaluation.finalResult.spaceSaved,
        backupsRemaining: evaluation.finalResult.backupsRemaining,
        conflictResolution: evaluation.conflictResolution,
        backupNames: evaluation.backupsToDelete.map(b => b.name)
      };

      const confirmed = await confirmationCallback(confirmationData);
      
      this.executionLog.push({
        timestamp: new Date().toISOString(),
        type: 'confirmation-request',
        data: {
          ...confirmationData,
          confirmed
        }
      });

      return Boolean(confirmed);
    } catch (error) {
      logger.error('Confirmation callback failed', {
        category: 'backup',
        data: { error: error.message }
      });
      
      // Default to not confirmed on error
      return false;
    }
  }

  /**
   * Execute backup deletions with comprehensive error handling and detailed logging
   * @param {string} serverPath - Path to the server directory
   * @param {Array} backupsToDelete - Array of backup objects to delete
   * @returns {Promise<Array>} Array of deletion results
   * @private
   */
  async _executeBackupDeletions(serverPath, backupsToDelete) {
    const deletionResults = [];
    const BATCH_SIZE = 5; // Process deletions in batches to avoid overwhelming the system
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1000;
    
    // Validate inputs
    if (!Array.isArray(backupsToDelete) || backupsToDelete.length === 0) {
      return deletionResults;
    }

    // Process deletions in batches
    for (let batchStart = 0; batchStart < backupsToDelete.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, backupsToDelete.length);
      const batch = backupsToDelete.slice(batchStart, batchEnd);

      // Process each backup in the current batch
      for (let i = 0; i < batch.length; i++) {
        const backup = batch[i];
        const overallIndex = batchStart + i;
        const progress = ((overallIndex + 1) / backupsToDelete.length) * 40 + 60; // 60-100% range
        
        this.onProgress({
          stage: 'deleting-backups',
          progress,
          currentBackup: backup.name,
          completed: overallIndex,
          total: backupsToDelete.length,
          batch: Math.floor(batchStart / BATCH_SIZE) + 1,
          totalBatches: Math.ceil(backupsToDelete.length / BATCH_SIZE)
        });

        // Validate backup object
        if (!backup || !backup.name) {
          const error = 'Invalid backup object - missing name';
          deletionResults.push({
            name: backup?.name || 'unknown',
            success: false,
            error,
            dryRun: this.dryRun,
            validationError: true
          });

          this.executionLog.push({
            timestamp: new Date().toISOString(),
            type: 'backup-deletion-validation-error',
            data: {
              backup,
              error,
              dryRun: this.dryRun
            }
          });

          continue;
        }

        // Execute deletion with retry logic
        let lastError = null;
        let success = false;
        
        for (let retryCount = 0; retryCount <= MAX_RETRIES; retryCount++) {
          try {
            let result;
            
            if (this.dryRun) {
              // Simulate deletion for dry run
              result = {
                success: true,
                name: backup.name,
                dryRun: true
              };
              
              logger.info('Dry run: Would delete backup', {
                category: 'backup',
                data: {
                  serverPath,
                  backupName: backup.name,
                  backupSize: backup.size,
                  retryCount
                }
              });
            } else {
              // Actually delete the backup
              result = await window.electron.invoke('backups:delete', {
                serverPath,
                name: backup.name
              });
              
              // Validate result
              if (!result || typeof result.success !== 'boolean') {
                throw new Error('Invalid response from backup deletion service');
              }
              
              if (result.success) {
                logger.info('Successfully deleted backup', {
                  category: 'backup',
                  data: {
                    serverPath,
                    backupName: backup.name,
                    backupSize: backup.size,
                    retryCount
                  }
                });
              } else {
                const errorMessage = result.error || 'Unknown deletion error';
                
                // Check if this is a retryable error
                if (retryCount < MAX_RETRIES && this._isRetryableDeletionError(errorMessage)) {
                  logger.warn(`Backup deletion failed (attempt ${retryCount + 1}/${MAX_RETRIES + 1}): ${errorMessage}. Retrying...`, {
                    category: 'backup',
                    data: {
                      serverPath,
                      backupName: backup.name,
                      retryCount,
                      error: errorMessage
                    }
                  });
                  
                  lastError = errorMessage;
                  await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
                  continue;
                }
                
                throw new Error(errorMessage);
              }
            }

            // Success - break out of retry loop
            success = true;
            deletionResults.push({
              name: backup.name,
              success: result.success,
              error: result.error || null,
              dryRun: this.dryRun,
              retryCount
            });

            this.executionLog.push({
              timestamp: new Date().toISOString(),
              type: 'backup-deletion',
              data: {
                backupName: backup.name,
                backupSize: backup.size,
                success: result.success,
                error: result.error || null,
                dryRun: this.dryRun,
                retryCount
              }
            });

            break; // Exit retry loop on success

          } catch (error) {
            lastError = error.message;
            
            // Check if we should retry
            if (retryCount < MAX_RETRIES && this._isRetryableDeletionError(error.message)) {
              logger.warn(`Exception during backup deletion (attempt ${retryCount + 1}/${MAX_RETRIES + 1}): ${error.message}. Retrying...`, {
                category: 'backup',
                data: {
                  serverPath,
                  backupName: backup.name,
                  retryCount,
                  error: error.message
                }
              });
              
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
              continue;
            }
            
            // Final failure after all retries
            logger.error('Exception during backup deletion after all retries', {
              category: 'backup',
              data: {
                serverPath,
                backupName: backup.name,
                retryCount,
                error: error.message
              }
            });

            break; // Exit retry loop on final failure
          }
        }

        // Handle final failure
        if (!success) {
          deletionResults.push({
            name: backup.name,
            success: false,
            error: lastError || 'Unknown error',
            dryRun: this.dryRun,
            retriesExhausted: true
          });

          this.executionLog.push({
            timestamp: new Date().toISOString(),
            type: 'backup-deletion-final-error',
            data: {
              backupName: backup.name,
              error: lastError || 'Unknown error',
              dryRun: this.dryRun,
              maxRetriesReached: true
            }
          });

          this.onError({
            type: 'deletion-error',
            backupName: backup.name,
            error: lastError || 'Unknown error',
            retriesExhausted: true
          });
        }
      }

      // Small delay between batches to avoid overwhelming the system
      if (batchEnd < backupsToDelete.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return deletionResults;
  }

  /**
   * Check if a deletion error is retryable
   * @param {string} errorMessage - Error message to check
   * @returns {boolean} True if error might be temporary and worth retrying
   * @private
   */
  _isRetryableDeletionError(errorMessage) {
    if (!errorMessage || typeof errorMessage !== 'string') {
      return false;
    }

    const retryablePatterns = [
      'EBUSY',
      'EMFILE',
      'ENFILE',
      'EAGAIN',
      'ENOENT',
      'temporarily unavailable',
      'resource temporarily unavailable',
      'too many open files',
      'file is locked',
      'access denied',
      'permission denied',
      'network',
      'timeout',
      'connection'
    ];
    
    const lowerMessage = errorMessage.toLowerCase();
    return retryablePatterns.some(pattern => lowerMessage.includes(pattern.toLowerCase()));
  }

  /**
   * Get the execution log
   * @returns {Array} Array of log entries
   */
  getExecutionLog() {
    return [...this.executionLog];
  }

  /**
   * Clear the execution log
   */
  clearExecutionLog() {
    this.executionLog = [];
  }
}

/**
 * Utility function to create a retention executor with common settings
 * @param {Object} options - Executor options
 * @returns {RetentionPolicyExecutor} Configured executor
 */
export function createRetentionExecutor(options = {}) {
  return new RetentionPolicyExecutor(options);
}

/**
 * Utility function to execute retention policies with default settings
 * @param {string} serverPath - Path to the server directory
 * @param {Array<RetentionPolicy>} policies - Array of retention policies
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} Execution result
 */
export async function executeRetentionPolicies(serverPath, policies, options = {}) {
  const executor = createRetentionExecutor({
    dryRun: options.dryRun || false,
    onProgress: options.onProgress,
    onError: options.onError
  });

  return await executor.executeRetentionCleanup(serverPath, policies, {
    confirmBeforeDelete: options.confirmBeforeDelete !== false, // Default to true
    confirmationCallback: options.confirmationCallback
  });
}

/**
 * Utility function to preview what retention policies would do without executing
 * @param {string} serverPath - Path to the server directory
 * @param {Array<RetentionPolicy>} policies - Array of retention policies
 * @returns {Promise<Object>} Preview result
 */
export async function previewRetentionPolicies(serverPath, policies) {
  const executor = createRetentionExecutor({ dryRun: true });
  
  // Get current backups
  const backupsResult = await window.electron.invoke('backups:list', { serverPath });
  if (!backupsResult.success) {
    throw new Error(backupsResult.error || 'Failed to fetch backups');
  }

  const backups = backupsResult.backups || [];
  return await executor.evaluateMultiplePolicies(backups, policies);
}