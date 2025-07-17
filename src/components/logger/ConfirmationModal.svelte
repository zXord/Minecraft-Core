<script>
  import { createEventDispatcher } from 'svelte';

  export let visible = false;
  export let title = 'Confirm Action';
  export let message = 'Are you sure you want to proceed?';
  export let confirmText = 'Confirm';
  export let cancelText = 'Cancel';
  export let type = 'danger'; // 'danger', 'warning', 'info'

  const dispatch = createEventDispatcher();

  function handleConfirm() {
    dispatch('confirm');
    visible = false;
  }

  function handleCancel() {
    dispatch('cancel');
    visible = false;
  }

  function handleKeydown(event) {
    if (!visible) return;
    
    if (event.key === 'Escape') {
      handleCancel();
    } else if (event.key === 'Enter') {
      handleConfirm();
    }
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  }

  function getColorForType(type) {
    switch (type) {
      case 'danger':
        return '#ef4444';
      case 'warning':
        return '#f59e0b';
      case 'info':
      default:
        return '#3b82f6';
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if visible}
  <div class="modal-backdrop" on:click={handleBackdropClick} on:keydown={handleKeydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal-content">
      <div class="modal-header">
        <div class="modal-icon" style="color: {getColorForType(type)}">
          {#if type === 'danger'}
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" viewBox="0 0 256 256">
              <path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z"></path>
            </svg>
          {:else if type === 'warning'}
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" viewBox="0 0 256 256">
              <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z"></path>
            </svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" viewBox="0 0 256 256">
              <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm12-136a12,12,0,1,1-12-12A12,12,0,0,1,140,80Zm-8,32a8,8,0,0,0-8,8v56a8,8,0,0,0,16,0V120A8,8,0,0,0,132,112Z"></path>
            </svg>
          {/if}
        </div>
        <h3 class="modal-title">{title}</h3>
      </div>

      <div class="modal-body">
        <p class="modal-message">{message}</p>
      </div>

      <div class="modal-footer">
        <button 
          class="modal-button secondary"
          on:click={handleCancel}
          type="button"
        >
          {cancelText}
        </button>
        <button 
          class="modal-button primary {type}"
          on:click={handleConfirm}
          type="button"
        >
          {confirmText}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(4px);
  }

  .modal-content {
    background: #182634;
    border-radius: 0.75rem;
    max-width: 480px;
    width: 90%;
    border: 1px solid #314d68;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
    animation: modalSlideIn 0.2s ease-out;
  }

  @keyframes modalSlideIn {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(-20px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .modal-header {
    padding: 1.5rem 1.5rem 1rem 1.5rem;
    text-align: center;
  }

  .modal-icon {
    margin: 0 auto 1rem auto;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: bold;
    color: white;
    line-height: 1.4;
  }

  .modal-body {
    padding: 0 1.5rem 1.5rem 1.5rem;
    text-align: center;
  }

  .modal-message {
    margin: 0;
    color: #cbd5e1;
    font-size: 0.95rem;
    line-height: 1.5;
  }

  .modal-footer {
    display: flex;
    gap: 0.75rem;
    padding: 1rem 1.5rem 1.5rem 1.5rem;
    justify-content: center;
  }

  .modal-button {
    padding: 0.6rem 1.5rem;
    border-radius: 0.5rem;
    border: none;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    min-width: 80px;
  }

  .modal-button:focus {
    outline: 2px solid;
    outline-offset: 2px;
  }

  .modal-button.secondary {
    background: #374151;
    color: #d1d5db;
    border: 1px solid #4b5563;
  }

  .modal-button.secondary:hover {
    background: #4b5563;
    color: white;
  }

  .modal-button.secondary:focus {
    outline-color: #6b7280;
  }

  .modal-button.primary {
    color: white;
    font-weight: 600;
  }

  .modal-button.primary.danger {
    background: #ef4444;
    border: 1px solid #dc2626;
  }

  .modal-button.primary.danger:hover {
    background: #dc2626;
  }

  .modal-button.primary.danger:focus {
    outline-color: #ef4444;
  }

  .modal-button.primary.warning {
    background: #f59e0b;
    border: 1px solid #d97706;
    color: #1f2937;
  }

  .modal-button.primary.warning:hover {
    background: #d97706;
  }

  .modal-button.primary.warning:focus {
    outline-color: #f59e0b;
  }

  .modal-button.primary.info {
    background: #3b82f6;
    border: 1px solid #2563eb;
  }

  .modal-button.primary.info:hover {
    background: #2563eb;
  }

  .modal-button.primary.info:focus {
    outline-color: #3b82f6;
  }
</style>
