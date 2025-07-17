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
        on:click={handleStats}
        title="View logger statistics"
        aria-label="View logger statistics"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
          <path d="M232,208a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V48a8,8,0,0,1,16,0v94.37L90.73,98a8,8,0,0,1,10.07-.38l58.81,44.11L218.73,90a8,8,0,1,1,10.54,12l-64,56a8,8,0,0,1-10.07.38L96.39,114.29,40,163.63V200H224A8,8,0,0,1,232,208Z"></path>
        </svg>
      </button>

      <!-- Export Button moved here -->
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
    </div>
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