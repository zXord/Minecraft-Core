const electronStore = require('electron-store');

// Get the correct constructor (handles both ESM and CJS exports)
const Store = electronStore.default || electronStore;

// Get the store with the same name as configured in app-store.cjs
const store = new Store({
  name: 'minecraft-core-config'
});

// Clear all data
store.clear();
