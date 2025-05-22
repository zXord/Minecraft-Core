import { writable } from 'svelte/store';

// Tracks whether a server restart is needed after saving properties
export const propertiesRestartNeeded = writable(false); 