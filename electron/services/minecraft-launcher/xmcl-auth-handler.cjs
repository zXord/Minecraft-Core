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
        // Save just the essential token data (these are serializable)
        msToken: this.authData.msmc_meta.msToken,
        xblToken: this.authData.msmc_meta.xblToken,
        exp: this.authData.msmc_meta.exp,
        // Don't save parent - it contains non-serializable methods
        // We'll recreate refresh capability using the tokens
        refreshCapable: true
      } : this.authData.msmc_refresh_tokens ? {
        // If we don't have msmc_meta but have refresh tokens, save those
        msToken: this.authData.msmc_refresh_tokens.msToken,
        xblToken: this.authData.msmc_refresh_tokens.xblToken,
        exp: this.authData.msmc_refresh_tokens.exp,
        refreshCapable: true
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
      if (savedAuthData.msmc_refresh_data && savedAuthData.msmc_refresh_data.refreshCapable) {
        const refreshData = savedAuthData.msmc_refresh_data;
        
        // Create a simple refresh-capable object using the saved tokens
        // This won't do automatic refresh but will allow manual refresh via the existing logic
        if (refreshData.msToken && refreshData.refreshCapable) {
          // Store the refresh data for potential use in refresh operations
          this.authData.msmc_refresh_tokens = refreshData;
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
  async checkAndRefreshAuth(forceRefresh = false) {
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
      
      // ATLauncher-style authentication: Silent refresh with graceful fallbacks
      // Try to keep tokens fresh, but don't bother users unless absolutely necessary
      
      // If forceRefresh is true (like on launch), always attempt refresh
      if (!forceRefresh) {
        // If token is less than 1 hour old, use it immediately (for background checks)
        if (hoursSinceRefresh < 1) {
          return { success: true, refreshed: false };
        }
      }

      // For tokens 1+ hours old, try silent refresh but don't fail if it doesn't work
      if (this.authData.msmc_meta || (this.authData.xmcl_tokens && this.authData.xmcl_tokens.microsoft)) {
        try {
          // Attempt silent refresh in background
          this.refreshPromise = this.performTokenRefresh();
          const result = await this.refreshPromise;
          this.refreshPromise = null;
          
          if (result.success && result.refreshed) {
            // Great! We got a fresh token silently
            return result;
          }
        } catch (error) {
          // Silent refresh failed, but that's OK - we'll use the cached token if it's not too old
          this.refreshPromise = null;
        }
      }

      // After failed refresh, decide whether to use cached token or require re-auth
      // If refresh failed and token is older than 3 days, Minecraft servers will likely reject it
      if (hoursSinceRefresh > 72) { // 3 days = 72 hours
        this.authData = null;
        return { 
          success: false, 
          error: `Token refresh failed and token is ${(hoursSinceRefresh/24).toFixed(1)} days old. Please re-authenticate.`,
          requiresAuth: true 
        };
      }

      // For tokens 1-72 hours old: Use cached token even if refresh failed
      // These should still work with Minecraft servers
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
      const msmc_refresh_tokens = this.authData.msmc_refresh_tokens;
      
      if (!msmc_meta && !msmc_refresh_tokens) {
        // Check if the token is still relatively fresh
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceSaved < 72) { // 3 days = 72 hours
          // Token is less than 3 days old, should still work with Minecraft servers
          return { success: true, refreshed: false, usedCache: true };
        } else {
          // Token is too old for Minecraft servers, require re-auth
          this.authData = null;
          return { 
            success: false, 
            error: 'Authentication token expired and cannot be refreshed. Please re-authenticate.',
            requiresAuth: true
          };
        }
      }
      
      // Try to use saved refresh tokens if we have them but no full MSMC object
      if (!msmc_meta && msmc_refresh_tokens && msmc_refresh_tokens.msToken) {
        try {
          // Use the saved Microsoft token to get fresh Xbox/Minecraft tokens
          const xboxLiveToken = await this.authenticator.authenticateXboxLive(msmc_refresh_tokens.msToken.access_token);
          
          if (!xboxLiveToken) {
            throw new Error('Xbox Live authentication failed during token refresh');
          }
          
          const xboxProfile = await this.authenticator.authorizeXboxLive(xboxLiveToken.Token);
          
          if (!xboxProfile) {
            throw new Error('Xbox Live authorization failed during token refresh');
          }
          
          const minecraftProfile = await this.authenticator.loginMinecraftWithXBox(
            xboxProfile.DisplayClaims.xui[0].uhs, 
            xboxProfile.Token
          );
          
          if (!minecraftProfile || !minecraftProfile.access_token) {
            throw new Error('Minecraft authentication failed during token refresh');
          }
          
          // Update auth data with refreshed tokens but preserve refresh capability
          this.authData.access_token = minecraftProfile.access_token;
          this.authData.lastRefresh = new Date().toISOString();
          
          // CRITICAL: Preserve the refresh tokens for future refreshes
          // Keep the existing msmc_refresh_tokens so we can refresh again next time
          if (!this.authData.msmc_refresh_tokens) {
            this.authData.msmc_refresh_tokens = msmc_refresh_tokens;
          }
          
          return { success: true, refreshed: true };
          
        } catch (refreshError) {
          // CRITICAL FIX: If we get a 401 error, the Microsoft token is expired
          // and we need fresh authentication - don't try to use cached tokens
          if (refreshError.message && (refreshError.message.includes('401') || refreshError.message.includes('unauthorized') || refreshError.message.includes('invalid_grant'))) {
            this.authData = null;
            return { 
              success: false, 
              error: 'Microsoft authentication token has expired. Please re-authenticate.',
              requiresAuth: true 
            };
          }
          
          // Fall through to original refresh logic or use cached token for other errors
        }
      }

      // Try to refresh the Microsoft token using MSMC
      let refreshedXboxManager = null;
      
      // CRITICAL FIX: Check if msmc_meta exists before trying to use it
      if (!msmc_meta) {
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceSaved < 72) { // 3 days = 72 hours
          return { success: true, refreshed: false, usedCache: true };
        } else {
          this.authData = null;
          return { 
            success: false, 
            error: 'Authentication token expired and cannot be refreshed. Please re-authenticate.',
            requiresAuth: true
          };
        }
      }
      
      if (typeof msmc_meta.refresh === 'function') {
        try {
          refreshedXboxManager = await msmc_meta.refresh();
        } catch (refreshError) {
          throw refreshError;
        }
      } else if (typeof msmc_meta.launch === 'function') {
        // Alternative refresh method
        refreshedXboxManager = msmc_meta;
      } else {
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceSaved < 72) { // 3 days = 72 hours
          return { success: true, refreshed: false, usedCache: true };
        } else {
          this.authData = null;
          return { 
            success: false, 
            error: 'Authentication token expired and refresh method unavailable. Please re-authenticate.',
            requiresAuth: true
          };
        }
      }

      if (!refreshedXboxManager || !refreshedXboxManager.msToken) {
        throw new Error('Failed to refresh Microsoft token - no valid Xbox manager or msToken');
      }



      // Now use @xmcl/user to get fresh Xbox and Minecraft tokens
      let xboxLiveToken, xboxProfile, minecraftProfile;
      
      try {
        xboxLiveToken = await this.authenticator.authenticateXboxLive(refreshedXboxManager.msToken.access_token);
        
        if (!xboxLiveToken) {
          throw new Error('Xbox Live authentication failed during refresh - no token returned');
        }

        xboxProfile = await this.authenticator.authorizeXboxLive(xboxLiveToken.Token);
        
        if (!xboxProfile) {
          throw new Error('Xbox Live authorization failed during refresh - no profile returned');
        }

        minecraftProfile = await this.authenticator.loginMinecraftWithXBox(
          xboxProfile.DisplayClaims.xui[0].uhs, 
          xboxProfile.Token
        );
        
        if (!minecraftProfile || !minecraftProfile.access_token) {
          throw new Error('Minecraft authentication failed during refresh - no access token');
        }
      } catch (authError) {
        throw authError;
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
      // ATLauncher-style error handling: prefer cached tokens over re-authentication
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      
      // For ANY error, try to use cached token if it's not extremely old
      const savedDate = new Date(this.authData.savedAt || 0);
      const now = new Date();
      const hoursSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60);
      
      // ENHANCED: Check for Microsoft token expiration errors (401, invalid_grant, etc.)
      const isMicrosoftTokenExpired = errorMessage && (
        errorMessage.includes('401') || 
        errorMessage.includes('invalid_grant') || 
        errorMessage.includes('expired') ||
        errorMessage.includes('unauthorized')
      );
      
      // If explicit auth errors OR token older than 3 days, require re-auth
      if (isMicrosoftTokenExpired || hoursSinceSaved > 72) {
        // Either explicit auth failure OR token too old for Minecraft servers
        this.authData = null;
        return { 
          success: false, 
          error: `Token refresh failed: ${errorMessage}. Please re-authenticate.`,
          requiresAuth: true 
        };
      }

      // For all other errors or newer cached tokens: use cached token
      // This includes network errors, temporary auth service issues, etc.
      return { success: true, refreshed: false, error: errorMessage, usedCache: true };
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
