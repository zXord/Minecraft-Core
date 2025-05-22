<script>
  import { createEventDispatcher, onMount } from 'svelte';
  
  // Props
  export let visible = false;
  export let title = 'Confirm Action';
  export let message = 'Are you sure you want to proceed?';
  export let confirmText = 'Confirm';
  export let cancelText = 'Cancel';
  export let confirmType = 'danger'; // 'danger', 'primary', 'success'
  export let backdropClosable = true;
  export let showCancel = true;
  const noop = () => {};
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  // Reference to confirm button for focus management
  let confirmButton;
  let modalContent;
  
  // Track previous focus to restore it when dialog closes
  let previousFocus;
  
  // Handle confirm action
  function handleConfirm() {
    dispatch('confirm');
  }
  
  // Handle cancel action
  function handleCancel() {
    dispatch('cancel');
  }
  
  // Close modal when escape key is pressed
  function handleKeydown(event) {
    if (!visible) return;
    
    if (event.key === 'Escape') {
      handleCancel();
    } else if (event.key === 'Enter' && document.activeElement !== confirmButton) {
      // Handle Enter key to confirm dialog when not focused on confirm button
      handleConfirm();
    }
  }
  
  // Handle the backdrop keydown separately
  function handleBackdropKeydown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      handleCancel();
    }
  }
  
  // Handle modal content keydown for the stopPropagation
  function handleContentKeydown(event) {
    event.stopPropagation();
  }
  
  // Watch for visibility changes to manage focus
  $: if (visible) {
    // Store current focus before moving it to the dialog
    previousFocus = document.activeElement;
    
    // Focus the confirm button once the component updates
    setTimeout(() => {
      if (confirmButton) {
        confirmButton.focus();
      }
    }, 0);
  } else if (previousFocus) {
    // Restore previous focus when dialog closes
    previousFocus.focus();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if visible}
  <div 
    class="modal-backdrop" 
    on:click={backdropClosable ? handleCancel : noop}
    on:keydown={backdropClosable ? handleBackdropKeydown : noop}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    aria-describedby="dialog-message"
    tabindex="-1"
  >
    <div
      class="modal-content"
      role="document"
      bind:this={modalContent}
      on:click|stopPropagation
      on:keydown|stopPropagation
    >
      <div class="modal-header">
        <h3 id="dialog-title">{title}</h3>
      </div>
      <div class="modal-body">
        <p id="dialog-message">{message}</p>
      </div>
      <div class="modal-footer">
        {#if showCancel && cancelText}
          <button 
            class="cancel-button" 
            on:click={handleCancel}
            type="button"
          >
            {cancelText}
          </button>
        {/if}
        <button 
          class="confirm-button {confirmType}" 
          on:click={handleConfirm}
          type="button"
          bind:this={confirmButton}
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
    background: rgba(0, 0, 0, 0.6);
    z-index: 1000;
    display: flex;
    justify-content: center;
    align-items: center;
    animation: fade-in 0.2s ease-out;
  }
  
  .modal-content {
    background: #1e1e1e;
    border-radius: 8px;
    width: 90%;
    max-width: 400px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    animation: slide-up 0.3s ease-out;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  .modal-header {
    padding: 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  .modal-header h3 {
    margin: 0;
    font-size: 1.25rem;
    color: white;
  }
  
  .modal-body {
    padding: 1.5rem 1rem;
  }
  
  .modal-body p {
    margin: 0;
    color: rgba(255, 255, 255, 0.8);
    font-size: 1rem;
    line-height: 1.5;
  }
  
  .modal-footer {
    padding: 1rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  button {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    border: none;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .cancel-button {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.8);
  }
  
  .cancel-button:hover {
    background: rgba(255, 255, 255, 0.15);
  }
  
  .confirm-button {
    color: white;
  }
  
  .confirm-button.danger {
    background: #f44336;
  }
  
  .confirm-button.danger:hover {
    background: #d32f2f;
  }
  
  .confirm-button.primary {
    background: #2196f3;
  }
  
  .confirm-button.primary:hover {
    background: #1976d2;
  }
  
  .confirm-button.success {
    background: #4caf50;
  }
  
  .confirm-button.success:hover {
    background: #388e3c;
  }
  
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  
  @keyframes slide-up {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style> 