<!-- @ts-ignore -->
<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { DOWNLOAD_STATES } from '../../../stores/modStore.js';
  
  /** @type {any} */
  export let toast = null;
  /** @type {number} */
  export let duration = 4000; // 4 seconds default
  
  const dispatch = createEventDispatcher();
  
  let visible = false;
  let timeoutId = null;
  
  onMount(() => {
    if (toast) {
      visible = true;
      
      // Auto-dismiss after duration
      timeoutId = setTimeout(() => {
        dismiss();
      }, duration);
    }
    
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  });
  
  function dismiss() {
    visible = false;
    setTimeout(() => {
      dispatch('dismiss');
    }, 300); // Wait for animation to complete
  }
  
  /**
   * @param {any} type
   * @param {any} state
   * @returns {string}
   */
  function getToastIcon(type, state) {
    if (type === 'download-state') {
      switch (state) {
        case DOWNLOAD_STATES.COMPLETED:
          return '✅';
        case DOWNLOAD_STATES.FAILED:
          return '❌';
        case DOWNLOAD_STATES.RETRYING:
          return '🔄';
        case DOWNLOAD_STATES.FALLBACK:
          return '🔀';
        case DOWNLOAD_STATES.VERIFYING:
          return '🔍';
        default:
          return '📥';
      }
    }
    
    switch (type) {
      case 'success':
        return '✅';
      case 'error':
        return '❌';
      case 'warning':
        return '⚠️';
      case 'info':
        return 'ℹ️';
      default:
        return '📥';
    }
  }
  
  /**
   * @param {any} type
   * @param {any} state
   * @returns {string}
   */
  function getToastClass(type, state) {
    if (type === 'download-state') {
      switch (state) {
        case DOWNLOAD_STATES.COMPLETED:
          return 'success';
        case DOWNLOAD_STATES.FAILED:
          return 'error';
        case DOWNLOAD_STATES.RETRYING:
          return 'warning';
        case DOWNLOAD_STATES.FALLBACK:
          return 'info';
        case DOWNLOAD_STATES.VERIFYING:
          return 'info';
        default:
          return 'info';
      }
    }
    
    return type || 'info';
  }
  
  /**
   * @param {any} toast
   * @returns {string}
   */
  function getToastTitle(toast) {
    if (toast.type === 'download-state') {
      switch (toast.state) {
        case DOWNLOAD_STATES.COMPLETED:
          return 'Download Complete';
        case DOWNLOAD_STATES.FAILED:
          return 'Download Failed';
        case DOWNLOAD_STATES.RETRYING:
          return 'Retrying Download';
        case DOWNLOAD_STATES.FALLBACK:
          return 'Using Alternative Source';
        case DOWNLOAD_STATES.VERIFYING:
          return 'Verifying Download';
        default:
          return 'Download Update';
      }
    }
    
    return toast.title || 'Notification';
  }
  
  /**
   * @param {any} action
   */
  function handleAction(action) {
    if (action && action.handler) {
      action.handler();
    }
    dismiss();
  }
</script>

{#if toast && visible}
  <div 
    class="toast {getToastClass(toast.type, toast.state)}" 
    class:visible
    role="alert"
    aria-live="polite"
  >
    <div class="toast-content">
      <div class="toast-icon">
        {getToastIcon(toast.type, toast.state)}
      </div>
      
      <div class="toast-body">
        <div class="toast-title">{getToastTitle(toast)}</div>
        <div class="toast-message">{toast.message}</div>
        
        {#if toast.progress !== undefined}
          <div class="toast-progress">
            <div class="progress-bar" style="width: {toast.progress}%"></div>
          </div>
        {/if}
      </div>
      
      {#if toast.actions && toast.actions.length > 0}
        <div class="toast-actions">
          {#each toast.actions as action, index (index)}
            <button 
              class="toast-action-btn" 
              on:click={() => handleAction(action)}
              type="button"
            >
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
      
      <button 
        class="toast-close" 
        on:click={dismiss}
        aria-label="Dismiss notification"
        type="button"
      >
        ✕
      </button>
    </div>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    top: 20px;
    right: 20px;
    min-width: 300px;
    max-width: 400px;
    background: #2a2a2a;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    z-index: 1001;
    transform: translateX(100%);
    opacity: 0;
    transition: all 0.3s ease;
  }
  
  .toast.visible {
    transform: translateX(0);
    opacity: 1;
  }
  
  .toast.success {
    border-left: 4px solid #4caf50;
  }
  
  .toast.error {
    border-left: 4px solid #f44336;
  }
  
  .toast.warning {
    border-left: 4px solid #ff9800;
  }
  
  .toast.info {
    border-left: 4px solid #2196f3;
  }
  
  .toast-content {
    display: flex;
    align-items: flex-start;
    padding: 12px 16px;
    gap: 12px;
  }
  
  .toast-icon {
    font-size: 18px;
    flex-shrink: 0;
    margin-top: 2px;
  }
  
  .toast-body {
    flex: 1;
    min-width: 0;
  }
  
  .toast-title {
    font-weight: 600;
    font-size: 14px;
    color: white;
    margin-bottom: 4px;
  }
  
  .toast-message {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
    line-height: 1.4;
    word-wrap: break-word;
  }
  
  .toast-progress {
    margin-top: 8px;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }
  
  .progress-bar {
    height: 100%;
    background: #2196f3;
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  
  .toast.success .progress-bar {
    background: #4caf50;
  }
  
  .toast.error .progress-bar {
    background: #f44336;
  }
  
  .toast.warning .progress-bar {
    background: #ff9800;
  }
  
  .toast-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-left: 8px;
  }
  
  .toast-action-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.8);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }
  
  .toast-action-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    color: white;
  }
  
  .toast-close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    font-size: 14px;
    padding: 2px;
    border-radius: 2px;
    transition: color 0.2s;
    flex-shrink: 0;
    margin-top: 2px;
  }
  
  .toast-close:hover {
    color: white;
  }
</style>