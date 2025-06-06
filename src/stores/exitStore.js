import { writable } from 'svelte/store';

// Controls visibility of the application exit confirmation dialog
export const showExitConfirmation = writable(false);
