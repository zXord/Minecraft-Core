<script>
  import { createEventDispatcher } from 'svelte';
  import { currentPage, totalPages, totalResults, resultsPerPage } from '../../../stores/modStore.js';
  
  // Extract current values from stores
  $: page = $currentPage;
  $: total = $totalPages || 1; // Default to 1 if null
  $: totalItems = $totalResults || 0; // Default to 0 if null
  $: perPage = $resultsPerPage;
  
  // Calculate display values
  $: startItem = (page - 1) * perPage + 1;
  $: endItem = Math.min(startItem + perPage - 1, totalItems);
  $: showingText = totalItems > 0 ? `Showing ${startItem}-${endItem} of ${totalItems}` : 'No results';
  
  // Generate pagination range
  $: pageNumbers = generatePageNumbers(page, total);
  
  function generatePageNumbers(current, max) {
    if (max <= 7) {
      // Show all pages if 7 or fewer
      return Array.from({ length: max }, (_, i) => i + 1);
    }
    
    let pages = [];
    
    // Always show first and last page
    pages.push(1);
    
    // Handle different cases
    if (current <= 3) {
      // Near start: show 1, 2, 3, 4, 5, ..., max
      pages.push(2, 3, 4, 5, '...', max);
    } else if (current >= max - 2) {
      // Near end: show 1, ..., max-4, max-3, max-2, max-1, max
      pages.push('...', max - 4, max - 3, max - 2, max - 1, max);
    } else {
      // Middle: show 1, ..., current-1, current, current+1, ..., max
      pages.push('...', current - 1, current, current + 1, '...', max);
    }
    
    return pages;
  }
  
  const dispatch = createEventDispatcher();
  
  function goToPage(newPage) {
    if (newPage === '...' || newPage === page) return;
    
    dispatch('pageChange', { page: newPage });
  }
  
  function prevPage() {
    if (page > 1) {
      dispatch('pageChange', { page: page - 1 });
    }
  }
  
  function nextPage() {
    if (page < total) {
      dispatch('pageChange', { page: page + 1 });
    }
  }
</script>

<div class="pagination-container" role="navigation" aria-label="Pagination">
  <div class="pagination-info" aria-live="polite">
    {showingText}
  </div>
  
  <div class="pagination-controls">
    <button 
      class="pagination-button prev" 
      on:click={prevPage} 
      disabled={page <= 1 || total === 0}
      aria-label="Previous page"
      aria-disabled={page <= 1 || total === 0}
    >
      ←
    </button>
    
    {#each pageNumbers as pageNum (pageNum)}
      {#if pageNum === '...'}
        <span class="pagination-ellipsis" aria-hidden="true">...</span>
      {:else}
        <button 
          class="pagination-button page-number" 
          class:active={pageNum === page}
          on:click={() => goToPage(pageNum)}
          aria-label="Page {pageNum}"
          aria-current={pageNum === page ? 'page' : undefined}
        >
          {pageNum}
        </button>
      {/if}
    {/each}
    
    <button 
      class="pagination-button next" 
      on:click={nextPage} 
      disabled={page >= total || total === 0}
      aria-label="Next page"
      aria-disabled={page >= total || total === 0}
    >
      →
    </button>
  </div>
</div>

<style>
  .pagination-container {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 1rem 0;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  
  .pagination-info {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  
  .pagination-controls {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }
  
  .pagination-button {
    min-width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-color);
    background-color: var(--bg-element);
    color: var(--text-primary);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .pagination-button:hover:not(:disabled) {
    background-color: var(--primary-color-light);
    border-color: var(--primary-color);
  }
  
  .pagination-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .pagination-button.active {
    background-color: var(--primary-color);
    color: white;
    border-color: var(--primary-color);
  }
  
  .pagination-ellipsis {
    min-width: 2.5rem;
    text-align: center;
    color: var(--text-muted);
  }
  
  @media (max-width: 768px) {
    .pagination-container {
      flex-direction: column;
      align-items: center;
    }
    
    .pagination-button {
      min-width: 2rem;
      height: 2rem;
    }
  }
</style>