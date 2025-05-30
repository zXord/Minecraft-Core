const fs = require('fs');
const path = require('path');
const { Auth } = require('msmc'); // Specific to authentication

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
          client_token: null, // MSMC doesn't use client_token
          uuid: token.profile.id,
          name: token.profile.name,
          user_properties: {},
          meta: token // Store the whole MSMC token object for refresh
        };
        
        console.log(`[AuthHandler] Authentication successful for user: ${token.profile.name}`);
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
      const authDataToSave = {
        ...this.authData,
        savedAt: new Date().toISOString()
      };
      
      fs.writeFileSync(authFile, JSON.stringify(authDataToSave, null, 2));
      console.log('[AuthHandler] Authentication data saved');
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
      
      // Check if auth data is still valid (basic check - tokens may need refresh)
      const savedDate = new Date(savedAuthData.savedAt);
      const now = new Date();
      const hoursSinceSaved = (now - savedDate) / (1000 * 60 * 60);
      
      if (hoursSinceSaved > 24) {
        console.log('[AuthHandler] Saved auth data is old, will need re-authentication');
        return { success: false, error: 'Authentication expired' };
      }
      
      this.authData = savedAuthData; // Restore authData including MSMC meta object
      console.log(`[AuthHandler] Loaded saved authentication for: ${savedAuthData.name}`);
      
      return { 
        success: true, 
        username: savedAuthData.name, 
        uuid: savedAuthData.uuid,
        needsRefresh: hoursSinceSaved > 1 // Suggest refresh if > 1 hour old
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
      // Check if we have MSMC meta data for refreshing
      // The 'meta' object from msmc contains the refresh() method
      if (this.authData.meta && typeof this.authData.meta.refresh === 'function') {
        console.log('[AuthHandler] Attempting to refresh authentication token...');
        
        try {
          // Try to refresh the token using MSMC with timeout and error handling
          // MSMC's refresh() itself returns a new Xbox Live manager object
          const xboxManager = this.authData.meta; // The stored meta IS the xboxManager
          const refreshedXboxManager = await xboxManager.refresh(); // Call refresh on it
          const refreshedToken = await refreshedXboxManager.getMinecraft(); // Get new MC token

          if (refreshedToken && refreshedToken.profile) {
            // Update our stored auth data
            this.authData = {
              access_token: refreshedToken.mcToken,
              client_token: null,
              uuid: refreshedToken.profile.id,
              name: refreshedToken.profile.name,
              user_properties: {},
              meta: refreshedXboxManager, // Store the new manager object for future refreshes
              savedAt: new Date().toISOString()
            };
            
            console.log(`[AuthHandler] Authentication refreshed successfully for: ${refreshedToken.profile.name}`);
            return { success: true, refreshed: true };
          } else {
            // This case should ideally not happen if refresh() succeeded
             console.warn('[AuthHandler] Token refresh seemed to succeed but no profile data found.');
             // Fall through to check token age as a precaution
          }
        } catch (refreshError) {
          console.warn('[AuthHandler] Token refresh failed (this is often normal):', refreshError.message);
          
          if (refreshError.message && (
            refreshError.message.includes('ENOTFOUND') ||
            refreshError.message.includes('authserver.mojang.com') ||
            refreshError.message.includes('timeout') ||
            refreshError.message.includes('network')
          )) {
            console.log('[AuthHandler] Network error during token refresh - using existing token');
            return { success: true, refreshed: false, networkError: true };
          }
          // For other errors (like invalid_token), let it fall through to check age / re-auth
        }
      }
      
      // If no refresh capability or refresh failed, check token age
      const savedDate = new Date(this.authData.savedAt || 0); // Use epoch if savedAt is missing
      const now = new Date();
      const hoursSinceSaved = (now - savedDate) / (1000 * 60 * 60);
      
      if (hoursSinceSaved > 24) { // More lenient token age check
        console.log('[AuthHandler] Authentication token is old and refresh failed or not possible, needs re-authentication.');
        return { success: false, error: 'Authentication may be expired', needsReauth: true };
      }
      
      // If token is not too old, consider it valid even if refresh failed for non-network reasons
      console.log('[AuthHandler] Token is not expired, proceeding with current token.');
      return { success: true, refreshed: false };
      
    } catch (error) {
      console.error('[AuthHandler] Error checking/refreshing authentication:', error);
      
      if (error.message && (
        error.message.includes('ENOTFOUND') ||
        error.message.includes('authserver.mojang.com') ||
        error.message.includes('network') ||
        error.message.includes('timeout')
      )) {
        console.log('[AuthHandler] Network error during auth check - proceeding with cached token');
        return { success: true, refreshed: false, networkError: true };
      }
      
      // For other errors, assume re-authentication is needed
      return { success: false, error: error.message, needsReauth: true };
    }
  }
}

module.exports = { AuthHandler };
