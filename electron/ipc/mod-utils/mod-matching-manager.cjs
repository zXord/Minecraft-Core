// In-memory store for mod matching data
// Key: fileName, Value: matching data
const modMatchingStore = new Map();

// Store for pending confirmations
// Key: fileName, Value: { matches, metadata, searchedName, searchedVersion }
const pendingConfirmations = new Map();

// Store for confirmed matches
// Key: fileName, Value: { projectId, modrinthData, confirmedAt }
const confirmedMatches = new Map();

// Store for manually rejected matches
// Key: fileName, Value: { rejectedAt, reason }
const rejectedMatches = new Map();

// Import persistence utilities
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const os = require('os');
const { getLoggerHandlers } = require('../logger-handlers.cjs');

// Get persistent storage path
function getPersistencePath() {
  const userDataPath = app ? app.getPath('userData') : path.join(os.homedir(), '.minecraft-core');
  const configDir = path.join(userDataPath, 'config');
  
  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  return path.join(configDir, 'modrinth-matches.json');
}

// Save confirmed matches to disk
function saveConfirmedMatches() {
  const logger = getLoggerHandlers();
  
  try {
    const dataToSave = {
      confirmed: Array.from(confirmedMatches.entries()),
      savedAt: Date.now()
    };
    
    const filePath = getPersistencePath();
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf8');
    
    logger.debug('Saved confirmed mod matches to disk', {
      category: 'storage',
      data: {
        service: 'mod-matching-manager',
        operation: 'saveConfirmedMatches',
        filePath: filePath,
        matchCount: confirmedMatches.size
      }
    });
  } catch (error) {
    logger.error(`Error saving confirmed matches: ${error.message}`, {
      category: 'storage',
      data: {
        service: 'mod-matching-manager',
        operation: 'saveConfirmedMatches',
        errorType: error.constructor.name
      }
    });
  }
}

// Load confirmed matches from disk
function loadConfirmedMatches() {
  const logger = getLoggerHandlers();
  
  try {
    const filePath = getPersistencePath();
    
    if (!fs.existsSync(filePath)) {
      logger.debug('No confirmed matches file found, starting fresh', {
        category: 'storage',
        data: {
          service: 'mod-matching-manager',
          operation: 'loadConfirmedMatches',
          filePath: filePath
        }
      });
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (data.confirmed && Array.isArray(data.confirmed)) {
      data.confirmed.forEach(([fileName, matchData]) => {
        confirmedMatches.set(fileName, matchData);
      });
      
      logger.debug('Loaded confirmed mod matches from disk', {
        category: 'storage',
        data: {
          service: 'mod-matching-manager',
          operation: 'loadConfirmedMatches',
          filePath: filePath,
          matchCount: data.confirmed.length
        }
      });
    }
  } catch (error) {
    logger.error(`Error loading confirmed matches: ${error.message}`, {
      category: 'storage',
      data: {
        service: 'mod-matching-manager',
        operation: 'loadConfirmedMatches',
        errorType: error.constructor.name
      }
    });
  }
}

class ModMatchingManager {
  
  constructor() {
    this.logger = getLoggerHandlers();
    
    this.logger.info('Mod matching manager initialized', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'constructor'
      }
    });
    
    // Load saved matches on initialization
    this.loadFromDisk();
  }
  
  // Load confirmed matches from disk
  loadFromDisk() {
    this.logger.debug('Loading mod matches from disk', {
      category: 'storage',
      data: {
        service: 'mod-matching-manager',
        operation: 'loadFromDisk'
      }
    });
    loadConfirmedMatches();
  }
  
  // Save confirmed matches to disk
  saveToDisk() {
    this.logger.debug('Saving mod matches to disk', {
      category: 'storage',
      data: {
        service: 'mod-matching-manager',
        operation: 'saveToDisk',
        confirmedMatchCount: confirmedMatches.size
      }
    });
    saveConfirmedMatches();
  }
  
  // Set matching data for a mod
  setModMatchingData(fileName, data) {
    this.logger.debug('Setting mod matching data', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'setModMatchingData',
        fileName: fileName,
        hasMatches: !!(data?.matches?.length),
        matchCount: data?.matches?.length || 0
      }
    });
    
    modMatchingStore.set(fileName, {
      ...data,
      lastUpdated: Date.now()
    });
  }

  // Get matching data for a mod
  getModMatchingData(fileName) {
    const data = modMatchingStore.get(fileName) || null;
    
    this.logger.debug('Retrieved mod matching data', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'getModMatchingData',
        fileName: fileName,
        hasData: !!data,
        matchCount: data?.matches?.length || 0
      }
    });
    
    return data;
  }

  // Set pending confirmation for a mod
  setPendingConfirmation(fileName, confirmationData) {
    this.logger.info('Setting pending mod match confirmation', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'setPendingConfirmation',
        fileName: fileName,
        hasMatches: !!(confirmationData?.matches?.length),
        matchCount: confirmationData?.matches?.length || 0,
        searchedName: confirmationData?.searchedName
      }
    });
    
    pendingConfirmations.set(fileName, {
      ...confirmationData,
      createdAt: Date.now()
    });
  }

  // Get pending confirmation for a mod
  getPendingConfirmation(fileName) {
    const data = pendingConfirmations.get(fileName) || null;
    
    this.logger.debug('Retrieved pending mod confirmation', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'getPendingConfirmation',
        fileName: fileName,
        hasPending: !!data
      }
    });
    
    return data;
  }

  // Remove pending confirmation
  removePendingConfirmation(fileName) {
    const existed = pendingConfirmations.has(fileName);
    const result = pendingConfirmations.delete(fileName);
    
    if (existed) {
      this.logger.debug('Removed pending mod confirmation', {
        category: 'mods',
        data: {
          service: 'mod-matching-manager',
          operation: 'removePendingConfirmation',
          fileName: fileName,
          removed: result
        }
      });
    }
    
    return result;
  }

  // Get all pending confirmations
  getAllPendingConfirmations() {
    const confirmations = Array.from(pendingConfirmations.entries()).map(([fileName, data]) => ({
      fileName,
      ...data
    }));
    
    this.logger.debug('Retrieved all pending confirmations', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'getAllPendingConfirmations',
        pendingCount: confirmations.length
      }
    });
    
    return confirmations;
  }

  // Confirm a match
  confirmMatch(fileName, projectId, modrinthData) {
    this.logger.info('Confirming mod match', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'confirmMatch',
        fileName: fileName,
        projectId: projectId,
        modTitle: modrinthData?.title,
        modSlug: modrinthData?.slug
      }
    });
    
    confirmedMatches.set(fileName, {
      projectId,
      modrinthData,
      confirmedAt: Date.now()
    });
    this.removePendingConfirmation(fileName);
    
    // Save to disk immediately
    this.saveToDisk();
  }

  // Get confirmed match
  getConfirmedMatch(fileName) {
    const match = confirmedMatches.get(fileName) || null;
    
    this.logger.debug('Retrieved confirmed mod match', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'getConfirmedMatch',
        fileName: fileName,
        hasMatch: !!match,
        projectId: match?.projectId
      }
    });
    
    return match;
  }

  // Get all confirmed matches
  getAllConfirmedMatches() {
    const matches = Array.from(confirmedMatches.entries()).map(([fileName, data]) => ({
      fileName,
      ...data
    }));
    
    this.logger.debug('Retrieved all confirmed matches', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'getAllConfirmedMatches',
        confirmedCount: matches.length
      }
    });
    
    return matches;
  }

  // Reject a match
  rejectMatch(fileName, reason = 'User rejected') {
    this.logger.info('Rejecting mod match', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'rejectMatch',
        fileName: fileName,
        reason: reason
      }
    });
    
    rejectedMatches.set(fileName, {
      rejectedAt: Date.now(),
      reason
    });
    this.removePendingConfirmation(fileName);
  }

  // Check if a match was rejected
  isMatchRejected(fileName) {
    const isRejected = rejectedMatches.has(fileName);
    
    this.logger.debug('Checked if mod match was rejected', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'isMatchRejected',
        fileName: fileName,
        isRejected: isRejected
      }
    });
    
    return isRejected;
  }

  // Clear all data for a mod (when mod is deleted)
  clearModData(fileName) {
    this.logger.info('Clearing all mod data', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'clearModData',
        fileName: fileName,
        hadMatching: modMatchingStore.has(fileName),
        hadPending: pendingConfirmations.has(fileName),
        hadConfirmed: confirmedMatches.has(fileName),
        hadRejected: rejectedMatches.has(fileName)
      }
    });
    
    modMatchingStore.delete(fileName);
    pendingConfirmations.delete(fileName);
    const hadConfirmedMatch = confirmedMatches.has(fileName);
    confirmedMatches.delete(fileName);
    rejectedMatches.delete(fileName);
    
    // Save to disk if we removed a confirmed match
    if (hadConfirmedMatch) {
      this.saveToDisk();
    }
  }

  // Check if mod has Modrinth data
  hasModrinthData(fileName) {
    const hasData = confirmedMatches.has(fileName);
    
    this.logger.debug('Checked if mod has Modrinth data', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'hasModrinthData',
        fileName: fileName,
        hasData: hasData
      }
    });
    
    return hasData;
  }

  // Get mod status
  getModStatus(fileName) {
    let status;
    if (confirmedMatches.has(fileName)) {
      status = 'confirmed';
    } else if (pendingConfirmations.has(fileName)) {
      status = 'pending';
    } else if (rejectedMatches.has(fileName)) {
      status = 'rejected';
    } else if (modMatchingStore.has(fileName)) {
      status = 'searched';
    } else {
      status = 'unknown';
    }
    
    this.logger.debug('Retrieved mod status', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'getModStatus',
        fileName: fileName,
        status: status
      }
    });
    
    return status;
  }

  // Export data for persistence (if needed later)
  exportData() {
    const data = {
      matching: Array.from(modMatchingStore.entries()),
      pending: Array.from(pendingConfirmations.entries()),
      confirmed: Array.from(confirmedMatches.entries()),
      rejected: Array.from(rejectedMatches.entries()),
      exportedAt: Date.now()
    };
    
    this.logger.debug('Exported mod matching data', {
      category: 'storage',
      data: {
        service: 'mod-matching-manager',
        operation: 'exportData',
        matchingCount: data.matching.length,
        pendingCount: data.pending.length,
        confirmedCount: data.confirmed.length,
        rejectedCount: data.rejected.length
      }
    });
    
    return data;
  }

  // Import data from persistence (if needed later)
  importData(data) {
    this.logger.info('Importing mod matching data', {
      category: 'storage',
      data: {
        service: 'mod-matching-manager',
        operation: 'importData',
        hasMatching: !!(data?.matching?.length),
        hasPending: !!(data?.pending?.length),
        hasConfirmed: !!(data?.confirmed?.length),
        hasRejected: !!(data?.rejected?.length),
        matchingCount: data?.matching?.length || 0,
        pendingCount: data?.pending?.length || 0,
        confirmedCount: data?.confirmed?.length || 0,
        rejectedCount: data?.rejected?.length || 0
      }
    });
    
    if (data.matching) {
      data.matching.forEach(([key, value]) => modMatchingStore.set(key, value));
    }
    if (data.pending) {
      data.pending.forEach(([key, value]) => pendingConfirmations.set(key, value));
    }
    if (data.confirmed) {
      data.confirmed.forEach(([key, value]) => confirmedMatches.set(key, value));
    }
    if (data.rejected) {
      data.rejected.forEach(([key, value]) => rejectedMatches.set(key, value));
    }
  }

  // Clean old data (remove entries older than specified time)
  cleanOldData(maxAgeMs = 24 * 60 * 60 * 1000) { // Default: 24 hours
    const now = Date.now();
    let cleanedMatching = 0;
    let cleanedPending = 0;
    
    this.logger.debug('Starting old data cleanup', {
      category: 'mods',
      data: {
        service: 'mod-matching-manager',
        operation: 'cleanOldData',
        maxAgeMs: maxAgeMs,
        maxAgeHours: maxAgeMs / (60 * 60 * 1000)
      }
    });
    
    // Clean old matching data
    for (const [key, value] of modMatchingStore.entries()) {
      if (value.lastUpdated && (now - value.lastUpdated) > maxAgeMs) {
        modMatchingStore.delete(key);
        cleanedMatching++;
      }
    }

    // Clean old pending confirmations (they should be acted upon quickly)
    for (const [key, value] of pendingConfirmations.entries()) {
      if (value.createdAt && (now - value.createdAt) > maxAgeMs) {
        pendingConfirmations.delete(key);
        cleanedPending++;
      }
    }
    
    if (cleanedMatching > 0 || cleanedPending > 0) {
      this.logger.info('Cleaned old mod matching data', {
        category: 'mods',
        data: {
          service: 'mod-matching-manager',
          operation: 'cleanOldData',
          cleanedMatching: cleanedMatching,
          cleanedPending: cleanedPending,
          remainingMatching: modMatchingStore.size,
          remainingPending: pendingConfirmations.size
        }
      });
    } else {
      this.logger.debug('No old data to clean', {
        category: 'mods',
        data: {
          service: 'mod-matching-manager',
          operation: 'cleanOldData'
        }
      });
    }
  }
}

// Export singleton instance
const modMatchingManager = new ModMatchingManager();

module.exports = { modMatchingManager };
