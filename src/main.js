import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'


// Create a simple global store for initial instances
const initialInstanceStore = {
  instances: [],
  loaded: false
};

// Create the missing global serverPath store that components expect
// This implements the ServerPath interface with get/set methods
let currentServerPath = '';
const serverPathStore = {
  get: () => currentServerPath,
  set: (path) => { currentServerPath = path; }
};

// Make stores available globally
if (typeof window !== 'undefined') {
  window.getInitialInstances = () => initialInstanceStore;
  
  // Safely set serverPath - check if it's already defined
  try {
    if (!window.serverPath) {
      window.serverPath = serverPathStore;
    }
  } catch (error) {
    // If setting fails, use Object.defineProperty for more control
    try {
      Object.defineProperty(window, 'serverPath', {
        value: serverPathStore,
        writable: true,
        configurable: true
      });
    } catch (defineError) {
      // TODO: Add proper logging - Could not set window.serverPath
    }
  }
}

// Mount the App first, then initialize async data
const app = mount(App, {
  target: document.getElementById('app')
});

// After app is mounted, fetch instances asynchronously
window.electron.invoke('get-instances')
  .then(instances => {
    const initialInstances = Array.isArray(instances) ? instances : [];
    
    // Store them in our simple store
    initialInstanceStore.instances = initialInstances;
    initialInstanceStore.loaded = true;
  })
  .catch(() => {
    // TODO: Add proper logging - Error fetching initial instances
    // Mark as loaded anyway
    initialInstanceStore.loaded = true;
  });

export default app;
