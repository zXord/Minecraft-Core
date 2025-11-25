/**
 * Enhanced log formatting utility for server console display
 * Provides date/time formatting, timestamp detection, and log grouping functionality
 * Optimized for performance with caching and efficient algorithms
 */

export class LogFormatter {
  // Performance optimization: Cache for formatted timestamps
  static _timestampCache = new Map();
  static _dateCache = new Map();
  static _timeCache = new Map();
  static _maxCacheSize = 1000; // Limit cache size to prevent memory leaks
  
  // Performance optimization: Cache for date grouping results
  static _groupingCache = new Map();
  static _lastGroupingInput = null;
  static _lastGroupingResult = null;
  
  // Performance optimization: Reusable regex patterns
  static _fullTimestampPatterns = [
    /^\[\d{4}-\d{2}-\d{2}/, // [YYYY-MM-DD
    /^\[\d{1,2}\/\d{1,2}\/\d{4}/, // [M/D/YYYY or MM/DD/YYYY
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO format YYYY-MM-DDTHH:MM:SS
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, // YYYY-MM-DD HH:MM:SS
    /^\[\d{1,2}\/\d{1,2}\/\d{2,4} \d{1,2}:\d{2}:\d{2}/, // [M/D/YY H:MM:SS or [MM/DD/YYYY HH:MM:SS
    /^\d{1,2}\/\d{1,2}\/\d{2,4} \d{1,2}:\d{2}:\d{2}/, // M/D/YY H:MM:SS without brackets
    /^\[\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2}/, // [Mon Jan 01 12:00:00
    /^\[\w{3} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2}\]/, // [Jul 29, 2025 21:23:06] - our format
  ];
  
  static _timeOnlyPatterns = [
    /^\[\d{2}:\d{2}:\d{2}\]/, // [HH:MM:SS]
    /^\[\d{1,2}:\d{2}:\d{2}\]/, // [H:MM:SS]
    /^\[\d{2}:\d{2}:\d{2}\]\s*\[/, // [HH:MM:SS] [Thread/Level] - Minecraft format
    /^\[\d{1,2}:\d{2}:\d{2}\]\s*\[/, // [H:MM:SS] [Thread/Level] - Minecraft format
  ];
  
  /**
   * Clear all caches to free memory
   */
  static clearCaches() {
    this._timestampCache.clear();
    this._dateCache.clear();
    this._timeCache.clear();
    this._groupingCache.clear();
    this._lastGroupingInput = null;
    this._lastGroupingResult = null;
  }
  
  /**
   * Manage cache size to prevent memory leaks
   * @private
   */
  static _manageCacheSize() {
    if (this._timestampCache.size > this._maxCacheSize) {
      // Remove oldest entries (simple LRU-like behavior)
      const entries = Array.from(this._timestampCache.entries());
      const toRemove = entries.slice(0, Math.floor(this._maxCacheSize / 2));
      toRemove.forEach(([key]) => this._timestampCache.delete(key));
    }
    
    if (this._dateCache.size > this._maxCacheSize) {
      const entries = Array.from(this._dateCache.entries());
      const toRemove = entries.slice(0, Math.floor(this._maxCacheSize / 2));
      toRemove.forEach(([key]) => this._dateCache.delete(key));
    }
    
    if (this._timeCache.size > this._maxCacheSize) {
      const entries = Array.from(this._timeCache.entries());
      const toRemove = entries.slice(0, Math.floor(this._maxCacheSize / 2));
      toRemove.forEach(([key]) => this._timeCache.delete(key));
    }
  }
  /**
   * Formats a log entry by adding timestamp if not already present
   * Optimized with caching for repeated operations
   * @param {string} logLine - The raw log line to format
   * @param {Date|number|null} timestamp - Optional timestamp to use, defaults to current time
   * @returns {string} Formatted log entry with timestamp
   */
  static formatLogEntry(logLine, timestamp = null) {
    try {
      // Handle null, undefined, or non-string inputs
      if (logLine === null || logLine === undefined) {
        return this._createFallbackLogEntry('(null log entry)', timestamp);
      }
      
      if (typeof logLine !== 'string') {
        // Convert non-string inputs to string safely
        try {
          const converted = String(logLine);
          return this._createFallbackLogEntry(`(converted: ${converted})`, timestamp);
        } catch {
          return this._createFallbackLogEntry('(invalid log entry)', timestamp);
        }
      }

      // Handle empty or whitespace-only strings
      if (logLine.trim() === '') {
        return this._createFallbackLogEntry('(empty log entry)', timestamp);
      }

      // Performance optimization: Check cache first
      // Only cache when an explicit timestamp is provided; "now" would make cached entries stale
      const canUseCache = timestamp !== null && timestamp !== undefined;
      const cacheKey = canUseCache ? `${logLine}|${timestamp}` : null;
      if (canUseCache && this._timestampCache.has(cacheKey)) {
        return this._timestampCache.get(cacheKey);
      }

      let result;

      // Check if log already has full timestamp
      if (this.hasTimestamp(logLine)) {
        result = logLine;
      } else if (this.hasTimeOnlyTimestamp(logLine)) {
        // Check if log has time-only timestamp (like Minecraft server logs)
        try {
          // Add current date to time-only timestamps
          const now = this._createSafeDate(timestamp);
          const dateStr = this._getCachedFormattedDate(now);
          
          // Extract the time part and add date prefix
          // Look for [HH:MM:SS] pattern at the beginning
          const timeMatch = logLine.match(/^\[(\d{1,2}:\d{2}:\d{2})\]/);
          
          if (timeMatch) {
            const timeStr = timeMatch[1]; // Extract just the time part
            const restOfLog = logLine.substring(timeMatch[0].length);
            result = `[${dateStr} ${timeStr}]${restOfLog}`;
          } else {
            result = this._createFallbackLogEntry(logLine, timestamp);
          }
        } catch {
          // If time parsing fails, fall back to full timestamp
          result = this._createFallbackLogEntry(logLine, timestamp);
        }
      } else {
        // No timestamp at all - add full timestamp
        const now = this._createSafeDate(timestamp);
        const dateStr = this._getCachedFormattedDate(now);
        const timeStr = this._getCachedFormattedTime(now);

        result = `[${dateStr} ${timeStr}] ${logLine}`;
      }

      // Cache the result for future use
      if (canUseCache) {
        this._timestampCache.set(cacheKey, result);
        this._manageCacheSize();
      }
      
      return result;
      
    } catch (error) {
      // Ultimate fallback for any unexpected errors
      console.warn('LogFormatter.formatLogEntry error:', error);
      return this._createFallbackLogEntry(
        logLine || '(error formatting log)', 
        timestamp, 
        'formatting error'
      );
    }
  }

  /**
   * Get cached formatted date string
   * @private
   * @param {Date} date - Date to format
   * @returns {string} Formatted date string
   */
  static _getCachedFormattedDate(date) {
    const dateKey = date.toDateString();
    if (this._dateCache.has(dateKey)) {
      return this._dateCache.get(dateKey);
    }
    
    const formatted = this.formatDate(date);
    this._dateCache.set(dateKey, formatted);
    return formatted;
  }
  
  /**
   * Get cached formatted time string
   * @private
   * @param {Date} date - Date to format time from
   * @returns {string} Formatted time string
   */
  static _getCachedFormattedTime(date) {
    // Create a time key that includes hours, minutes, seconds
    const timeKey = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
    if (this._timeCache.has(timeKey)) {
      return this._timeCache.get(timeKey);
    }
    
    const formatted = this.formatTime(date);
    this._timeCache.set(timeKey, formatted);
    return formatted;
  }

  /**
   * Creates a safe Date object with fallback handling
   * @private
   * @param {Date|number|null} timestamp - Input timestamp
   * @returns {Date} Valid Date object
   */
  static _createSafeDate(timestamp) {
    try {
      if (timestamp === null || timestamp === undefined) {
        return new Date();
      }
      
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        return new Date();
      }
      
      return date;
    } catch {
      return new Date();
    }
  }

  /**
   * Creates a fallback log entry with error indication
   * @private
   * @param {string} content - Log content
   * @param {Date|number|null} timestamp - Timestamp
   * @param {string} errorType - Type of error for debugging
   * @returns {string} Formatted fallback log entry
   */
  static _createFallbackLogEntry(content, timestamp, errorType = null) {
    try {
      const now = this._createSafeDate(timestamp);
      const dateStr = this.formatDate(now) || now.toLocaleDateString();
      const timeStr = this.formatTime(now) || now.toLocaleTimeString();
      
      const prefix = errorType ? `[${dateStr} ${timeStr}] [LOG_ERROR]` : `[${dateStr} ${timeStr}]`;
      return `${prefix} ${content}`;
    } catch {
      // Ultimate fallback if even basic formatting fails
      const fallbackTime = new Date().toLocaleString();
      return `[${fallbackTime}] [FALLBACK] ${content}`;
    }
  }

  /**
   * Detects if a log line already contains a full date+time timestamp
   * Optimized to use cached regex patterns
   * @param {string} logLine - The log line to check
   * @returns {boolean} True if full timestamp is detected
   */
  static hasTimestamp(logLine) {
    try {
      if (!logLine || typeof logLine !== 'string') {
        return false;
      }

      const trimmedLine = logLine.trim();
      if (trimmedLine === '') {
        return false;
      }

      // Use cached patterns for better performance
      return this._fullTimestampPatterns.some(pattern => {
        try {
          return pattern.test(trimmedLine);
        } catch (patternError) {
          console.warn('Pattern test error in hasTimestamp:', patternError);
          return false;
        }
      });
    } catch (error) {
      console.warn('LogFormatter.hasTimestamp error:', error);
      return false;
    }
  }

  /**
   * Detects if a log line has a time-only timestamp (like Minecraft server logs)
   * Optimized to use cached regex patterns
   * @param {string} logLine - The log line to check
   * @returns {boolean} True if time-only timestamp is detected
   */
  static hasTimeOnlyTimestamp(logLine) {
    try {
      if (!logLine || typeof logLine !== 'string') {
        return false;
      }

      const trimmedLine = logLine.trim();
      if (trimmedLine === '') {
        return false;
      }

      // Use cached patterns for better performance
      return this._timeOnlyPatterns.some(pattern => {
        try {
          return pattern.test(trimmedLine);
        } catch (patternError) {
          console.warn('Pattern test error in hasTimeOnlyTimestamp:', patternError);
          return false;
        }
      });
    } catch (error) {
      console.warn('LogFormatter.hasTimeOnlyTimestamp error:', error);
      return false;
    }
  }

  /**
   * Groups log entries by date for better organization
   * Optimized with caching and efficient algorithms
   * @param {string[]} logs - Array of log entries
   * @returns {Object} Object with dates as keys and arrays of logs as values
   */
  static groupLogsByDate(logs) {
    try {
      if (!Array.isArray(logs)) {
        console.warn('LogFormatter.groupLogsByDate: Input is not an array, returning empty object');
        return {};
      }

      // Performance optimization: Check if input is the same as last time
      const inputKey = logs.length > 0 ? `${logs.length}-${logs[0]}-${logs[logs.length - 1]}` : 'empty';
      if (this._lastGroupingInput === inputKey && this._lastGroupingResult) {
        return this._lastGroupingResult;
      }

      // Performance optimization: Use efficient grouping algorithm
      const groups = {};
      const fallbackDate = new Date().toDateString();
      
      // Pre-allocate arrays to avoid repeated object property creation
      const dateKeys = new Set();
      
      // First pass: collect unique date keys
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        
        if (log === null || log === undefined || (typeof log === 'string' && log.trim() === '')) {
          continue;
        }
        
        try {
          let dateKey = fallbackDate;
          if (typeof log === 'string') {
            const date = this.extractDate(log);
            if (date) {
              dateKey = date.toDateString();
            }
          }
          dateKeys.add(dateKey);
        } catch {
          dateKeys.add(fallbackDate);
        }
      }
      
      // Pre-allocate arrays for each date
      dateKeys.forEach(dateKey => {
        groups[dateKey] = [];
      });
      
      // Second pass: populate groups
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        
        try {
          // Skip null, undefined, or empty entries
          if (log === null || log === undefined) {
            continue;
          }
          
          if (typeof log !== 'string') {
            // Convert to string and group under fallback date
            const convertedLog = String(log);
            groups[fallbackDate].push(convertedLog);
            continue;
          }

          // Handle empty strings
          if (log.trim() === '') {
            continue;
          }

          // Extract date with error handling
          let dateKey = fallbackDate;
          try {
            const date = this.extractDate(log);
            if (date) {
              dateKey = date.toDateString();
            }
          } catch {
            // Use fallback date
          }
          
          groups[dateKey].push(log);
          
        } catch (logError) {
          console.warn(`LogFormatter.groupLogsByDate: Error processing log ${i}:`, logError);
          // Add problematic log to fallback date group
          groups[fallbackDate].push(String(log || '(invalid log entry)'));
        }
      }
      
      // Remove empty groups
      Object.keys(groups).forEach(key => {
        if (groups[key].length === 0) {
          delete groups[key];
        }
      });
      
      // Cache the result
      this._lastGroupingInput = inputKey;
      this._lastGroupingResult = groups;
      
      return groups;
    } catch (error) {
      console.error('LogFormatter.groupLogsByDate: Critical error:', error);
      return {};
    }
  }

  /**
   * Extracts date from a log entry
   * @param {string} logLine - The log line to extract date from
   * @returns {Date|null} Extracted date or null if not found
   */
  static extractDate(logLine) {
    try {
      if (!logLine || typeof logLine !== 'string') {
        return null;
      }

      const line = logLine.trim();
      if (line === '') {
        return null;
      }
      
      // Try to extract date from various timestamp formats
      const datePatterns = [
        // [YYYY-MM-DD HH:MM:SS] format
        {
          pattern: /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/,
          parser: (match) => new Date(`${match[1]}T${match[2]}`)
        },
        // [M/D/YYYY H:MM:SS] format (our application format)
        {
          pattern: /^\[(\d{1,2}\/\d{1,2}\/\d{4}) (\d{1,2}:\d{2}:\d{2})\]/,
          parser: (match) => new Date(`${match[1]} ${match[2]}`)
        },
        // ISO format YYYY-MM-DDTHH:MM:SS
        {
          pattern: /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
          parser: (match) => new Date(match[1])
        },
        // YYYY-MM-DD HH:MM:SS format
        {
          pattern: /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
          parser: (match) => new Date(match[1])
        },
        // [Mon Jan 01 12:00:00] format
        {
          pattern: /^\[(\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2})/,
          parser: (match) => new Date(match[1])
        },
        // Additional robust patterns for various formats
        {
          pattern: /^\[(\w{3} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2})\]/,
          parser: (match) => new Date(match[1])
        },
        // Handle malformed but parseable timestamps
        {
          pattern: /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
          parser: (match) => {
            const dateStr = match[1].replace(/\//g, '-');
            const date = new Date(dateStr);
            return isNaN(date.getTime()) ? null : date;
          }
        }
      ];

      for (const { pattern, parser } of datePatterns) {
        try {
          const match = line.match(pattern);
          if (match) {
            const date = parser(match);
            if (date && !isNaN(date.getTime())) {
              // Validate the date is reasonable (not too far in past/future)
              const now = new Date();
              const yearDiff = Math.abs(date.getFullYear() - now.getFullYear());
              if (yearDiff <= 10) { // Allow dates within 10 years
                return date;
              }
            }
          }
        } catch (parseError) {
          // Continue to next pattern if parsing fails
          console.warn(`LogFormatter.extractDate: Pattern parsing failed:`, parseError);
          continue;
        }
      }

      return null;
    } catch (error) {
      console.warn('LogFormatter.extractDate error:', error);
      return null;
    }
  }

  /**
   * Formats date using locale-aware formatting
   * @param {Date} date - Date to format
   * @param {string} locale - Locale string (defaults to user's locale)
   * @param {Object} options - Intl.DateTimeFormat options
   * @returns {string} Formatted date string
   */
  static formatDate(date, locale = undefined, options = {}) {
    try {
      if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
        return '';
      }

      const defaultOptions = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...options
      };

      try {
        return new Intl.DateTimeFormat(locale, defaultOptions).format(date);
      } catch (intlError) {
        console.warn('LogFormatter.formatDate: Intl.DateTimeFormat failed, using fallback:', intlError);
        // Fallback to basic formatting if Intl fails
        try {
          return date.toLocaleDateString();
        } catch (fallbackError) {
          console.warn('LogFormatter.formatDate: toLocaleDateString failed, using manual format:', fallbackError);
          // Ultimate fallback - manual formatting
          return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
        }
      }
    } catch (error) {
      console.warn('LogFormatter.formatDate: Critical error:', error);
      return '';
    }
  }

  /**
   * Formats time using locale-aware formatting
   * @param {Date} date - Date to format time from
   * @param {string} locale - Locale string (defaults to user's locale)
   * @param {Object} options - Intl.DateTimeFormat options
   * @returns {string} Formatted time string
   */
  static formatTime(date, locale = undefined, options = {}) {
    try {
      if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
        return '';
      }

      const defaultOptions = {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        ...options
      };

      try {
        return new Intl.DateTimeFormat(locale, defaultOptions).format(date);
      } catch (intlError) {
        console.warn('LogFormatter.formatTime: Intl.DateTimeFormat failed, using fallback:', intlError);
        // Fallback to basic formatting if Intl fails
        try {
          return date.toLocaleTimeString();
        } catch (fallbackError) {
          console.warn('LogFormatter.formatTime: toLocaleTimeString failed, using manual format:', fallbackError);
          // Ultimate fallback - manual formatting
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          const seconds = String(date.getSeconds()).padStart(2, '0');
          return `${hours}:${minutes}:${seconds}`;
        }
      }
    } catch (error) {
      console.warn('LogFormatter.formatTime: Critical error:', error);
      return '';
    }
  }

  /**
   * Creates a formatted timestamp string using locale-aware formatting
   * @param {Date} date - Date to format
   * @param {string} locale - Locale string (defaults to user's locale)
   * @param {Object} dateOptions - Date formatting options
   * @param {Object} timeOptions - Time formatting options
   * @returns {string} Formatted timestamp string
   */
  static formatTimestamp(date, locale = undefined, dateOptions = {}, timeOptions = {}) {
    const formattedDate = this.formatDate(date, locale, dateOptions);
    const formattedTime = this.formatTime(date, locale, timeOptions);
    
    return `${formattedDate} ${formattedTime}`;
  }

  /**
   * Enhanced formatLogEntry with locale-aware formatting
   * @param {string} logLine - The raw log line to format
   * @param {Date|number|null} timestamp - Optional timestamp to use
   * @param {string} locale - Locale string for formatting
   * @param {Object} options - Formatting options
   * @returns {string} Formatted log entry with locale-aware timestamp
   */
  static formatLogEntryWithLocale(logLine, timestamp = null, locale = undefined, options = {}) {
    try {
      // Handle null, undefined, or non-string inputs
      if (logLine === null || logLine === undefined) {
        return this._createFallbackLogEntry('(null log entry)', timestamp);
      }
      
      if (typeof logLine !== 'string') {
        try {
          const converted = String(logLine);
          return this._createFallbackLogEntry(`(converted: ${converted})`, timestamp);
        } catch {
          return this._createFallbackLogEntry('(invalid log entry)', timestamp);
        }
      }

      // Handle empty strings
      if (logLine.trim() === '') {
        return this._createFallbackLogEntry('(empty log entry)', timestamp);
      }

      // Check if log already has timestamp
      if (this.hasTimestamp(logLine)) {
        return logLine;
      }

      const now = this._createSafeDate(timestamp);
      const formattedTimestamp = this.formatTimestamp(now, locale, options.date, options.time);
      
      return `[${formattedTimestamp}] ${logLine}`;
    } catch (error) {
      console.warn('LogFormatter.formatLogEntryWithLocale error:', error);
      return this._createFallbackLogEntry(
        logLine || '(error formatting log)', 
        timestamp, 
        'locale formatting error'
      );
    }
  }

  /**
   * Batch format multiple log entries efficiently
   * Optimized for virtual scrolling performance
   * @param {string[]} logs - Array of log entries to format
   * @param {Date|number|null} baseTimestamp - Base timestamp for entries without timestamps
   * @returns {string[]} Array of formatted log entries
   */
  static batchFormatLogs(logs, baseTimestamp = null) {
    try {
      if (!Array.isArray(logs)) {
        return [];
      }

      const results = new Array(logs.length);
      const now = this._createSafeDate(baseTimestamp);
      
      // Pre-calculate common formatted strings
      const baseDateStr = this._getCachedFormattedDate(now);
      const baseTimeStr = this._getCachedFormattedTime(now);
      
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        
        try {
          if (log === null || log === undefined) {
            results[i] = this._createFallbackLogEntry('(null log entry)', now);
            continue;
          }
          
          if (typeof log !== 'string') {
            results[i] = this._createFallbackLogEntry(`(converted: ${String(log)})`, now);
            continue;
          }
          
          if (log.trim() === '') {
            results[i] = this._createFallbackLogEntry('(empty log entry)', now);
            continue;
          }
          
          // Use cached check for performance
          if (this.hasTimestamp(log)) {
            results[i] = log;
          } else if (this.hasTimeOnlyTimestamp(log)) {
            // Handle time-only timestamps efficiently
            const timeMatch = log.match(this._timeOnlyPatterns[0]) || log.match(this._timeOnlyPatterns[1]);
            if (timeMatch) {
              const timeStr = timeMatch[1] || timeMatch[0].slice(1, -1);
              const restOfLog = log.substring(timeMatch[0].length);
              results[i] = `[${baseDateStr} ${timeStr}]${restOfLog}`;
            } else {
              results[i] = `[${baseDateStr} ${baseTimeStr}] ${log}`;
            }
          } else {
            results[i] = `[${baseDateStr} ${baseTimeStr}] ${log}`;
          }
        } catch {
          results[i] = this._createFallbackLogEntry(String(log || '(error)'), now, 'batch format error');
        }
      }
      
      return results;
    } catch (error) {
      console.error('LogFormatter.batchFormatLogs: Critical error:', error);
      return logs.map(log => String(log || '(error)'));
    }
  }

  /**
   * Create formatted logs with date separators efficiently
   * Optimized for virtual scrolling with minimal memory allocation
   * @param {Object} groupedLogs - Logs grouped by date
   * @returns {string[]} Formatted logs with date separators
   */
  static createFormattedLogsWithSeparators(groupedLogs) {
    try {
      if (!groupedLogs || typeof groupedLogs !== 'object') {
        return [];
      }

      const dates = Object.keys(groupedLogs);
      if (dates.length === 0) {
        return [];
      }

      if (dates.length === 1) {
        // Single date - no separators needed
        const logs = groupedLogs[dates[0]];
        return Array.isArray(logs) ? logs.filter(log => log !== null && log !== undefined) : [];
      }

      // Multiple dates - add separators efficiently
      const sortedDates = dates.sort((a, b) => {
        try {
          return new Date(a).getTime() - new Date(b).getTime();
        } catch {
          return a.localeCompare(b);
        }
      });

      // Pre-calculate total size to avoid array resizing
      let totalSize = 0;
      sortedDates.forEach(date => {
        const logs = groupedLogs[date];
        if (Array.isArray(logs) && logs.length > 0) {
          totalSize += 1 + logs.length; // 1 for separator + logs
        }
      });

      const result = new Array(totalSize);
      let index = 0;

      for (const date of sortedDates) {
        const dateLogs = groupedLogs[date];
        if (Array.isArray(dateLogs) && dateLogs.length > 0) {
          // Add date separator
          result[index++] = `--- ${date} ---`;
          
          // Add logs for this date
          for (const log of dateLogs) {
            if (log !== null && log !== undefined) {
              result[index++] = log;
            }
          }
        }
      }

      // Trim array if we had null/undefined entries
      return result.slice(0, index);
    } catch (error) {
      console.error('LogFormatter.createFormattedLogsWithSeparators: Critical error:', error);
      return [];
    }
  }
}
