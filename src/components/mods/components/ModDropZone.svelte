<!-- @ts-ignore -->
<script>
  import { createEventDispatcher } from 'svelte';
  import { isDragging } from '../../../stores/modStore.js';
  
  // Props
  export let disabled = false;
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  /**
   * Handle file drop event
   * @param {DragEvent} event - Drop event
   */
  function handleDrop(event) {
    event.preventDefault();
    $isDragging = false;
    
    if (disabled) return;
    
    // Handle dropped files
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    
    // Process each JAR file
    const jarFiles = Array.from(files).filter(file => 
      file.name.toLowerCase().endsWith('.jar')
    );
    
    if (jarFiles.length === 0) return;
    
    // Send files to parent
    dispatch('filesDropped', { files: jarFiles });
  }
  
  /**
   * Handle drag enter event
   * @param {DragEvent} event - Drag enter event
   */
  function handleDragEnter(event) {
    event.preventDefault();
    if (disabled) return;
    $isDragging = true;
  }
  
  /**
   * Handle drag over event
   * @param {DragEvent} event - Drag over event
   */
  function handleDragOver(event) {
    event.preventDefault();
    if (disabled) return;
    $isDragging = true;
  }
  
  /**
   * Handle drag leave event
   * @param {DragEvent} event - Drag leave event
   */
  function handleDragLeave(event) {
    event.preventDefault();
    if (disabled) return;
    $isDragging = false;
  }
  
  /**
   * Handle file input change event
   * @param {Event} event - Change event
   */
  function handleFileInputChange(event) {
    if (disabled) return;
    
    // Convert target to HTMLInputElement
    const fileInput = /** @type {HTMLInputElement} */ (event.target);
    const files = fileInput.files;
    
    if (!files || files.length === 0) return;
    
    // Process each JAR file
    const jarFiles = Array.from(files).filter(file => 
      file.name.toLowerCase().endsWith('.jar')
    );
    
    if (jarFiles.length === 0) return;
    
    // Send files to parent
    dispatch('filesDropped', { files: jarFiles });
    
    // Reset file input
    fileInput.value = '';
  }
  
  /**
   * Handle keydown event for keyboard accessibility
   * @param {KeyboardEvent} event - Keyboard event
   */
  function handleKeydown(event) {
    if (disabled) return;
    
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      document.getElementById('file-input').click();
    }
  }
</script>

<div 
  class="drop-zone"
  class:dragging={$isDragging}
  class:disabled
  on:dragenter={handleDragEnter}
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
  on:keydown={handleKeydown}
  tabindex={disabled ? -1 : 0}
  role="button"
  aria-label="Drop mod files here or press Enter to browse"
  aria-disabled={disabled}
>
  <div class="drop-zone-content">
    <div class="drop-icon" aria-hidden="true">📥</div>
    <div class="drop-message">
      {#if $isDragging}
        <span>Drop mod files here</span>
      {:else}
        <span>Drag and drop .jar files here</span>
        <span class="or-text">or</span>
        <label class="browse-button">
          Browse Files
          <input 
            id="file-input"
            type="file" 
            accept=".jar" 
            multiple 
            on:change={handleFileInputChange} 
            disabled={disabled}
            aria-hidden="true"
            tabindex="-1"
          />
        </label>
      {/if}
    </div>
  </div>
</div>

<style>
  .drop-zone {
    border: 2px dashed rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    padding: 2rem;
    margin: 1rem 0;
    transition: all 0.2s;
    cursor: pointer;
    background: rgba(0, 0, 0, 0.2);
  }
  
  .drop-zone:hover:not(.disabled) {
    border-color: rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.3);
  }
  
  .drop-zone:focus:not(.disabled) {
    outline: none;
    border-color: #646cff;
    box-shadow: 0 0 0 2px rgba(100, 108, 255, 0.3);
  }
  
  .drop-zone.dragging:not(.disabled) {
    border-color: #646cff;
    background: rgba(100, 108, 255, 0.1);
    transform: scale(1.01);
  }
  
  .drop-zone.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .drop-zone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }
  
  .drop-icon {
    font-size: 2rem;
    opacity: 0.7;
  }
  
  .drop-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    color: rgba(255, 255, 255, 0.7);
    text-align: center;
  }
  
  .or-text {
    font-size: 0.8rem;
    opacity: 0.5;
  }
  
  .browse-button {
    background: rgba(255, 255, 255, 0.1);
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .browse-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  
  input[type="file"] {
    display: none;
  }
</style> 