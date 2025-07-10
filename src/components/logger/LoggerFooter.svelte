<script>
  import { createEventDispatcher } from 'svelte';

  export let logCount = 0;
  export let totalCount = 0;

  const dispatch = createEventDispatcher();

  function handleExport() {
    dispatch('export');
  }

  function handleClear() {
    dispatch('clear');
  }

  function handleSettings() {
    dispatch('settings');
  }

  function handleStats() {
    dispatch('stats');
  }
</script>

<div class="logger-footer">
  <div class="footer-left">
    <div class="log-count-info">
      <span class="count-text">
        Showing {logCount.toLocaleString()} of {totalCount.toLocaleString()} logs
      </span>
    </div>
    
    <div class="action-buttons">
      <button 
        class="action-button"
        on:click={handleExport}
        title="Export logs to file"
        aria-label="Export logs to file"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
          <path d="M216,112v96a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V112A16,16,0,0,1,56,96H80a8,8,0,0,1,0,16H56v96H200V112H176a8,8,0,0,1,0-16h24A16,16,0,0,1,216,112ZM93.66,69.66,120,43.31V136a8,8,0,0,0,16,0V43.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,69.66Z"></path>
        </svg>
      </button>
      
      <button 
        class="action-button danger"
        on:click={handleClear}
        title="Clear all logs from memory"
        aria-label="Clear all logs from memory"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
          <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"></path>
        </svg>
      </button>
      
      <button 
        class="action-button"
        on:click={handleSettings}
        title="Logger settings"
        aria-label="Logger settings"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
          <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"></path>
        </svg>
      </button>
      
      <button 
        class="action-button"
        on:click={handleStats}
        title="View logger statistics"
        aria-label="View logger statistics"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
          <path d="M232,208a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V48a8,8,0,0,1,16,0v94.37L90.73,98a8,8,0,0,1,10.07-.38l58.81,44.11L218.73,90a8,8,0,1,1,10.54,12l-64,56a8,8,0,0,1-10.07.38L96.39,114.29,40,163.63V200H224A8,8,0,0,1,232,208Z"></path>
        </svg>
      </button>
    </div>
  </div>

  <div class="footer-right">
    <button 
      class="export-button primary"
      on:click={handleExport}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
        <path d="M136,96H120V43.31L93.66,69.66A8,8,0,0,1,82.34,58.34l40-40a8,8,0,0,1,11.32,0l40,40a8,8,0,0,1-11.32,11.32L136,43.31Zm64,0H136v40a8,8,0,0,1-16,0V96H56a16,16,0,0,0-16,16v96a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V112A16,16,0,0,0,200,96Z"></path>
      </svg>
      <span>Export</span>
    </button>
  </div>
</div>

<style>
  .logger-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    background: #182634;
    border-top: 1px solid #314d68;
    border-radius: 0 0 0.5rem 0.5rem;
    gap: 1rem;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex: 1;
  }

  .footer-right {
    display: flex;
    align-items: center;
  }

  .log-count-info {
    display: flex;
    align-items: center;
  }

  .count-text {
    color: #90adcb;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .action-buttons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .action-button {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 0.375rem;
    padding: 0.5rem;
    color: #90adcb;
    cursor: pointer;
    transition: all 0.2s;
  }

  .action-button:hover {
    background: #223649;
    color: white;
  }

  .action-button.danger:hover {
    background: #ef4444;
    color: white;
  }

  .export-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: #0c7ff2;
    border: none;
    border-radius: 0.5rem;
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    min-width: 0;
  }

  .export-button:hover {
    background: #0369a1;
  }

  .export-button:active {
    transform: scale(0.98);
  }

  .export-button span {
    white-space: nowrap;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .logger-footer {
      padding: 0.75rem 1rem;
      gap: 0.75rem;
    }

    .footer-left {
      gap: 1rem;
    }

    .count-text {
      font-size: 0.8rem;
    }

    .action-buttons {
      gap: 0.25rem;
    }

    .action-button {
      padding: 0.375rem;
    }

    .export-button {
      padding: 0.4rem 0.75rem;
      font-size: 0.8rem;
    }
  }

  @media (max-width: 600px) {
    .logger-footer {
      flex-direction: column;
      align-items: stretch;
      gap: 0.75rem;
    }

    .footer-left {
      justify-content: space-between;
    }

    .footer-right {
      justify-content: center;
    }

    .export-button {
      width: 100%;
      justify-content: center;
    }
  }

  @media (max-width: 480px) {
    .log-count-info {
      order: 1;
    }

    .action-buttons {
      order: 2;
      justify-content: center;
    }

    .footer-left {
      flex-direction: column;
      gap: 0.5rem;
    }
  }
</style> 