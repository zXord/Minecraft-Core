import { mount } from 'svelte';
import LoggerWindow from './components/logger/LoggerWindow.svelte';
import './app.css';

// Mount the Logger Window component
const app = mount(LoggerWindow, {
  target: document.getElementById('logger-root')
});

// Store reference for potential cleanup
if (typeof window !== 'undefined') {
  // @ts-ignore
  window.loggerApp = app;
}

export default app; 