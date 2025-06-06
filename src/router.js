import { writable } from 'svelte/store';

// Initialize route from the current hash or default to dashboard
function getHash() {
  return window.location.hash.replace('#', '') || '/dashboard';
}

export const route = writable(getHash());

export function navigate(path) {
  window.location.hash = path;
  route.set(path);
}

// Listen for hash changes
window.addEventListener('hashchange', () => {
  route.set(getHash());
});
