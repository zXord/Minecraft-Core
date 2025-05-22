import { writable } from 'svelte/store';

// Tracks whether a server restart is in progress
export const isRestarting = writable(false); 