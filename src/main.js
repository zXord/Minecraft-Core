import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// Create a simple global store for initial instances
const initialInstanceStore = {
  instances: [],
  loaded: false
};

// Make it available globally (we'll fix this more elegantly later)
if (typeof window !== 'undefined') {
  window.getInitialInstances = () => initialInstanceStore;
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
    
    // Mark as loaded anyway
    initialInstanceStore.loaded = true;
  });

// 2) Mount the App immediately (it will check for loaded instances in onMount)
const app = mount(App, {
  target: document.getElementById('app')
});

export default app;
