// Typescript definitions for the Electron preload bridge
interface ElectronAPI {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  on: (channel: string, listener: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
  removeListener: (channel: string, listener: (...args: any[]) => void) => void;
  // Present only in browser panel shim
  isBrowserPanel?: boolean;
}

interface ServerPath {
  get: () => string;
  set: (path: string) => void;
}

interface FolderOpener {
  open: (folderPath: string) => Promise<any>;
}

// Extend the Window interface
interface Window {
  electron: ElectronAPI;
  serverPath: ServerPath;
  folderOpener: FolderOpener;
  _folderOpenInProgress?: boolean; // Flag for debouncing folder opens
  getInitialInstances?: () => { instances: any[], loaded: boolean };
  appStartupCompleted?: boolean; // Flag to track if app startup is complete
  // Set by browser panel shim to detect web context
  IS_BROWSER_PANEL?: boolean;
}
