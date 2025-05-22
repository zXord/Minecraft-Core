<script>
  import { onDestroy } from 'svelte';
  import { errorMessage, successMessage } from '../../stores/modStore.js';
  import StatusMessage from './StatusMessage.svelte';
  
  // Local state to track all messages
  let messages = [];
  let messageId = 0;
  let clearTimeouts = new Map();
  
  // Subscribe to message stores
  const successUnsubscribe = successMessage.subscribe(message => {
    if (message) {
      addMessage(message, 'success');
      const timeoutId = setTimeout(() => successMessage.set(''), 100);
      clearTimeouts.set('success', timeoutId);
    }
  });
  
  const errorUnsubscribe = errorMessage.subscribe(message => {
    if (message) {
      addMessage(message, 'error');
      const timeoutId = setTimeout(() => errorMessage.set(''), 100);
      clearTimeouts.set('error', timeoutId);
    }
  });
  
  // Add a message to the messages array
  function addMessage(text, type = 'info') {
    if (!text) return;
    
    const id = messageId++;
    messages = [...messages, { id, text, type }];
    
    // Auto-remove after 10 seconds (failsafe)
    const timeoutId = setTimeout(() => {
      removeMessage(id);
    }, 10000);
    
    clearTimeouts.set(`message-${id}`, timeoutId);
    return id;
  }
  
  // Remove a message by ID
  function removeMessage(id) {
    messages = messages.filter(msg => msg.id !== id);
    
    // Clear the timeout if it exists
    if (clearTimeouts.has(`message-${id}`)) {
      clearTimeout(clearTimeouts.get(`message-${id}`));
      clearTimeouts.delete(`message-${id}`);
    }
  }
  
  // Clean up subscriptions and timeouts
  onDestroy(() => {
    successUnsubscribe();
    errorUnsubscribe();
    
    // Clear all timeouts
    clearTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    clearTimeouts.clear();
  });
</script>

<div class="status-container">
  {#each messages as message (message.id)}
    <StatusMessage 
      message={message.text} 
      type={message.type} 
      on:close={() => removeMessage(message.id)}
    />
  {/each}
</div>

<style>
  .status-container {
    position: fixed;
    top: 1rem;
    right: 1rem;
    max-width: 400px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style> 