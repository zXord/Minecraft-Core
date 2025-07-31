/**
 * MetricsFormatter - Utility class for formatting dashboard metrics
 * Provides consistent formatting for memory, uptime, and player count displays
 * with comprehensive error handling and loading states
 */
export class MetricsFormatter {
  /**
   * Format memory usage with percentage and status calculation
   * @param {number} usedMB - Used memory in MB
   * @param {number} totalMB - Total memory in MB
   * @returns {Object} Formatted memory display object
   */
  static formatMemory(usedMB, totalMB) {
    if (!usedMB || !totalMB || totalMB <= 0) {
      return { 
        display: 'Calculating...', 
        percentage: 0, 
        status: 'loading',
        used: 0,
        total: 0
      };
    }
    
    const used = Math.max(0, usedMB);
    const total = Math.max(1, totalMB);
    const percentage = Math.min(100, (used / total) * 100);
    
    const status = percentage > 90 ? 'critical' : percentage > 75 ? 'warning' : 'normal';
    
    return {
      display: `${Math.round(used)} MB / ${Math.round(total)} MB (${percentage.toFixed(1)}%)`,
      percentage,
      status,
      used: Math.round(used),
      total: Math.round(total)
    };
  }
  
  /**
   * Format uptime with contextual information
   * @param {string} uptimeString - Uptime string in format "Xh Ym Zs"
   * @returns {Object} Formatted uptime display object
   */
  static formatUptime(uptimeString) {
    if (!uptimeString || uptimeString === '0h 0m 0s') {
      return { 
        display: '—', 
        status: 'not-running',
        context: 'Server not running'
      };
    }
    
    // Parse uptime and provide additional context
    const match = uptimeString.match(/(\d+)h (\d+)m (\d+)s/);
    if (match) {
      const [, hours, minutes] = match;
      const totalMinutes = parseInt(hours) * 60 + parseInt(minutes);
      
      if (totalMinutes < 60) {
        return { 
          display: uptimeString, 
          status: 'recent', 
          context: 'Recently started' 
        };
      } else if (totalMinutes < 1440) { // Less than 24 hours
        return { 
          display: uptimeString, 
          status: 'normal', 
          context: 'Running today' 
        };
      } else {
        const days = Math.floor(totalMinutes / 1440);
        return { 
          display: uptimeString, 
          status: 'stable', 
          context: `Running for ${days} day${days > 1 ? 's' : ''}` 
        };
      }
    }
    
    return { 
      display: uptimeString, 
      status: 'normal',
      context: 'Server running'
    };
  }
  
  /**
   * Format player count with capacity indicators
   * @param {number} count - Current player count
   * @param {number} maxPlayers - Maximum player capacity (optional)
   * @returns {Object} Formatted player count display object
   */
  static formatPlayerCount(count, maxPlayers = null) {
    if (typeof count !== 'number') {
      return { 
        display: '—', 
        status: 'not-running',
        percentage: 0,
        context: 'Server not running'
      };
    }
    
    const baseDisplay = count.toString();
    
    if (maxPlayers && maxPlayers > 0) {
      const percentage = (count / maxPlayers) * 100;
      const status = percentage > 90 ? 'full' : percentage > 75 ? 'busy' : 'normal';
      
      return {
        display: `${count} / ${maxPlayers}`,
        percentage,
        status,
        context: `${percentage.toFixed(0)}% capacity`
      };
    }
    
    return {
      display: baseDisplay,
      status: count > 0 ? 'active' : 'empty',
      percentage: 0,
      context: count > 0 ? `${count} player${count !== 1 ? 's' : ''} online` : 'No players online'
    };
  }

  /**
   * Create consistent loading state for metrics
   * @param {string} metricName - Name of the metric being loaded
   * @returns {Object} Standardized loading state object
   */
  static createLoadingState(metricName = 'metric') {
    return {
      display: 'Loading...',
      status: 'loading',
      percentage: 0,
      context: `Loading ${metricName} data`,
      isLoading: true
    };
  }

  /**
   * Create consistent error state for metrics
   * @param {string} metricName - Name of the metric that failed
   * @param {Error|string} error - Error object or message
   * @returns {Object} Standardized error state object
   */
  static createErrorState(metricName = 'metric', error = null) {
    const errorMessage = error instanceof Error ? error.message : (error || 'Unknown error');
    
    return {
      display: 'Error',
      status: 'error',
      percentage: 0,
      context: `Failed to load ${metricName}`,
      error: errorMessage,
      isError: true
    };
  }

  /**
   * Create consistent unavailable state for metrics
   * @param {string} metricName - Name of the unavailable metric
   * @param {string} reason - Reason why metric is unavailable
   * @returns {Object} Standardized unavailable state object
   */
  static createUnavailableState(metricName = 'metric', reason = 'Server not running') {
    return {
      display: '—',
      status: 'not-running',
      percentage: 0,
      context: reason || `${metricName} not available`,
      isUnavailable: true
    };
  }

  /**
   * Validate and sanitize numeric input for metrics
   * @param {any} value - Value to validate
   * @param {string} metricName - Name of the metric for error reporting
   * @returns {Object} Validation result with isValid flag and sanitized value
   */
  static validateNumericInput(value, metricName = 'metric') {
    if (value === null || value === undefined) {
      return {
        isValid: false,
        value: 0,
        error: `${metricName} value is null or undefined`
      };
    }

    if (typeof value !== 'number') {
      const parsed = parseFloat(value);
      if (isNaN(parsed)) {
        return {
          isValid: false,
          value: 0,
          error: `${metricName} value is not a valid number: ${value}`
        };
      }
      return {
        isValid: true,
        value: parsed,
        warning: `${metricName} value was converted from ${typeof value} to number`
      };
    }

    if (!isFinite(value)) {
      return {
        isValid: false,
        value: 0,
        error: `${metricName} value is not finite: ${value}`
      };
    }

    return {
      isValid: true,
      value: value
    };
  }

  /**
   * Enhanced memory formatting with comprehensive error handling
   * @param {number} usedMB - Used memory in MB
   * @param {number} totalMB - Total memory in MB
   * @returns {Object} Formatted memory display object with error handling
   */
  static formatMemoryWithErrorHandling(usedMB, totalMB) {
    // Validate inputs
    const usedValidation = this.validateNumericInput(usedMB, 'used memory');
    const totalValidation = this.validateNumericInput(totalMB, 'total memory');

    if (!usedValidation.isValid || !totalValidation.isValid) {
      return this.createErrorState('memory usage', 
        usedValidation.error || totalValidation.error);
    }

    if (totalValidation.value <= 0) {
      return this.createErrorState('memory usage', 'Total memory must be greater than 0');
    }

    try {
      return this.formatMemory(usedValidation.value, totalValidation.value);
    } catch (error) {
      return this.createErrorState('memory usage', error);
    }
  }

  /**
   * Enhanced uptime formatting with comprehensive error handling
   * @param {string} uptimeString - Uptime string in format "Xh Ym Zs"
   * @returns {Object} Formatted uptime display object with error handling
   */
  static formatUptimeWithErrorHandling(uptimeString) {
    if (uptimeString === null || uptimeString === undefined) {
      return this.createUnavailableState('uptime', 'Uptime data not available');
    }

    if (typeof uptimeString !== 'string') {
      return this.createErrorState('uptime', `Invalid uptime format: expected string, got ${typeof uptimeString}`);
    }

    try {
      return this.formatUptime(uptimeString);
    } catch (error) {
      return this.createErrorState('uptime', error);
    }
  }

  /**
   * Enhanced player count formatting with comprehensive error handling
   * @param {number} count - Current player count
   * @param {number} maxPlayers - Maximum player capacity (optional)
   * @returns {Object} Formatted player count display object with error handling
   */
  static formatPlayerCountWithErrorHandling(count, maxPlayers = null) {
    const countValidation = this.validateNumericInput(count, 'player count');
    
    if (!countValidation.isValid) {
      return this.createUnavailableState('player count', 'Player count not available');
    }

    if (countValidation.value < 0) {
      return this.createErrorState('player count', 'Player count cannot be negative');
    }

    if (maxPlayers !== null) {
      const maxValidation = this.validateNumericInput(maxPlayers, 'max players');
      if (!maxValidation.isValid || maxValidation.value <= 0) {
        return this.createErrorState('player count', 'Invalid maximum player count');
      }
      
      if (countValidation.value > maxValidation.value) {
        return this.createErrorState('player count', 
          `Player count (${countValidation.value}) exceeds maximum (${maxValidation.value})`);
      }
    }

    try {
      return this.formatPlayerCount(countValidation.value, maxPlayers);
    } catch (error) {
      return this.createErrorState('player count', error);
    }
  }

  /**
   * Get status indicator class for consistent styling
   * @param {string} status - Status value (normal, warning, critical, error, loading, not-running)
   * @returns {string} CSS class name for status styling
   */
  static getStatusClass(status) {
    const statusClasses = {
      'normal': 'status-normal',
      'warning': 'status-warning', 
      'critical': 'status-critical',
      'error': 'status-error',
      'loading': 'status-loading',
      'not-running': 'status-not-running',
      'recent': 'status-recent',
      'stable': 'status-stable',
      'full': 'status-full',
      'busy': 'status-busy',
      'active': 'status-active',
      'empty': 'status-empty'
    };

    return statusClasses[status] || 'status-unknown';
  }

  /**
   * Check if a metric state represents an error condition
   * @param {Object} metricState - Formatted metric state object
   * @returns {boolean} True if the state represents an error
   */
  static isErrorState(metricState) {
    return metricState && (metricState.status === 'error' || metricState.isError === true);
  }

  /**
   * Check if a metric state represents a loading condition
   * @param {Object} metricState - Formatted metric state object
   * @returns {boolean} True if the state represents loading
   */
  static isLoadingState(metricState) {
    return metricState && (metricState.status === 'loading' || metricState.isLoading === true);
  }

  /**
   * Check if a metric state represents an unavailable condition
   * @param {Object} metricState - Formatted metric state object
   * @returns {boolean} True if the state represents unavailable data
   */
  static isUnavailableState(metricState) {
    return metricState && (metricState.status === 'not-running' || metricState.isUnavailable === true);
  }
}