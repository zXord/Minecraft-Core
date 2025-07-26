// WMIC utility functions to prevent "No Instance(s) Available." spam
const { execSync } = require('child_process');
const { promisify } = require('util');
const exec = require('child_process').exec;
const execAsync = promisify(exec);

/**
 * Filter WMIC output to remove spam messages
 * @param {string|Buffer} output - Raw WMIC output
 * @returns {string} Filtered output
 */
function filterWmicOutput(output) {
  return String(output)
    .split('\n')
    .filter(line => !line.includes('No Instance(s) Available'))
    .join('\n');
}

/**
 * Execute WMIC command synchronously with proper filtering and hiding
 * @param {string} command - WMIC command to execute
 * @param {object} options - Execution options
 * @returns {string} Filtered output
 */
function wmicExecSync(command, options = {}) {
  const defaultOptions = {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe'
  };

  const mergedOptions = { ...defaultOptions, ...options };
  
  try {
    const output = execSync(command, mergedOptions);
    return filterWmicOutput(output);
  } catch (error) {
    // If the error contains the spam message, filter it out of the error message too
    if (error.stdout) {
      error.stdout = filterWmicOutput(error.stdout);
    }
    if (error.stderr) {
      error.stderr = filterWmicOutput(error.stderr);
    }
    throw error;
  }
}

/**
 * Execute WMIC command asynchronously with proper filtering and hiding
 * @param {string} command - WMIC command to execute
 * @param {object} options - Execution options
 * @returns {Promise<{stdout: string, stderr: string}>} Filtered output
 */
async function wmicExecAsync(command, options = {}) {
  const defaultOptions = {
    timeout: 5000,
    windowsHide: true
  };

  const mergedOptions = { ...defaultOptions, ...options };
  
  try {
    const result = await execAsync(command, mergedOptions);
    return {
      stdout: filterWmicOutput(result.stdout),
      stderr: filterWmicOutput(result.stderr)
    };
  } catch (error) {
    // If the error contains the spam message, filter it out
    if (error.stdout) {
      error.stdout = filterWmicOutput(error.stdout);
    }
    if (error.stderr) {
      error.stderr = filterWmicOutput(error.stderr);
    }
    throw error;
  }
}

/**
 * Execute WMIC terminate command with proper options
 * @param {string} command - WMIC terminate command
 * @param {object} options - Execution options
 */
function wmicTerminate(command, options = {}) {
  const defaultOptions = {
    stdio: 'ignore',
    windowsHide: true
  };

  const mergedOptions = { ...defaultOptions, ...options };
  
  try {
    return execSync(command, mergedOptions);
  } catch {
    // Silently handle terminate errors as they're expected when no processes exist
    return null;
  }
}

module.exports = {
  filterWmicOutput,
  wmicExecSync,
  wmicExecAsync,
  wmicTerminate
}; 