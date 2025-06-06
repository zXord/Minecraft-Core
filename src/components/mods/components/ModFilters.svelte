<script>
  import { createEventDispatcher } from 'svelte';
  import { 
    minecraftVersion,
    loaderType,
    searchKeyword
  } from '../../../stores/modStore.js';

  // Create event dispatcher
  const dispatch = createEventDispatcher();
  
  // Filter states
  export let sortBy = 'relevance';
  export let filterType = 'all';
  export let filterMinecraftVersion = $minecraftVersion || '';
  export let filterModLoader = $loaderType || 'fabric';
  
  // Local copies for the form
  let localSortBy = sortBy;
  let localFilterType = filterType;
  
  // Expose options
  export let minecraftVersionOptions = [];
  
  // Visual feedback for button click
  let isApplying = false;
  
  // Event handler for filter changes
  function handleFilterChange() {
    // Visual feedback
    isApplying = true;
    
    // Update our actual filter values
    sortBy = localSortBy;
    filterType = localFilterType;
    
    console.log('ModFilters: Applying filters', { sortBy, filterType });
    
    // Dispatch a custom event when filters change
    const detail = {
      sortBy,
      filterType,
      filterMinecraftVersion,
      filterModLoader
    };
    
    dispatch('filterChange', detail);
    
    // Reset visual feedback after a short delay
    setTimeout(() => {
      isApplying = false;
    }, 1000);
  }

  // Update local values when props change
  $: {
    localSortBy = sortBy;
    localFilterType = filterType;
  }
</script>

<div class="filters-container" role="group" aria-label="Filter options">
  <div class="filter-group">
    <label for="sort-by">Sort by:</label>
    <select id="sort-by" bind:value={localSortBy}>
      <option value="relevance">Relevance</option>
      <option value="downloads">Downloads</option>
      <option value="follows">Follows</option>
      <option value="newest">Newest</option>
      <option value="updated">Recently Updated</option>
    </select>
  </div>
  
  <div class="filter-group">
    <label for="filter-type">Environment:</label>
    <select id="filter-type" bind:value={localFilterType}>
      <option value="all">All Mods</option>
      <option value="client">Client-side</option>
      <option value="server">Server-side</option>
      <option value="both">Both</option>
    </select>
  </div>
  
  <div class="filter-group">
    <label for="filter-mc-version">Minecraft Version:</label>
    <div class="filter-with-button">
      <select
        id="filter-mc-version"
        bind:value={filterMinecraftVersion}
        class="disabled-select"
      >
        {#each minecraftVersionOptions as ver}
          <option value={ver}>{ver}</option>
        {/each}
      </select>
    </div>
  </div>
  
  <div class="filter-group">
    <label for="filter-loader">Mod Loader:</label>
    <select id="filter-loader" disabled class="disabled-select" bind:value={filterModLoader}>
      <option value={filterModLoader}>{filterModLoader}</option>
    </select>
  </div>
  
  <div class="filter-actions">
    <button 
      type="button" 
      class="apply-button" 
      class:applying={isApplying} 
      on:click={handleFilterChange}
      disabled={isApplying}
    >
      {isApplying ? 'Applying...' : 'Apply Filters'}
    </button>
  </div>
</div>

<style>
  .filters-container {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 1rem;
    padding: 0.75rem 1rem;
    background-color: rgba(30, 30, 30, 0.95);
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    justify-content: center;
  }
  
  .filter-group {
    display: flex;
    flex-direction: column;
    min-width: 180px;
    margin: 0 8px;
  }
  
  .filter-with-button {
    display: flex;
    gap: 4px;
    width: 100%;
  }
  
  .filter-actions {
    display: flex;
    align-items: flex-end;
  }
  
  label {
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    color: rgba(255, 255, 255, 0.9);
    font-weight: 500;
  }
  
  select {
    padding: 0.5rem;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background-color: rgba(0, 0, 0, 0.3);
    color: white;
    width: 100%;
  }
  
  select:focus {
    outline: none;
    border-color: #646cff;
  }
  
  .disabled-select {
    opacity: 0.8;
    cursor: not-allowed;
    background-color: rgba(30, 30, 30, 0.5);
    border-color: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.7);
    padding-right: 10px;
  }
  
  .apply-button {
    background-color: #646cff;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .apply-button:hover:not(:disabled) {
    background-color: #7a81ff;
  }
  
  .applying {
    background-color: #4CAF50 !important;
    opacity: 1;
    transform: scale(1.05);
  }
  
  @media (max-width: 768px) {
    .filter-group {
      min-width: 100%;
    }
    
    .filter-actions {
      width: 100%;
      margin-top: 0.5rem;
    }
    
    .apply-button {
      width: 100%;
    }
  }
</style> 