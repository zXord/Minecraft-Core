/**
 * Centralized Development Configuration
 * 
 * This file controls all development-specific features.
 * Simply change the values below to enable/disable features.
 * 
 * IMPORTANT: Set enableDevConsole to false before building for production!
 */

module.exports = {
  // Enable/disable the development console (DevTools)
  // This controls whether DevTools opens automatically
  enableDevConsole: false, // DISABLED FOR PRODUCTION
  
  // Enable/disable development server auto-detection  
  // This only affects PACKAGED apps - npm run dev always works
  enableDevServer: false, // DISABLED FOR PRODUCTION
  
  // Enable/disable detailed logging
  enableVerboseLogging: false, // DISABLED FOR PRODUCTION
  
  // Enable/disable development features
  enableDevShortcuts: false, // DISABLED FOR PRODUCTION
  
  // Add more dev features here as needed...
  // enableSomeOtherFeature: false,
}; 