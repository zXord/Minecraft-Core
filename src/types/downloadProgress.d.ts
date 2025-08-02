/**
 * TypeScript definitions for enhanced download progress system
 */

export interface ChecksumValidationResult {
  isValid: boolean;
  expected: string;
  actual: string;
  algorithm: string;
  validationTime: number;
}

export interface DownloadError {
  timestamp: number;
  source: DownloadSource;
  attempt: number;
  type: 'network' | 'checksum' | 'timeout' | 'server' | 'unknown';
  message: string;
  details?: {
    httpStatus?: number;
    checksumMismatch?: ChecksumValidationResult;
    networkError?: string;
  };
}

export type DownloadState = 
  | 'queued'
  | 'downloading' 
  | 'verifying'
  | 'retrying'
  | 'fallback'
  | 'completed'
  | 'failed';

export type DownloadSource = 'server' | 'modrinth' | 'curseforge';

export interface EnhancedDownloadProgress {
  // Basic properties
  id: string;
  name: string;
  state: DownloadState;
  progress: number;
  size?: number;
  speed?: number;
  
  // Enhanced properties
  source: DownloadSource;
  attempt: number;
  maxAttempts: number;
  checksumValidation?: ChecksumValidationResult;
  fallbackCountdown?: number;
  estimatedTimeRemaining?: number;
  queuePosition?: number;
  
  // Status messages
  statusMessage: string;
  detailedStatus?: string;
  
  // Error information
  error?: string;
  errorDetails?: DownloadError;
  
  // Timestamps
  startTime: number;
  completedTime?: number;
  lastUpdateTime: number;
  
  // Legacy compatibility
  completed: boolean;
}

export interface DownloadStatistics {
  total: number;
  queued: number;
  downloading: number;
  verifying: number;
  retrying: number;
  fallback: number;
  completed: number;
  failed: number;
  averageSpeed: number;
  totalSize: number;
  completedSize: number;
}