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

  // Allow update checks while running `npm run dev`
  // Use this to test auto-updater behavior without packaging
  enableDevUpdates: true, // ENABLED FOR DEV TESTING

  // Add more dev features here as needed...
  // enableSomeOtherFeature: false,
}; 
