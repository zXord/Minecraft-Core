import { writable } from 'svelte/store';

// Initialize route from the current hash or default to dashboard
function getHash() {
  return window.location.hash.replace('#', '') || '/dashboard';
}

export const route = writable(getHash());

/**
 * Navigate to a specific route
 * @param {string} path - The route path to navigate to
 */
export function navigate(path) {
  const routePath = typeof path === 'string' ? path : String(path);
  window.location.hash = routePath;
  route.set(routePath);
}

// Listen for hash changes
window.addEventListener('hashchange', () => {
  route.set(getHash());
});
