import { mount } from 'svelte';
import LoggerWindow from './components/logger/LoggerWindow.svelte';
import './app.css';

const loggerRoot = document.getElementById('logger-root');
let app = null;

if (loggerRoot) {
  app = mount(LoggerWindow, {
    target: loggerRoot
  });
}

if (typeof window !== 'undefined' && app) {
  // @ts-ignore
  window.loggerApp = app;
}

export default app;
