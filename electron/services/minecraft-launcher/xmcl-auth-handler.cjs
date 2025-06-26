const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { MicrosoftAuthenticator } = require('@xmcl/user');

/**
 * Advanced authentication handler using @xmcl/user library
 * Provides automatic token refresh and seamless authentication experience
 */
class XMCLAuthHandler {
  constructor(eventEmitter) {
    this.authData = null;
    this.emitter = eventEmitter;
    this.authenticator = new MicrosoftAuthenticator();
    
    // Authentication state tracking
    this.isAuthenticating = false;
    this.lastRefreshTime = null;
    this.refreshPromise = null;
  }

  /**
   * Authenticate with Microsoft using @xmcl/user
   * This method handles the initial authentication flow
   */
  async authenticateWithMicrosoft() {
    if (this.isAuthenticating) {
      throw new Error('Authentication already in progress');
    }

    try {
      this.isAuthenticating = true;


      // For now, we'll use a hybrid approach:
      // Use @xmcl/user for Xbox Live authentication, but handle Microsoft OAuth manually
      // This is because @xmcl/user expects us to provide the Microsoft access token
      
      // We need to implement Microsoft OAuth flow first, then use @xmcl/user for Xbox authentication
      // For now, let's fall back to MSMC for the Microsoft OAuth part
      const { Auth } = require('msmc');
      const authManager = new Auth("select_account");
      const xboxManager = await authManager.launch("electron");
      
      // Now use @xmcl/user for the Xbox/Minecraft part      // Extract the Microsoft access token from MSMC result
      if (!xboxManager.msToken) {
        throw new Error('Failed to get Microsoft access token');
      }
      

        // Use @xmcl/user to authenticate with Xbox Live
      // REVERTED: Use the original working API flow with better error handling
      const xboxLiveToken = await this.authenticator.authenticateXboxLive(xboxManager.msToken.access_token);
      
      if (!xboxLiveToken) {
        throw new Error('Xbox Live authentication failed');
      }
      

      
      // Authorize Xbox Live for Minecraft
      const xboxProfile = await this.authenticator.authorizeXboxLive(xboxLiveToken.Token);
      
      if (!xboxProfile) {
        throw new Error('Xbox Live authorization failed');
      }
      

      
      // Get the Minecraft access token - Use correct parameter order (uhs, xstsToken)
      const minecraftProfile = await this.authenticator.loginMinecraftWithXBox(
        xboxProfile.DisplayClaims.xui[0].uhs, 
        xboxProfile.Token
      );
      
      if (!minecraftProfile || !minecraftProfile.access_token) {
        throw new Error('Minecraft authentication failed');
      }
      

      
      // Get the game profile (we'll use the Minecraft token to get profile info)
      // For now, let's get the profile info from the original MSMC token since that's more reliable
      const originalToken = await xboxManager.getMinecraft();
      
      if (!originalToken || !originalToken.profile) {
        throw new Error('Failed to get game profile');
      }

      // Format UUID with dashes (Minecraft standard)
      let formattedUuid = originalToken.profile.id;
      if (!formattedUuid.includes('-')) {
        formattedUuid = `${formattedUuid.substring(0,8)}-${formattedUuid.substring(8,12)}-${formattedUuid.substring(12,16)}-${formattedUuid.substring(16,20)}-${formattedUuid.substring(20)}`;
      }

      // Store authentication data in our format
      this.authData = {
        access_token: minecraftProfile.access_token,
        client_token: uuidv4(),
        uuid: formattedUuid,
        name: originalToken.profile.name,
        user_properties: {},
        // Store tokens for refresh capability
        xmcl_tokens: {
          microsoft: xboxManager.msToken,
          xboxLive: xboxLiveToken,
          xboxProfile: xboxProfile,
          minecraft: minecraftProfile
        },
        msmc_meta: xboxManager, // Keep MSMC object for Microsoft token refresh
        savedAt: new Date().toISOString(),
        lastRefresh: new Date().toISOString()
      };


      
      this.emitter.emit('auth-success', { 
        username: originalToken.profile.name, 
        uuid: formattedUuid 
      });

      return { 
        success: true, 
        username: originalToken.profile.name, 
        uuid: formattedUuid 
      };

    } catch (error) {

      this.emitter.emit('auth-error', error.message);
      return { success: false, error: error.message };
    } finally {
      this.isAuthenticating = false;
    }
  }
  /**
   * Save authentication data to file
   */
  async saveAuthData(clientPath) {
    if (!this.authData || !clientPath) {
      return { success: false, error: 'No auth data or client path' };
    }

    try {
      const authFile = path.join(clientPath, 'xmcl-auth.json');
      
      // Prepare data to save (excluding non-serializable parts)
      const authDataToSave = {
        access_token: this.authData.access_token,
        client_token: this.authData.client_token,
        uuid: this.authData.uuid,
        name: this.authData.name,
        user_properties: this.authData.user_properties || {},
        savedAt: new Date().toISOString(),
        lastRefresh: this.authData.lastRefresh,
        // Store serializable parts of the XMCL tokens
        xmcl_tokens: this.authData.xmcl_tokens ? {
          microsoft: this.authData.xmcl_tokens.microsoft,
          // Don't store the full Xbox objects as they're not serializable
          // We'll regenerate them from the Microsoft token on load
        } : null,
        // Store serializable parts of MSMC metadata for refresh
        msmc_refresh_data: this.authData.msmc_meta ? {
          cache: this.authData.msmc_meta.cache,
          // Store other serializable refresh data if available
        } : null
      };

      fs.writeFileSync(authFile, JSON.stringify(authDataToSave, null, 2));

      return { success: true };

    } catch (error) {

      return { success: false, error: error.message };
    }
  }

  /**
   * Load saved authentication data
   */
  async loadAuthData(clientPath) {
    try {
      const authFile = path.join(clientPath, 'xmcl-auth.json');
      
      if (!fs.existsSync(authFile)) {
        return { success: false, error: 'No saved authentication found' };
      }

      const authDataRaw = fs.readFileSync(authFile, 'utf8');
      const savedAuthData = JSON.parse(authDataRaw);

      // Restore authentication data
      this.authData = {
        access_token: savedAuthData.access_token,
        client_token: savedAuthData.client_token || uuidv4(),
        uuid: savedAuthData.uuid,
        name: savedAuthData.name,
        user_properties: savedAuthData.user_properties || {},
        savedAt: savedAuthData.savedAt,
        lastRefresh: savedAuthData.lastRefresh,
        xmcl_tokens: savedAuthData.xmcl_tokens,
        msmc_meta: null // Will be restored if possible
      };

      // Try to restore MSMC metadata for refresh capability
      if (savedAuthData.msmc_refresh_data) {
        try {
          // Reconstruct MSMC object with cached data
          const { Auth } = require('msmc');
          const authManager = new Auth("select_account");
          
          if (savedAuthData.msmc_refresh_data.cache && 'cache' in authManager) {
            authManager['cache'] = savedAuthData.msmc_refresh_data.cache;
            this.authData.msmc_meta = authManager;
          }
        } catch (error) {

        }
      }

      

      return { 
        success: true, 
        username: savedAuthData.name, 
        uuid: savedAuthData.uuid
      };

    } catch (error) {

      return { success: false, error: error.message };
    }
  }

  /**
   * Check if authentication is valid and refresh if needed
   * This is the core method that ensures tokens are always fresh
   */
  async checkAndRefreshAuth() {
    if (!this.authData) {
      return { success: false, error: 'No authentication data', requiresAuth: true };
    }

    // If we're already refreshing, wait for that to complete
    if (this.refreshPromise) {
      try {
        return await this.refreshPromise;
      } catch (error) {
        this.refreshPromise = null;
        return { success: false, error: error.message };
      }
    }

    try {
      // Check token age
      const lastRefreshDate = new Date(this.authData.lastRefresh || this.authData.savedAt || 0);
      const now = new Date();
      const minutesSinceRefresh = (now.getTime() - lastRefreshDate.getTime()) / (1000 * 60);
      const hoursSinceRefresh = minutesSinceRefresh / 60;

      

      // Be much more lenient - if token is less than 48 hours old, just use it
      if (hoursSinceRefresh < 48) {

        return { success: true, refreshed: false };
      }

      // Only try to refresh if token is very old (over 48 hours) and we have refresh capability
      if (this.authData.msmc_meta || (this.authData.xmcl_tokens && this.authData.xmcl_tokens.microsoft)) {

        
        // Start refresh (store promise to prevent concurrent refreshes)
        this.refreshPromise = this.performTokenRefresh();
        
        try {
          const result = await this.refreshPromise;
          this.refreshPromise = null;
          return result;
        } catch (error) {
          this.refreshPromise = null;
          // If refresh fails, still allow using the old token for another 24 hours
          if (hoursSinceRefresh < 72) {

            return { success: true, refreshed: false, error: error.message };
          }
          throw error;
        }
      }

      // If token is older than 72 hours and we can't refresh, require re-auth
      if (hoursSinceRefresh > 72) {

        this.authData = null;
        return { 
          success: false, 
          error: `Token expired (${hoursSinceRefresh.toFixed(1)} hours old). Please authenticate again.`,
          requiresAuth: true 
        };
      }

      // Token is old but still usable

      return { success: true, refreshed: false };

    } catch (error) {


      // On error, if token isn't too old, try to use it anyway
      const savedDate = new Date(this.authData.savedAt || 0);
      const now = new Date();
      const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceSaved < 48) {
        return { success: true, refreshed: false, error: error.message };
      }

      return { success: false, error: error.message };
    }
  }
  /**
   * Perform the actual token refresh using hybrid approach
   */
  async performTokenRefresh() {
    try {


      // Use MSMC to refresh the Microsoft token first
      const msmc_meta = this.authData.msmc_meta;
      if (!msmc_meta) {
        // Instead of throwing error, handle gracefully

        
        // Check if the token is still relatively fresh
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceSaved < 8) {
          // Token is less than 8 hours old, still usable

          return { success: true, refreshed: false, usedCache: true };
        } else {
          // Token is too old, need fresh authentication
          this.authData = null;
          return { 
            success: false, 
            error: 'Authentication token expired and cannot be refreshed. Please authenticate again.',
            requiresAuth: true 
          };
        }
      }

      // Try to refresh the Microsoft token using MSMC
      let refreshedXboxManager = null;
      
      if (typeof msmc_meta.refresh === 'function') {
        refreshedXboxManager = await msmc_meta.refresh();
      } else if (typeof msmc_meta.launch === 'function') {
        // Alternative refresh method
        refreshedXboxManager = msmc_meta;
      } else {
        // Similar graceful handling for missing refresh methods

        
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceSaved < 8) {

          return { success: true, refreshed: false, usedCache: true };
        } else {
          this.authData = null;
          return { 
            success: false, 
            error: 'Authentication token expired and refresh method unavailable. Please authenticate again.',
            requiresAuth: true 
          };
        }
      }

      if (!refreshedXboxManager || !refreshedXboxManager.msToken) {
        throw new Error('Failed to refresh Microsoft token');
      }



      // Now use @xmcl/user to get fresh Xbox and Minecraft tokens
      const xboxLiveToken = await this.authenticator.authenticateXboxLive(refreshedXboxManager.msToken.access_token);
      
      if (!xboxLiveToken) {
        throw new Error('Xbox Live authentication failed during refresh');
      }

      const xboxProfile = await this.authenticator.authorizeXboxLive(xboxLiveToken.Token);
      
      if (!xboxProfile) {
        throw new Error('Xbox Live authorization failed during refresh');
      }

      // Use the xboxProfile to get the Minecraft access token
      const minecraftProfile = await this.authenticator.loginMinecraftWithXBox(
        xboxProfile.DisplayClaims.xui[0].uhs, 
        xboxProfile.Token
      );
      
      if (!minecraftProfile || !minecraftProfile.access_token) {
        throw new Error('Minecraft authentication failed during refresh');
      }

      // Get updated profile information
      const updatedToken = await refreshedXboxManager.getMinecraft();
      
      if (!updatedToken || !updatedToken.profile) {
        throw new Error('Failed to get updated profile information');
      }

      // Format UUID with dashes
      let formattedUuid = updatedToken.profile.id;
      if (!formattedUuid.includes('-')) {
        formattedUuid = `${formattedUuid.substring(0,8)}-${formattedUuid.substring(8,12)}-${formattedUuid.substring(12,16)}-${formattedUuid.substring(16,20)}-${formattedUuid.substring(20)}`;
      }

      // Update our auth data with refreshed tokens
      const originalClientToken = this.authData.client_token;
      
      this.authData = {
        access_token: minecraftProfile.access_token,
        client_token: originalClientToken, // Keep original client token
        uuid: formattedUuid,
        name: updatedToken.profile.name,
        user_properties: this.authData.user_properties || {},
        xmcl_tokens: {
          microsoft: refreshedXboxManager.msToken,
          xboxLive: xboxLiveToken,
          xboxProfile: xboxProfile,
          minecraft: minecraftProfile
        },
        msmc_meta: refreshedXboxManager,
        savedAt: this.authData.savedAt, // Keep original save time
        lastRefresh: new Date().toISOString()
      };

      this.lastRefreshTime = new Date();



      return { success: true, refreshed: true };

    } catch (error) {

      
      // Handle specific error cases
      if (error.message.includes('invalid_grant') || error.message.includes('expired')) {
        // Refresh token is expired, need full re-authentication
        this.authData = null;
        return { 
          success: false, 
          error: 'Refresh token expired. Please authenticate again.',
          requiresAuth: true 
        };
      }

      // For network errors or temporary issues, allow using cached token
      if (error.message.includes('ENOTFOUND') || 
          error.message.includes('timeout') || 
          error.message.includes('network')) {

        return { success: true, refreshed: false, networkError: true };
      }

      // For other errors, check if we can use cached token
      const savedDate = new Date(this.authData.savedAt || 0);
      const now = new Date();
      const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceSaved < 6) {
        return { success: true, refreshed: false, error: error.message };
      }

      throw error;
    }
  }

  /**
   * Clear authentication data (logout)
   */
  clearAuthData() {
    this.authData = null;
    this.lastRefreshTime = null;
    this.refreshPromise = null;

  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return this.authData !== null && this.authData.access_token !== null;
  }

  /**
   * Get current authentication status for UI
   */
  getAuthStatus() {
    if (!this.authData) {
      return {
        authenticated: false,
        username: null,
        uuid: null,
        needsRefresh: false
      };
    }

    const lastRefreshDate = new Date(this.authData.lastRefresh || this.authData.savedAt || 0);
    const now = new Date();
    const minutesSinceRefresh = (now.getTime() - lastRefreshDate.getTime()) / (1000 * 60);

    return {
      authenticated: true,
      username: this.authData.name,
      uuid: this.authData.uuid,
      needsRefresh: minutesSinceRefresh > 30, // Suggest refresh after 30 minutes
      lastRefresh: this.authData.lastRefresh
    };
  }
}

module.exports = { XMCLAuthHandler };
