import { writable } from 'svelte/store';

// Client download state store
export const clientDownloadState = writable({
  status: 'unknown', // 'unknown', 'checking', 'needed', 'downloading', 'ready', 'error'
  progress: 0,
  speed: '0 MB/s',
  totalFiles: 0,
  completedFiles: 0,
  currentFile: '',
  error: null
});

// Update download progress
export function updateDownloadProgress(progress) {
  clientDownloadState.update(state => ({
    ...state,
    progress: progress.percent || 0,
    speed: progress.speed || '0 MB/s',
    currentFile: progress.fileName || state.currentFile
  }));
}

// Set download status
export function setDownloadStatus(status, data = {}) {
  clientDownloadState.update(state => ({
    ...state,
    status,
    ...data
  }));
}

// Reset download state
export function resetDownloadState() {
  clientDownloadState.set({
    status: 'unknown',
    progress: 0,
    speed: '0 MB/s',
    totalFiles: 0,
    completedFiles: 0,
    currentFile: '',
    error: null
  });
} 