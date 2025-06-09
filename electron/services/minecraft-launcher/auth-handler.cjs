const fs = require('fs');
const path = require('path');
const { Auth } = require('msmc'); // Specific to authentication
const { v4: uuidv4 } = require('uuid');

class AuthHandler {
  constructor(eventEmitter) {
    this.authData = null;
    this.emitter = eventEmitter; // To emit events like 'auth-success', 'auth-error'
  }

  // Microsoft Authentication
  async authenticateWithMicrosoft() {
    try {
      console.log('[AuthHandler] Starting Microsoft authentication...');
      
      // Create MSMC Auth instance
      const authManager = new Auth("select_account");
      
      // Launch authentication flow
      const xboxManager = await authManager.launch("electron", {
        /* You can add custom options here */
      });
      
      // Generate the Minecraft login token
      const token = await xboxManager.getMinecraft();
      
      if (token && token.profile) {
        this.authData = {
          access_token: token.mcToken,
          client_token: uuidv4(),
          uuid: token.profile.id.replace(/-/g, ''),
          name: token.profile.name,
          user_properties: {},
          meta: xboxManager, // Store the whole MSMC token object for refresh
          savedAt: new Date().toISOString()
        };
        
        console.log(`[AuthHandler] ✅ Authentication successful for user: ${token.profile.name}`);
        this.emitter.emit('auth-success', { username: token.profile.name, uuid: token.profile.id });
        
        return { success: true, username: token.profile.name, uuid: token.profile.id };
      } else {
        throw new Error('Authentication failed: No token received');
      }
    } catch (error) {
      console.error('[AuthHandler] Authentication error:', error);
      this.emitter.emit('auth-error', error.message);
      return { success: false, error: error.message };
    }
  }
  
  // Save authentication data to file
  async saveAuthData(clientPath) {
    if (!this.authData || !clientPath) {
      return { success: false, error: 'No auth data or client path' };
    }
    
    try {
      const authFile = path.join(clientPath, 'auth.json');
      
      // Try to extract serializable refresh data from MSMC meta object
      let refreshData = null;
      if (this.authData.meta && typeof this.authData.meta === 'object') {
        // Try to extract refresh token or session data
        if (this.authData.meta.cache) {
          refreshData = {
            cache: this.authData.meta.cache,
            type: 'msmc_cache'
          };
        } else if (this.authData.meta.msa && this.authData.meta.xbl) {
          refreshData = {
            msa: this.authData.meta.msa,
            xbl: this.authData.meta.xbl,
            type: 'session_data'
          };
        }
      }
      
      const authDataToSave = {
        access_token: this.authData.access_token,
        client_token: this.authData.client_token,
        uuid: this.authData.uuid,
        name: this.authData.name,
        user_properties: this.authData.user_properties || {},
        savedAt: new Date().toISOString(),
        refreshData: refreshData // Save serializable refresh data
      };
      
      fs.writeFileSync(authFile, JSON.stringify(authDataToSave, null, 2));
      console.log('[AuthHandler] ✅ Authentication data saved with refresh capability');
      return { success: true };
    } catch (error) {
      console.error('[AuthHandler] Error saving auth data:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Load saved authentication data
  async loadAuthData(clientPath) {
    try {
      const authFile = path.join(clientPath, 'auth.json');
      
      if (!fs.existsSync(authFile)) {
        return { success: false, error: 'No saved authentication found' };
      }
      
      const authDataRaw = fs.readFileSync(authFile, 'utf8');
      const savedAuthData = JSON.parse(authDataRaw);
      
      // Check if auth data is still valid (more lenient check)
      const savedDate = new Date(savedAuthData.savedAt);
      const now = new Date();
      const hoursSinceSaved = (now - savedDate) / (1000 * 60 * 60);
      
      // Previously we enforced a maximum token age which resulted in
      // users being forced to re-authenticate after a few hours.
      // To allow long-lived sessions we simply load the saved token
      // regardless of its age and rely on refresh logic to keep it valid.
      
      this.authData = {
        access_token: savedAuthData.access_token,
        client_token: savedAuthData.client_token || uuidv4(), // Generate if missing
        uuid: savedAuthData.uuid,
        name: savedAuthData.name,
        user_properties: savedAuthData.user_properties || {},
        savedAt: savedAuthData.savedAt,
        meta: null // Will be restored if possible
      };
      
      // If we generated a new client_token, save it immediately
      if (!savedAuthData.client_token) {
        console.log('[AuthHandler] Generated missing client_token, saving updated auth data...');
        try {
          await this.saveAuthData(clientPath);
          console.log('[AuthHandler] ✅ Updated auth data saved with new client_token');
        } catch (saveError) {
          console.warn('[AuthHandler] ⚠️ Could not save updated auth data:', saveError.message);
        }
      }
      
      // Try to restore refresh capability from saved data
      if (savedAuthData.refreshData) {
        try {
          if (savedAuthData.refreshData.type === 'msmc_cache') {
            // Try to restore MSMC with cache
            const { Auth } = require('msmc');
            const authManager = new Auth("select_account");
            if (authManager.cache && savedAuthData.refreshData.cache) {
              authManager.cache = savedAuthData.refreshData.cache;
              this.authData.meta = authManager;
              console.log('[AuthHandler] ✅ Restored MSMC auth manager with cache');
            }
          }
        } catch (restoreError) {
          console.warn('[AuthHandler] Could not restore refresh capability:', restoreError.message);
        }
      }
        console.log(`[AuthHandler] ✅ Loaded saved authentication for: ${savedAuthData.name}`);
      // console.log(`[AuthHandler] Token age: ${hoursSinceSaved.toFixed(1)} hours`);
      
      const hasRefreshCapability = this.authData.meta && typeof this.authData.meta.launch === 'function';
      console.log(`[AuthHandler] Refresh capability: ${hasRefreshCapability ? 'Available' : 'Limited'}`);
      
      return { 
        success: true, 
        username: savedAuthData.name, 
        uuid: savedAuthData.uuid,
        needsRefresh: hoursSinceSaved > 1 && !hasRefreshCapability // Only refresh if old and no capability
      };
    } catch (error) {
      console.error('[AuthHandler] Error loading auth data:', error);
      return { success: false, error: error.message };
    }
  }

  // Check if authentication is valid and refresh if needed
  async checkAndRefreshAuth() {
    if (!this.authData) {
      return { success: false, error: 'No authentication data' };
    }
    
    try {
      // Check token age first
      const savedDate = new Date(this.authData.savedAt || 0);      const now = new Date();
      const hoursSinceSaved = (now - savedDate) / (1000 * 60 * 60);
      
      // console.log(`[AuthHandler] Token age: ${hoursSinceSaved.toFixed(1)} hours`);
      
      // If token is very fresh (less than 30 minutes), just use it
      if (hoursSinceSaved < 0.5) {
        console.log('[AuthHandler] ✅ Token is very fresh, no refresh needed');
        return { success: true, refreshed: false };
      }
      
      // If we have MSMC meta data, try to refresh
      if (this.authData.meta && (typeof this.authData.meta.refresh === 'function' || typeof this.authData.meta.launch === 'function')) {
        console.log('[AuthHandler] Attempting to refresh authentication token...');
        
        try {
          let refreshedToken = null;
          
          // Try different refresh methods based on available MSMC API
          if (typeof this.authData.meta.refresh === 'function') {
            const refreshedXboxManager = await this.authData.meta.refresh();
            if (refreshedXboxManager && typeof refreshedXboxManager.getMinecraft === 'function') {
              refreshedToken = await refreshedXboxManager.getMinecraft();
            }
          } else if (typeof this.authData.meta.launch === 'function') {
            // Alternative refresh method
            refreshedToken = await this.authData.meta.getMinecraft();
          }

          if (refreshedToken && refreshedToken.profile) {
            // Update our stored auth data with fresh token
            const originalClientToken = this.authData.client_token;
            
            this.authData = {
              access_token: refreshedToken.mcToken,
              client_token: originalClientToken, // Keep original, don't set to null
              uuid: refreshedToken.profile.id.replace(/-/g, ''), // Ensure no dashes
              name: refreshedToken.profile.name,
              user_properties: this.authData.user_properties || {}, // Preserve user properties
              meta: this.authData.meta, // Keep the meta object
              savedAt: new Date().toISOString()
            };
            
            console.log(`[AuthHandler] ✅ Authentication refreshed successfully for: ${refreshedToken.profile.name}`);
            console.log(`[AuthHandler] ✅ Preserved original clientToken for session continuity`);
            return { success: true, refreshed: true };
          } else {
            throw new Error('Refresh succeeded but returned invalid token data');
          }
        } catch (refreshError) {
          console.warn('[AuthHandler] Token refresh failed:', refreshError.message);
          
          // If it's a network error and token isn't too old, use cached token
          if (refreshError.message && (
            refreshError.message.includes('ENOTFOUND') ||
            refreshError.message.includes('authserver.mojang.com') ||
            refreshError.message.includes('timeout') ||
            refreshError.message.includes('network') ||
            refreshError.message.includes('ETIMEDOUT') ||
            refreshError.message.includes('ECONNRESET')
          )) {
            if (hoursSinceSaved < 4) {
              console.log('[AuthHandler] ⚠️ Using cached token due to network issues');
              return { success: true, refreshed: false, networkError: true };
            } else {
              console.log('[AuthHandler] Token too old and network refresh failed, continuing with cached token');
              return { success: true, refreshed: false, networkError: true, refreshFailed: true };
            }
          }
          
          // For other errors, check if token is still usable
          if (hoursSinceSaved < 3) {
            console.log('[AuthHandler] ⚠️ Refresh failed but token is still relatively fresh, proceeding');
            return { success: true, refreshed: false, refreshFailed: true };
          } else {
            console.log('[AuthHandler] Token refresh failed and token is old, continuing with cached token');
            return { success: true, refreshed: false, refreshFailed: true };
          }
      }
    }

      // If no refresh capability just log token age; we no longer force re-authentication
      if (hoursSinceSaved > 6) {
        console.log('[AuthHandler] Token is old and cannot be refreshed, continuing with cached token');
      }
      
      console.log('[AuthHandler] ✅ Token is acceptable, proceeding without refresh');
      return { success: true, refreshed: false };
      
    } catch (error) {
      console.error('[AuthHandler] Error checking/refreshing authentication:', error);
      
      // Handle network errors gracefully
      if (error.message && (
        error.message.includes('ENOTFOUND') ||
        error.message.includes('authserver.mojang.com') ||
        error.message.includes('network') ||
        error.message.includes('timeout') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ECONNRESET')
      )) {
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const hoursSinceSaved = (now - savedDate) / (1000 * 60 * 60);
        
        if (hoursSinceSaved < 8) { // Allow up to 8 hours for network issues
          console.log('[AuthHandler] ⚠️ Using cached token due to network issues');
          return { success: true, refreshed: false, networkError: true };
        }
      }
      
      // On unexpected errors fallback to cached token instead of forcing re-authentication
      return { success: true, refreshed: false, refreshFailed: true, error: error.message };
    }
  }
}

module.exports = { AuthHandler };
