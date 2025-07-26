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

    // Added: centralised logger that forwards messages to the launcher for the debug console
    this._logger = (type, message) => {
      if (eventEmitter && typeof eventEmitter.emit === 'function') {
        eventEmitter.emit('auth-log', { type, message });
      }
    };
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
        // CRITICAL: Store Microsoft refresh token for proper token refresh
        microsoft_refresh_token: xboxManager.msToken?.refresh_token || null,
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
      
      // Prepare data to save (including Microsoft refresh token)
      const authDataToSave = {
        access_token: this.authData.access_token,
        client_token: this.authData.client_token,
        uuid: this.authData.uuid,
        name: this.authData.name,
        user_properties: this.authData.user_properties || {},
        savedAt: new Date().toISOString(),
        lastRefresh: this.authData.lastRefresh,
        // CRITICAL: Save Microsoft refresh token for proper token refresh
        microsoft_refresh_token: this.authData.microsoft_refresh_token,
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
        // CRITICAL: Restore Microsoft refresh token for proper token refresh
        microsoft_refresh_token: savedAuthData.microsoft_refresh_token || null,
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
    this._logger('debug', `🔄 Checking/refreshing auth token (forceRefresh=${forceRefresh})...`);
    if (!this.authData) {
      this._logger('error', '❌ No authentication data present.');
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
      const daysSinceRefresh = hoursSinceRefresh / 24;
      
      // ATLauncher-style authentication: Be very lenient with cached tokens
      // Only bother users when tokens are truly unusable (weeks/months old)
      
      // If forceRefresh is false (background checks), be very permissive
      if (!forceRefresh) {
        // For background checks, use cached tokens for up to 30 days without even trying to refresh
        if (daysSinceRefresh < 30) {
          this._logger('success', `✅ Using cached token (${daysSinceRefresh.toFixed(1)} days old).`);
          return { success: true, refreshed: false };
        }
      }

      // For launch attempts or very old tokens, try silent refresh but DON'T FAIL if it doesn't work
      if (this.authData.msmc_meta || this.authData.msmc_refresh_tokens || (this.authData.xmcl_tokens && this.authData.xmcl_tokens.microsoft)) {
        try {
          // Attempt silent refresh in background
          this.refreshPromise = this.performTokenRefresh();
          const result = await this.refreshPromise;
          this.refreshPromise = null;
          
          if (result.success && result.refreshed) {
            this._logger('success', '✅ Successfully refreshed all tokens using Microsoft refresh token.');
            return result;
          } else if (result.success && result.usedCache) {
            this._logger('warning', '⚠️ Token refresh failed but cached token still valid, proceeding.');
            return result;
          }
        } catch (error) {
          // Silent refresh failed, but that's OK - we'll use the cached token
          this.refreshPromise = null;
          this._logger('warning', `⚠️ Silent token refresh failed: ${error.message}`);
        }
      }

      // CRITICAL FIX: Be much more lenient with cached tokens
      // Only require re-authentication if token is EXTREMELY old (3+ months)
      if (daysSinceRefresh > 90) { // 90 days = 3 months
        this._logger('error', `❌ Authentication token is ${daysSinceRefresh.toFixed(1)} days old → requires re-auth.`);
        this.authData = null;
        return { 
          success: false, 
          error: `Authentication token is ${daysSinceRefresh.toFixed(1)} days old and needs refresh. Please re-authenticate.`,
          requiresAuth: true 
        };
      }

      // For tokens up to 3 months old: Always use cached token, even if refresh failed
      // Modern Minecraft servers are very lenient with token age
      // But first, quickly validate the cached token with Mojang. This is cheap (same endpoint the game uses) and avoids 401 in-game.
      const isTokenValid = await this.validateAccessToken(this.authData.access_token);
      if (!isTokenValid) {
        this._logger('error', '❌ Cached access token is no longer accepted by Mojang. Re-authentication required.');
        this.authData = null;
        return { success: false, error: 'Cached token rejected by Mojang', requiresAuth: true };
      }
      this._logger('success', '✅ Cached token accepted by Mojang – proceeding without refresh.');
      return { success: true, refreshed: false, usedCache: true };

    } catch (error) {


      // On any error, if token isn't extremely old, use it anyway
      const savedDate = new Date(this.authData.savedAt || 0);
      const now = new Date();
      const daysSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60 * 24);
      
      // Only fail if token is more than 3 months old
      if (daysSinceSaved > 90) {
        this.authData = null;
        return { success: false, error: 'Authentication token too old', requiresAuth: true };
      }

      // Use cached token for anything newer than 3 months
      return { success: true, refreshed: false, error: error.message, usedCache: true };
      }
  }
  /**
   * Refresh Microsoft access token using refresh token
   * This is the critical missing piece - proper Microsoft OAuth2 refresh flow
   */
  async refreshMicrosoftAccessToken(refreshToken) {
    this._logger('debug', '🔄 Refreshing Microsoft access token using refresh token…');
    const https = require('https');
    const querystring = require('querystring');
    
    return new Promise((resolve, reject) => {
      // Microsoft OAuth2 refresh token endpoint
      const postData = querystring.stringify({
        client_id: '00000000402b5328', // Minecraft Launcher client ID
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'XboxLive.signin offline_access'
      });
      
      const options = {
        hostname: 'login.live.com',
        port: 443,
        path: '/oauth20_token.srf',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'MinecraftLauncher/1.0'
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            this._logger('debug', `ℹ️ Microsoft token endpoint responded with status ${res.statusCode}`);
            
            if (res.statusCode === 200 && response.access_token) {
              this._logger('success', '✅ Microsoft access token refreshed successfully');
              // Successful refresh
              resolve({
                access_token: response.access_token,
                refresh_token: response.refresh_token || refreshToken, // Keep old refresh token if new one not provided
                expires_in: response.expires_in,
                token_type: response.token_type
              });
            } else {
              this._logger('error', `❌ Microsoft token refresh failed (${res.statusCode}): ${response.error || 'Unknown error'} | desc: ${response.error_description || 'no description'}`);
              this._logger('debug', `🔎 Full response: ${JSON.stringify(response)}`);
              // Error response
              reject(new Error(`Microsoft token refresh failed: ${response.error || 'Unknown error'} - ${response.error_description || 'No description'}`));
            }
          } catch (parseError) {
            this._logger('error', `❌ Failed to parse Microsoft token response: ${parseError.message}`);
            reject(new Error(`Failed to parse Microsoft token response: ${parseError.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        this._logger('error', `❌ Microsoft token refresh request failed: ${error.message}`);
        reject(new Error(`Microsoft token refresh request failed: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        this._logger('error', '❌ Microsoft token refresh request timed out');
        reject(new Error('Microsoft token refresh request timed out'));
      });
      
      req.setTimeout(10000); // 10 second timeout
      req.write(postData);
      req.end();
    });
  }

  /**
   * Perform the actual token refresh using hybrid approach
   */
  async performTokenRefresh() {
    this._logger('debug', '🔄 Performing full token refresh workflow...');

    // Migration: if microsoft_refresh_token is missing try to recover from saved token structures
    if (!this.authData.microsoft_refresh_token) {
      if (this.authData.xmcl_tokens?.microsoft?.refresh_token) {
        this._logger('debug', 'ℹ️ Recovered microsoft_refresh_token from xmcl_tokens');
        this.authData.microsoft_refresh_token = this.authData.xmcl_tokens.microsoft.refresh_token;
      } else if (this.authData.msmc_refresh_tokens?.msToken?.refresh_token) {
        this._logger('debug', 'ℹ️ Recovered microsoft_refresh_token from msmc_refresh_tokens');
        this.authData.microsoft_refresh_token = this.authData.msmc_refresh_tokens.msToken.refresh_token;
      }
    }

    try {
      // STEP 1: First try to refresh the Microsoft access token using refresh token
      if (this.authData.microsoft_refresh_token) {
        this._logger('debug', '🔑 Using stored microsoft_refresh_token to obtain new access token');
        try {
          const freshMicrosoftToken = await this.refreshMicrosoftAccessToken(this.authData.microsoft_refresh_token);
          this._logger('success', '✅ Received new Microsoft access token');
          
          if (freshMicrosoftToken) {
            this._logger('debug', '🔑 Authenticating Xbox Live with new Microsoft token…');
            const xboxLiveToken = await this.authenticator.authenticateXboxLive(freshMicrosoftToken.access_token);
            
            if (!xboxLiveToken) {
              this._logger('error', '❌ Xbox Live authentication returned null');
              throw new Error('Xbox Live authentication failed with fresh Microsoft token');
            }
            
            this._logger('debug', '🔑 Authorizing Xbox Live…');
            const xboxProfile = await this.authenticator.authorizeXboxLive(xboxLiveToken.Token);
            
            if (!xboxProfile) {
              this._logger('error', '❌ Xbox Live authorization returned null');
              throw new Error('Xbox Live authorization failed with fresh Microsoft token');
            }
            
            this._logger('debug', '🔑 Logging into Minecraft with XSTS token…');
            const minecraftProfile = await this.authenticator.loginMinecraftWithXBox(
              xboxProfile.DisplayClaims.xui[0].uhs, 
              xboxProfile.Token
            );
            
            if (!minecraftProfile || !minecraftProfile.access_token) {
              this._logger('error', '❌ Minecraft login did not return access_token');
              throw new Error('Minecraft authentication failed with fresh Microsoft token');
            }
            
            // Update auth data with refreshed tokens
            this.authData.access_token = minecraftProfile.access_token;
            this.authData.lastRefresh = new Date().toISOString();
            
            // Update stored tokens
            this.authData.xmcl_tokens = {
              microsoft: freshMicrosoftToken,
              xboxLive: xboxLiveToken,
              xboxProfile: xboxProfile,
              minecraft: minecraftProfile
            };
            
            // Keep the refresh token for future refreshes
            if (freshMicrosoftToken.refresh_token) {
              this.authData.microsoft_refresh_token = freshMicrosoftToken.refresh_token;
            }
            
            return { success: true, refreshed: true };
          }
        } catch (refreshError) {
          this._logger('warning', `⚠️ Microsoft token refresh failed with error: ${refreshError.message}`);
          // Check if cached token is still usable instead of failing immediately
          const savedDate = new Date(this.authData.savedAt || 0);
          const now = new Date();
          const daysSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60 * 24);
          
          // Only fail if Microsoft token refresh failed AND cached token is old
          if (refreshError.message && (refreshError.message.includes('invalid_grant') || refreshError.message.includes('400'))) {
            if (daysSinceSaved > 7) { // Only clear if cached token is also more than a week old
              this.authData = null;
              return { 
                success: false, 
                error: 'Microsoft authentication token has expired. Please re-authenticate.',
                requiresAuth: true 
              };
            }
          }
          
          // For other errors or newer cached tokens: fall back to using cached token
          return { success: true, refreshed: false, usedCache: true };
        }
      }

      // Log which fallback path we are entering for clarity
      this._logger('debug', `⚙️ microsoft_refresh_token unavailable. msmc_meta=${!!this.authData.msmc_meta} msmc_refresh_tokens=${!!this.authData.msmc_refresh_tokens}`);

      // FALLBACK: Use MSMC to refresh the Microsoft token (legacy approach)
      const msmc_meta = this.authData.msmc_meta;
      const msmc_refresh_tokens = this.authData.msmc_refresh_tokens;
      
      // FALLBACK message when no refresh capability
      if (!msmc_meta && !msmc_refresh_tokens) {
        this._logger('warning', '⚠️ No refresh capability available, will rely on cached token.');
        // No refresh capability, but check if cached token is still usable
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const daysSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceSaved < 90) { // 3 months = 90 days
          this._logger('success', `✅ Using cached token (${daysSinceSaved.toFixed(1)} days old).`);
          // Token is less than 3 months old, should still work with Minecraft servers
          return { success: true, refreshed: false, usedCache: true };
        } else {
          this._logger('error', `❌ Authentication token expired and cannot be refreshed. Please re-authenticate.`);
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
          // CRITICAL FIX: Don't clear authData on refresh errors - use cached token instead
          const savedDate = new Date(this.authData.savedAt || 0);
          const now = new Date();
          const daysSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60 * 24);
          
          // Only clear authData if token is EXTREMELY old OR we get explicit Microsoft auth errors
          if (refreshError.message && (refreshError.message.includes('401') || refreshError.message.includes('unauthorized') || refreshError.message.includes('invalid_grant'))) {
            // Microsoft token is definitely expired - require fresh auth
            if (daysSinceSaved > 7) { // Only clear if also more than a week old
            this.authData = null;
            return { 
              success: false, 
              error: 'Microsoft authentication token has expired. Please re-authenticate.',
              requiresAuth: true 
            };
            }
          }
          
          // For all other errors or newer cached tokens: use cached token
          return { success: true, refreshed: false, usedCache: true };
        }
      }

      // Try to refresh the Microsoft token using MSMC
      let refreshedXboxManager = null;
      
      // CRITICAL FIX: Don't clear authData if msmc_meta is missing - use cached token instead
      if (!msmc_meta) {
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const daysSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceSaved < 90) { // 3 months = 90 days
          this._logger('success', `✅ Using cached token (${daysSinceSaved.toFixed(1)} days old).`);
          return { success: true, refreshed: false, usedCache: true };
        } else {
          this._logger('error', `❌ Authentication token expired and cannot be refreshed. Please re-authenticate.`);
          this.authData = null;
          return { 
            success: false, 
            error: 'Authentication token expired and cannot be refreshed. Please re-authenticate.',
            requiresAuth: true
          };
        }
      }
      
      if (typeof msmc_meta.refresh === 'function') {
        refreshedXboxManager = await msmc_meta.refresh();
      } else if (typeof msmc_meta.launch === 'function') {
        // Alternative refresh method
        refreshedXboxManager = msmc_meta;
      } else {
        // No refresh method available, use cached token if not too old
        const savedDate = new Date(this.authData.savedAt || 0);
        const now = new Date();
        const daysSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceSaved < 90) { // 3 months = 90 days
          this._logger('success', `✅ Using cached token (${daysSinceSaved.toFixed(1)} days old).`);
          return { success: true, refreshed: false, usedCache: true };
        } else {
          this._logger('error', `❌ Authentication token expired and refresh method unavailable. Please re-authenticate.`);
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
      this._logger('error', `❌ performTokenRefresh top-level error: ${error.message}`);
      // ATLauncher-style error handling: prefer cached tokens over re-authentication
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      
      // Check if cached token is still usable instead of clearing authData
      const savedDate = new Date(this.authData.savedAt || 0);
      const now = new Date();
      const daysSinceSaved = (now.getTime() - savedDate.getTime()) / (1000 * 60 * 60 * 24);
      
      // Check for Microsoft token expiration errors (401, invalid_grant, etc.)
      const isMicrosoftTokenExpired = errorMessage && (
        errorMessage.includes('401') || 
        errorMessage.includes('invalid_grant') || 
        errorMessage.includes('expired') ||
        errorMessage.includes('unauthorized')
      );
      
      // Only clear authData if explicit auth errors AND token is also old (more than a week)
      if (isMicrosoftTokenExpired && daysSinceSaved > 7) {
        this.authData = null;
        return { 
          success: false, 
          error: `Token refresh failed: ${errorMessage}. Please re-authenticate.`,
          requiresAuth: true 
        };
      }

      // For tokens older than 3 months, require re-auth even without explicit errors
      if (daysSinceSaved > 90) {
        this.authData = null;
        return { 
          success: false, 
          error: `Authentication token is ${daysSinceSaved.toFixed(1)} days old. Please re-authenticate.`,
          requiresAuth: true 
        };
      }

      // For all other cases: use cached token (network errors, temp auth issues, newer tokens, etc.)
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

  async validateAccessToken(accessToken) {
    try {
      const fetch = require('node-fetch');
      const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        timeout: 10000
      });
      return res.status === 200;
    } catch {
      return false; // On network error assume invalid to be safe
    }
  }
}

module.exports = { XMCLAuthHandler };
