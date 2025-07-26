/**
 * Utility functions for IPC interactions
 */
import logger from './logger.js';

/**
 * Safely invoke an IPC channel with proper error handling
 * 
 * @param {string} channel - The IPC channel name
 * @param  {...any} args - Arguments to pass to the channel
 * @returns {Promise<any>} - Promise that resolves with the result or rejects with an error
 */
export async function safeInvoke(channel, ...args) {
  logger.debug('Invoking IPC channel', {
    category: 'utils',
    data: {
      function: 'safeInvoke',
      channel,
      argsCount: args.length,
      hasElectron: !!window.electron
    }
  });
  
  if (!channel) {
    const error = new Error('Channel name is required');
    logger.error('Invalid channel name provided to safeInvoke', {
      category: 'utils',
      data: {
        function: 'safeInvoke',
        channel,
        errorMessage: error.message
      }
    });
    throw error;
  }
  
  if (!window.electron || typeof window.electron.invoke !== 'function') {
    const error = new Error('Electron IPC bridge not available');
    logger.error('Electron IPC bridge not available', {
      category: 'utils',
      data: {
        function: 'safeInvoke',
        channel,
        hasElectron: !!window.electron,
        hasInvokeMethod: !!(window.electron && window.electron.invoke),
        errorMessage: error.message
      }
    });
    throw error;
  }
  
  try {
    const startTime = Date.now();
    const result = await window.electron.invoke(channel, ...args);
    const duration = Date.now() - startTime;
    
    logger.debug('IPC channel invoked successfully', {
      category: 'utils',
      data: {
        function: 'safeInvoke',
        channel,
        duration,
        hasResult: result !== undefined
      }
    });
    
    return result;
  } catch (err) {
    logger.error('Error invoking IPC channel', {
      category: 'utils',
      data: {
        function: 'safeInvoke',
        channel,
        argsCount: args.length,
        errorMessage: err.message
      }
    });
    throw err;
  }
}

/**
 * Register an event listener for an IPC channel with cleanup
 * 
 * @param {string} channel - The IPC channel name
 * @param {(...args: any[]) => void} callback - Callback function for the event
 * @returns {Function} - Cleanup function to remove the listener
 */
export function registerListener(channel, callback) {
  logger.debug('Registering IPC event listener', {
    category: 'utils',
    data: {
      function: 'registerListener',
      channel,
      hasCallback: typeof callback === 'function',
      hasElectron: !!window.electron
    }
  });
  
  if (!channel || typeof callback !== 'function') {
    logger.warn('Invalid parameters for registerListener', {
      category: 'utils',
      data: {
        function: 'registerListener',
        channel,
        hasChannel: !!channel,
        callbackType: typeof callback
      }
    });
    return () => {}; // Return no-op function
  }
  
  if (!window.electron || typeof window.electron.on !== 'function') {
    logger.warn('Electron IPC bridge not available for event listener', {
      category: 'utils',
      data: {
        function: 'registerListener',
        channel,
        hasElectron: !!window.electron,
        hasOnMethod: !!(window.electron && window.electron.on)
      }
    });
    return () => {}; // Return no-op function
  }
  
  // Register the listener
  window.electron.on(channel, callback);
  
  logger.debug('IPC event listener registered successfully', {
    category: 'utils',
    data: {
      function: 'registerListener',
      channel
    }
  });
  
  // Return a cleanup function
  return () => {
    logger.debug('Removing IPC event listener', {
      category: 'utils',
      data: {
        function: 'registerListener',
        channel
      }
    });
    
    if (window.electron && typeof window.electron.removeListener === 'function') {
      window.electron.removeListener(channel, callback);
    }
  };
}

/**
 * Show a generic confirmation dialog
 * 
 * @param {string} message - Message to display
 * @param {string} title - Dialog title
 * @returns {Promise<boolean>} - True if confirmed, false otherwise
 */
export async function showConfirmationDialog(message, title = 'Confirm') {
  logger.info('Showing confirmation dialog', {
    category: 'utils',
    data: {
      function: 'showConfirmationDialog',
      title,
      hasMessage: !!message
    }
  });
  
  if (!message) {
    logger.warn('No message provided to showConfirmationDialog', {
      category: 'utils',
      data: {
        function: 'showConfirmationDialog',
        message,
        title
      }
    });
    return false;
  }
  
  try {
    const result = await safeInvoke('show-confirmation-dialog', {
      type: 'question',
      buttons: ['Yes', 'No'],
      defaultId: 1, // Default to "No"
      title: title,
      message: message
    });
    
    const confirmed = result && result.response === 0; // 0 = "Yes" button
    
    logger.info('Confirmation dialog result', {
      category: 'utils',
      data: {
        function: 'showConfirmationDialog',
        title,
        confirmed,
        response: result?.response
      }
    });
    
    return confirmed;
  } catch (err) {
    logger.warn('Failed to show native confirmation dialog, falling back to browser confirm', {
      category: 'utils',
      data: {
        function: 'showConfirmationDialog',
        title,
        errorMessage: err.message
      }
    });
    
    // Fallback to browser confirm
    const confirmed = window.confirm(message);
    
    logger.info('Browser confirm result', {
      category: 'utils',
      data: {
        function: 'showConfirmationDialog',
        title,
        confirmed,
        fallbackUsed: true
      }
    });
    
    return confirmed;
  }
} 