/**
 * Utility functions for date formatting and handling
 */

/**
 * Format an installation date to a user-friendly format
 * @param {string|null} dateString - ISO date string or null
 * @returns {string} - Formatted date string
 */
export function formatInstallationDate(dateString) {
  if (!dateString) {
    return 'Installation date unknown';
  }
  
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = Number(now) - Number(date);
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      return 'Installed today';
    } else if (diffDays === 1) {
      return 'Installed yesterday';
    } else if (diffDays < 7) {
      return `Installed ${diffDays} days ago`;
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return `Installed ${weeks} week${weeks > 1 ? 's' : ''} ago`;
    } else if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      return `Installed ${months} month${months > 1 ? 's' : ''} ago`;
    } else {
      const years = Math.floor(diffDays / 365);
      return `Installed ${years} year${years > 1 ? 's' : ''} ago`;
    }
  } catch {
    return 'Installation date unknown';
  }
}

/**
 * Format a last updated date to a user-friendly format
 * @param {string|null} dateString - ISO date string or null
 * @returns {string} - Formatted date string
 */
export function formatLastUpdated(dateString) {
  if (!dateString) {
    return 'Never updated';
  }
  
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = Number(now) - Number(date);
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      return 'Updated today';
    } else if (diffDays === 1) {
      return 'Updated yesterday';
    } else if (diffDays < 7) {
      return `Updated ${diffDays} days ago`;
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return `Updated ${weeks} week${weeks > 1 ? 's' : ''} ago`;
    } else if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      return `Updated ${months} month${months > 1 ? 's' : ''} ago`;
    } else {
      const years = Math.floor(diffDays / 365);
      return `Updated ${years} year${years > 1 ? 's' : ''} ago`;
    }
  } catch {
    return 'Never updated';
  }
}

/**
 * Format a date to a precise format for tooltips
 * @param {string|null} dateString - ISO date string or null
 * @returns {string} - Formatted date string
 */
export function formatPreciseDate(dateString) {
  if (!dateString) {
    return 'Unknown';
  }
  
  try {
    const date = new Date(dateString);
    return date.toLocaleString();
  } catch {
    return 'Unknown';
  }
}

/**
 * Format a date to a user-friendly format for tooltips
 * @param {string|null} dateString - ISO date string or null
 * @returns {string} - Formatted date string
 */
export function formatTooltipDate(dateString) {
  if (!dateString) {
    return 'Installation date unknown';
  }
  
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return 'Installation date unknown';
  }
}