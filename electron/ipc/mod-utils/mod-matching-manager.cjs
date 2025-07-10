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
  try {
    const dataToSave = {
      confirmed: Array.from(confirmedMatches.entries()),
      savedAt: Date.now()
    };
    
    const filePath = getPersistencePath();
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (error) {
    // TODO: Add proper logging - Error saving confirmed matches
  }
}

// Load confirmed matches from disk
function loadConfirmedMatches() {
  try {
    const filePath = getPersistencePath();
    
    if (!fs.existsSync(filePath)) {
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (data.confirmed && Array.isArray(data.confirmed)) {
      data.confirmed.forEach(([fileName, matchData]) => {
        confirmedMatches.set(fileName, matchData);
      });
    }
  } catch (error) {
    // TODO: Add proper logging - Error loading confirmed matches
  }
}

class ModMatchingManager {
  
  constructor() {
    // Load saved matches on initialization
    this.loadFromDisk();
  }
  
  // Load confirmed matches from disk
  loadFromDisk() {
    loadConfirmedMatches();
  }
  
  // Save confirmed matches to disk
  saveToDisk() {
    saveConfirmedMatches();
  }
  
  // Set matching data for a mod
  setModMatchingData(fileName, data) {
    modMatchingStore.set(fileName, {
      ...data,
      lastUpdated: Date.now()
    });
  }

  // Get matching data for a mod
  getModMatchingData(fileName) {
    return modMatchingStore.get(fileName) || null;
  }

  // Set pending confirmation for a mod
  setPendingConfirmation(fileName, confirmationData) {
    pendingConfirmations.set(fileName, {
      ...confirmationData,
      createdAt: Date.now()
    });
  }

  // Get pending confirmation for a mod
  getPendingConfirmation(fileName) {
    return pendingConfirmations.get(fileName) || null;
  }

  // Remove pending confirmation
  removePendingConfirmation(fileName) {
    return pendingConfirmations.delete(fileName);
  }

  // Get all pending confirmations
  getAllPendingConfirmations() {
    return Array.from(pendingConfirmations.entries()).map(([fileName, data]) => ({
      fileName,
      ...data
    }));
  }

  // Confirm a match
  confirmMatch(fileName, projectId, modrinthData) {
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
    return confirmedMatches.get(fileName) || null;
  }

  // Get all confirmed matches
  getAllConfirmedMatches() {
    return Array.from(confirmedMatches.entries()).map(([fileName, data]) => ({
      fileName,
      ...data
    }));
  }

  // Reject a match
  rejectMatch(fileName, reason = 'User rejected') {
    rejectedMatches.set(fileName, {
      rejectedAt: Date.now(),
      reason
    });
    this.removePendingConfirmation(fileName);
  }

  // Check if a match was rejected
  isMatchRejected(fileName) {
    return rejectedMatches.has(fileName);
  }

  // Clear all data for a mod (when mod is deleted)
  clearModData(fileName) {
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
    return confirmedMatches.has(fileName);
  }

  // Get mod status
  getModStatus(fileName) {
    if (confirmedMatches.has(fileName)) {
      return 'confirmed';
    }
    if (pendingConfirmations.has(fileName)) {
      return 'pending';
    }
    if (rejectedMatches.has(fileName)) {
      return 'rejected';
    }
    if (modMatchingStore.has(fileName)) {
      return 'searched';
    }
    return 'unknown';
  }

  // Export data for persistence (if needed later)
  exportData() {
    return {
      matching: Array.from(modMatchingStore.entries()),
      pending: Array.from(pendingConfirmations.entries()),
      confirmed: Array.from(confirmedMatches.entries()),
      rejected: Array.from(rejectedMatches.entries()),
      exportedAt: Date.now()
    };
  }

  // Import data from persistence (if needed later)
  importData(data) {
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
    
    // Clean old matching data
    for (const [key, value] of modMatchingStore.entries()) {
      if (value.lastUpdated && (now - value.lastUpdated) > maxAgeMs) {
        modMatchingStore.delete(key);
      }
    }

    // Clean old pending confirmations (they should be acted upon quickly)
    for (const [key, value] of pendingConfirmations.entries()) {
      if (value.createdAt && (now - value.createdAt) > maxAgeMs) {
        pendingConfirmations.delete(key);
      }
    }
  }
}

// Export singleton instance
const modMatchingManager = new ModMatchingManager();

module.exports = { modMatchingManager };
