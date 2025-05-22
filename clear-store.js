const Store = require('electron-store');

// Get the store with the same name as configured in app-store.cjs
const store = new Store({
  name: 'minecraft-core-config'
});

// Clear all data
store.clear();

console.log('Electron store cleared successfully!');
console.log('Previous data:', store.store); 