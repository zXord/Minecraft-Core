/**
 * Utility functions for IPC interactions
 */

/**
 * Safely invoke an IPC channel with proper error handling
 * 
 * @param {string} channel - The IPC channel name
 * @param  {...any} args - Arguments to pass to the channel
 * @returns {Promise<any>} - Promise that resolves with the result or rejects with an error
 */
export async function safeInvoke(channel, ...args) {
  if (!channel) {
    throw new Error('Channel name is required');
  }
  
  if (!window.electron || typeof window.electron.invoke !== 'function') {
    throw new Error('Electron IPC bridge not available');
  }
  
  return await window.electron.invoke(channel, ...args);
}

/**
 * Register an event listener for an IPC channel with cleanup
 * 
 * @param {string} channel - The IPC channel name
 * @param {(...args: any[]) => void} callback - Callback function for the event
 * @returns {Function} - Cleanup function to remove the listener
 */
export function registerListener(channel, callback) {
  if (!channel || typeof callback !== 'function') {
    return () => {}; // Return no-op function
  }
  
  if (!window.electron || typeof window.electron.on !== 'function') {
    return () => {}; // Return no-op function
  }
  
  // Register the listener
  window.electron.on(channel, callback);
  
  // Return a cleanup function
  return () => {
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
  if (!message) {
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
      return result && result.response === 0; // 0 = "Yes" button
  } catch {
    // Fallback to browser confirm
    return window.confirm(message);
  }
} 