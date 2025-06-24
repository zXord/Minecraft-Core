import App from './App.svelte'
import './app.css'
import './components/client/client.css'

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
  window.serverPath = serverPathStore; // Initialize the missing global store
}

// 1) Fetch saved instances before mounting the app
window.electron.invoke('get-instances')
  .then(instances => {
    const initialInstances = Array.isArray(instances) ? instances : [];
    
    // Store them in our simple store
    initialInstanceStore.instances = initialInstances;
    initialInstanceStore.loaded = true;
  })
  .catch(error => {
    console.error('Error fetching initial instances:', error);
    // Mark as loaded anyway
    initialInstanceStore.loaded = true;
  });

// TEMPORARILY DISABLED - Testing if our monitoring code causes the spikes
// Global interval tracking for debugging
// console.log('🔍 Frontend Interval Tracker Enabled');
// const originalSetInterval = window.setInterval;
// const originalSetTimeout = window.setTimeout;
// let intervalCount = 0;

// window.setInterval = function(fn, delay, ...args) {
//   intervalCount++;
//   console.log(`➕ Frontend Interval #${intervalCount}: ${delay}ms`);
//   
//   if (delay >= 4000 && delay <= 6000) {
//     console.log(`🚨 SUSPICIOUS 5-SECOND INTERVAL DETECTED!`, new Error().stack);
//   }
//   
//   return originalSetInterval.call(this, function() {
//     console.log(`🔄 [${new Date().toISOString()}] Frontend Interval ${delay}ms FIRED`);
//     return fn.apply(this, args);
//   }, delay, ...args);
// };

// Note: setTimeout override removed due to TypeScript typing conflicts
// Focus on setInterval tracking above which is more likely to cause recurring spikes

// 2) Mount the App immediately (it will check for loaded instances in onMount)
const app = new App({
  target: document.getElementById('app')
});

export default app;
