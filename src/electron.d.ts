// Typescript definitions for the Electron preload bridge
type ModpackInvokeChannel =
  | 'modpacks:search-catalog' | 'modpacks:get-project' | 'modpacks:list-versions'
  | 'modpacks:list-github-releases' | 'modpacks:list-github-assets' | 'modpacks:select-local-archive'
  | 'modpacks:reserve-server-destination'
  | 'modpacks:inspect' | 'modpacks:preflight' | 'modpacks:preflight-management'
  | 'modpacks:start-operation' | 'modpacks:cancel-job'
  | 'modpacks:get-job' | 'modpacks:get-state' | 'modpacks:list-history' | 'modpacks:list-recovery'
  | 'modpacks:recover' | 'modpacks:list-notifications' | 'modpacks:ack-notification'
  | 'modpacks:check-updates' | 'modpacks:update-tracking' | 'modpacks:verify'
  | 'modpacks:perform-safe-action';

type ModpackEventChannel =
  | 'modpacks:job-progress' | 'modpacks:job-log' | 'modpacks:state-changed' | 'modpacks:notification';

type ModpackIpcRequest = Readonly<Record<string, unknown>>;
type ModpackIpcResult<T = unknown> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: string;
        message: string;
        details: Readonly<Record<string, string>>;
        retryable: boolean;
      }>;
    }>;

interface ElectronAPI {
  invoke<T = unknown>(channel: ModpackInvokeChannel, request: ModpackIpcRequest): Promise<ModpackIpcResult<T>>;
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: ModpackEventChannel, listener: (event: Readonly<Record<string, unknown>>) => void): void;
  on(channel: string, listener: (...args: any[]) => void): void;
  removeAllListeners(channel: ModpackEventChannel | string): void;
  removeListener(channel: ModpackEventChannel, listener: (event: Readonly<Record<string, unknown>>) => void): void;
  removeListener(channel: string, listener: (...args: any[]) => void): void;
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
