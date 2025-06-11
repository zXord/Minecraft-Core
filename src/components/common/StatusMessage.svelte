<script>
  import { fade, fly } from 'svelte/transition';
  import { onDestroy, createEventDispatcher } from 'svelte';
  
  // Props
  export let message = '';
  export let type = 'info'; // 'success', 'error', 'info', 'warning'
  export let duration = 5000; // ms
  export let autoClose = true;
  
  // Local state
  let visible = true;
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  // Auto-hide timer
  let timer;
  
  // Start the auto-hide timer when component mounts or when message changes
  $: if (message && autoClose) {
    resetTimer();
  }
  
  function resetTimer() {
    // Clear any existing timer
    if (timer) clearTimeout(timer);
    
    // Set timer only if there's a message and autoClose is enabled
    if (message && autoClose) {
      timer = setTimeout(() => {
        closeMessage();
      }, duration);
    }
  }
  
  function closeMessage() {
    visible = false;
    // Wait for animation to complete before dispatching close event
    setTimeout(() => {
      dispatch('close');
    }, 300);
  }
  
  // Clean up timer when component is destroyed
  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });
  
  // Icons for different message types
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
</script>

{#if message && visible}
  <div 
    class="status-message {type}"
    in:fly={{ y: -20, duration: 300 }}
    out:fade={{ duration: 200 }}
    on:mouseenter={() => { if (timer) clearTimeout(timer); }}
    on:mouseleave={resetTimer}
    role="alert"
    aria-live="polite"
  >
    <span class="icon">{icons[type]}</span>
    <span class="message">{message}</span>
    <button 
      class="close-button" 
      on:click={closeMessage}
      aria-label="Close message"
    >
      ×
    </button>
  </div>
{/if}

<style>
  .status-message {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0.75rem 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    max-width: 100%;
    animation: slide-in 0.3s ease;
  }
  
  .success {
    background-color: #e6f7e6;
    border-left: 4px solid #43a047;
    color: #2e7d32;
  }
  
  .error {
    background-color: #ffebee;
    border-left: 4px solid #e53935;
    color: #c62828;
  }
  
  .warning {
    background-color: #fff8e1;
    border-left: 4px solid #ffb300;
    color: #ff8f00;
  }
  
  .info {
    background-color: #e3f2fd;
    border-left: 4px solid #2196f3;
    color: #1565c0;
  }
  
  .icon {
    margin-right: 0.75rem;
    font-size: 1.2rem;
  }
  
  .message {
    flex: 1;
    word-break: break-word;
  }
  
  .close-button {
    background: none;
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.5rem;
    opacity: 0.7;
    transition: opacity 0.2s;
  }
  
  .close-button:hover {
    opacity: 1;
  }
  
  @keyframes slide-in {
    from {
      transform: translateY(-20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style> 