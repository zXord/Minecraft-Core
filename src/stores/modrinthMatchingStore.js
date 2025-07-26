import { writable } from 'svelte/store';
import { safeInvoke } from '../utils/ipcUtils.js';

// Store for pending Modrinth confirmations
export const pendingModrinthConfirmations = writable(new Map());

// Store for confirmed matches
export const confirmedModrinthMatches = writable(new Map());

// Store for search states (checking, failed, no-matches, etc.)
export const modrinthSearchStates = writable(new Map());

// Store for tracking modal states
export const modrinthMatchingModals = writable({
  confirmationModal: { visible: false, mod: null },
  manualMatchingModal: { visible: false, mod: null }
});

// Functions to manage Modrinth matching states
export const modrinthMatchingActions = {
  // Set search state for a mod
  setSearchState(fileName, state, data = {}) {
    modrinthSearchStates.update(states => {
      const newStates = new Map(states);
      newStates.set(fileName, {
        state, // 'checking', 'found', 'no-matches', 'failed'
        timestamp: Date.now(),
        ...data
      });
      return newStates;
    });
  },

  // Clear search state for a mod
  clearSearchState(fileName) {
    modrinthSearchStates.update(states => {
      const newStates = new Map(states);
      newStates.delete(fileName);
      return newStates;
    });
  },

  // Load all pending confirmations from backend
  async loadPendingConfirmations() {
    try {
      const result = await safeInvoke('get-all-pending-confirmations');
      if (result && result.success) {
        const pendingMap = new Map();
        result.pending.forEach(item => {
          pendingMap.set(item.fileName, item);
        });
        pendingModrinthConfirmations.set(pendingMap);
      }
    } catch {
      // TODO: Add proper logging - Error loading pending confirmations
    }
  },

  // Load confirmed matches from backend
  async loadConfirmedMatches() {
    try {
      const result = await safeInvoke('get-all-confirmed-matches');
      
      if (result && result.success) {
        const confirmedMap = new Map();
        result.confirmed.forEach(item => {
          confirmedMap.set(item.fileName, item);
        });
        confirmedModrinthMatches.set(confirmedMap);
      }
    } catch {
      // TODO: Add proper logging - Error loading confirmed matches
    }
  },

  // Get matching status for a specific mod
  async getModMatchingStatus(fileName) {
    try {
      const result = await safeInvoke('get-mod-matching-status', { fileName });
      if (result && result.success) {
        return result;
      }
    } catch {
      // TODO: Add proper logging - Error getting matching status for mod
    }
    return null;
  },

  // Confirm a Modrinth match
  async confirmMatch(fileName, projectId, modrinthData) {
    try {
      const result = await safeInvoke('confirm-modrinth-match', {
        fileName,
        projectId,
        modrinthData
      });

      if (result && result.success) {
        // Update local stores
        pendingModrinthConfirmations.update(pending => {
          const newPending = new Map(pending);
          newPending.delete(fileName);
          return newPending;
        });

        confirmedModrinthMatches.update(confirmed => {
          const newConfirmed = new Map(confirmed);
          newConfirmed.set(fileName, { projectId, modrinthData, confirmedAt: Date.now() });
          return newConfirmed;
        });

        return true;
      }
    } catch {
      // TODO: Add proper logging - Error confirming match for mod
    }
    return false;
  },

  // Reject a Modrinth match
  async rejectMatch(fileName, reason = 'User rejected') {
    try {
      const result = await safeInvoke('reject-modrinth-match', {
        fileName,
        reason
      });

      if (result && result.success) {
        // Update local stores
        pendingModrinthConfirmations.update(pending => {
          const newPending = new Map(pending);
          newPending.delete(fileName);
          return newPending;
        });

        return true;
      }
    } catch {
      // TODO: Add proper logging - Error rejecting match for mod
    }
    return false;
  },

  // Show confirmation modal
  showConfirmationModal(modData) {
    modrinthMatchingModals.update(modals => ({
      ...modals,
      confirmationModal: { visible: true, mod: modData }
    }));
  },

  // Hide confirmation modal
  hideConfirmationModal() {
    modrinthMatchingModals.update(modals => ({
      ...modals,
      confirmationModal: { visible: false, mod: null }
    }));
  },

  // Show manual matching modal
  showManualMatchingModal(modData) {
    modrinthMatchingModals.update(modals => ({
      ...modals,
      manualMatchingModal: { visible: true, mod: modData }
    }));
  },

  // Hide manual matching modal
  hideManualMatchingModal() {
    modrinthMatchingModals.update(modals => ({
      ...modals,
      manualMatchingModal: { visible: false, mod: null }
    }));
  },

  // Manual search for Modrinth mods
  async searchModrinthManual(query, loader = 'fabric', limit = 20) {
    try {
      const result = await safeInvoke('search-modrinth-manual', {
        query,
        loader,
        limit
      });

      if (result && result.success) {
        return result.results;
      }
    } catch {
      // TODO: Add proper logging - Error in manual Modrinth search
    }
    return [];
  },

  // Get Modrinth project details
  async getProjectDetails(projectId) {
    try {
      const result = await safeInvoke('get-modrinth-project-details', { projectId });
      if (result && result.success) {
        return result;
      }
    } catch {
      // TODO: Add proper logging - Error getting project details
    }
    return null;
  },

  // Clear matching data for a mod (when deleted)
  async clearModMatchingData(fileName) {
    try {
      await safeInvoke('clear-mod-matching-data', { fileName });
      
      // Update local stores
      pendingModrinthConfirmations.update(pending => {
        const newPending = new Map(pending);
        newPending.delete(fileName);
        return newPending;
      });

      confirmedModrinthMatches.update(confirmed => {
        const newConfirmed = new Map(confirmed);
        newConfirmed.delete(fileName);
        return newConfirmed;
      });

      // Clear search state
      this.clearSearchState(fileName);
    } catch {
      // TODO: Add proper logging - Error clearing matching data for mod
    }
  },

  // Reset matching decision for a mod (for re-matching)
  async resetMatchingDecision(fileName) {
    try {
      const result = await safeInvoke('reset-matching-decision', { fileName });
      if (result && result.success) {
        // Update local stores
        pendingModrinthConfirmations.update(pending => {
          const newPending = new Map(pending);
          newPending.delete(fileName);
          return newPending;
        });

        confirmedModrinthMatches.update(confirmed => {
          const newConfirmed = new Map(confirmed);
          newConfirmed.delete(fileName);
          return newConfirmed;
        });

        // Clear search state
        this.clearSearchState(fileName);
        
        return true;
      }
    } catch {
      // TODO: Add proper logging - Error resetting matching decision for mod
    }
    return false;
  }
};

// Load initial data on module initialization
if (typeof window !== 'undefined') {
  modrinthMatchingActions.loadPendingConfirmations();
  modrinthMatchingActions.loadConfirmedMatches();
}
