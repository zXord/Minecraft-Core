<script>
  export let levelFilter = 'all';
  export let instanceFilter = 'all';
  export let categoryFilter = 'all';
  export let startDate = null;
  export let endDate = null;
  export let availableInstances = [];
  export let availableCategories = [];

  const logLevels = [
    { value: 'all', label: 'All Levels' },
    { value: 'debug', label: 'Debug' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warning' },
    { value: 'error', label: 'Error' },
    { value: 'fatal', label: 'Fatal' }
  ];

  let showLevelDropdown = false;
  let showInstanceDropdown = false;
  let showCategoryDropdown = false;

  function selectLevel(level) {
    levelFilter = level;
    showLevelDropdown = false;
  }

  function selectInstance(instance) {
    instanceFilter = instance;
    showInstanceDropdown = false;
  }

  function selectCategory(category) {
    categoryFilter = category;
    showCategoryDropdown = false;
  }

  function getCurrentLevelLabel() {
    const level = logLevels.find(l => l.value === levelFilter);
    return level ? level.label : 'All Levels';
  }

  function getCurrentInstanceLabel() {
    if (instanceFilter === 'all') return 'All Instances';
    return instanceFilter;
  }

  function getCurrentCategoryLabel() {
    if (categoryFilter === 'all') return 'All Categories';
    return categoryFilter;
  }

  // Close dropdowns when clicking outside
  function handleClickOutside(event) {
    if (!event.target.closest('.filter-dropdown')) {
      showLevelDropdown = false;
      showInstanceDropdown = false;
      showCategoryDropdown = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="filters-container">
  <!-- Filter Buttons -->
  <div class="filter-buttons">
    
    <!-- Level Filter -->
    <div class="filter-dropdown">
      <button 
        class="filter-button" 
        on:click={() => showLevelDropdown = !showLevelDropdown}
      >
        <span>{getCurrentLevelLabel()}</span>
        <svg class="dropdown-icon" class:rotated={showLevelDropdown} xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" fill="currentColor" viewBox="0 0 256 256">
          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path>
        </svg>
      </button>
      
      {#if showLevelDropdown}
        <div class="dropdown-menu">
          {#each logLevels as level}
            <button 
              class="dropdown-item" 
              class:active={levelFilter === level.value}
              on:click={() => selectLevel(level.value)}
            >
              {level.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Instance Filter -->
    <div class="filter-dropdown">
      <button 
        class="filter-button" 
        on:click={() => showInstanceDropdown = !showInstanceDropdown}
      >
        <span>{getCurrentInstanceLabel()}</span>
        <svg class="dropdown-icon" class:rotated={showInstanceDropdown} xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" fill="currentColor" viewBox="0 0 256 256">
          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path>
        </svg>
      </button>
      
      {#if showInstanceDropdown}
        <div class="dropdown-menu">
          <button 
            class="dropdown-item" 
            class:active={instanceFilter === 'all'}
            on:click={() => selectInstance('all')}
          >
            All Instances
          </button>
          {#each availableInstances as instance}
            <button 
              class="dropdown-item" 
              class:active={instanceFilter === instance}
              on:click={() => selectInstance(instance)}
            >
              {instance}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Category Filter -->
    <div class="filter-dropdown">
      <button 
        class="filter-button" 
        on:click={() => showCategoryDropdown = !showCategoryDropdown}
      >
        <span>{getCurrentCategoryLabel()}</span>
        <svg class="dropdown-icon" class:rotated={showCategoryDropdown} xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" fill="currentColor" viewBox="0 0 256 256">
          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path>
        </svg>
      </button>
      
      {#if showCategoryDropdown}
        <div class="dropdown-menu">
          <button 
            class="dropdown-item" 
            class:active={categoryFilter === 'all'}
            on:click={() => selectCategory('all')}
          >
            All Categories
          </button>
          {#each availableCategories as category}
            <button 
              class="dropdown-item" 
              class:active={categoryFilter === category}
              on:click={() => selectCategory(category)}
            >
              {category}
            </button>
          {/each}
        </div>
      {/if}
    </div>

  </div>

  <!-- Time Range Slider -->
  <div class="time-range-container">
    <div class="time-range-header">
      <p class="time-range-label">Time Range</p>
    </div>
    
    <div class="time-range-inputs">
      <div class="date-input-group">
        <label for="start-date">Start Date</label>
        <input 
          id="start-date"
          type="datetime-local" 
          bind:value={startDate}
          class="date-input"
        />
      </div>
      
      <div class="date-input-group">
        <label for="end-date">End Date</label>
        <input 
          id="end-date"
          type="datetime-local" 
          bind:value={endDate}
          class="date-input"
        />
      </div>
      
      <button 
        class="clear-dates-button"
        on:click={() => { startDate = null; endDate = null; }}
      >
        Clear
      </button>
    </div>
  </div>
</div>

<style>
  .filters-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 0.75rem 1rem;
  }

  .filter-buttons {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .filter-dropdown {
    position: relative;
  }

  .filter-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    height: 2rem;
    padding: 0 1rem 0 1rem;
    background: #223649;
    border: none;
    border-radius: 0.5rem;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
    white-space: nowrap;
  }

  .filter-button:hover {
    background: #314d68;
  }

  .dropdown-icon {
    transition: transform 0.2s;
  }

  .dropdown-icon.rotated {
    transform: rotate(180deg);
  }

  .dropdown-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1000;
    background: #223649;
    border: 1px solid #314d68;
    border-radius: 0.5rem;
    margin-top: 0.25rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    max-height: 200px;
    overflow-y: auto;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    color: white;
    text-align: left;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .dropdown-item:hover {
    background: #314d68;
  }

  .dropdown-item.active {
    background: #0c7ff2;
    color: white;
  }

  .dropdown-item:first-child {
    border-radius: 0.5rem 0.5rem 0 0;
  }

  .dropdown-item:last-child {
    border-radius: 0 0 0.5rem 0.5rem;
  }

  /* Time Range */
  .time-range-container {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .time-range-header {
    display: flex;
    align-items: center;
  }

  .time-range-label {
    color: white;
    font-size: 1rem;
    font-weight: 500;
    margin: 0;
  }

  .time-range-inputs {
    display: flex;
    gap: 1rem;
    align-items: end;
    flex-wrap: wrap;
  }

  .date-input-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .date-input-group label {
    color: #90adcb;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .date-input {
    background: #223649;
    border: 1px solid #314d68;
    border-radius: 0.375rem;
    color: white;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    outline: none;
    transition: border-color 0.2s;
  }

  .date-input:focus {
    border-color: #0c7ff2;
  }

  .date-input::-webkit-calendar-picker-indicator {
    filter: invert(1);
    cursor: pointer;
  }

  .clear-dates-button {
    height: 2.25rem;
    padding: 0 1rem;
    background: #ef4444;
    border: none;
    border-radius: 0.375rem;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .clear-dates-button:hover {
    background: #dc2626;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .filter-buttons {
      gap: 0.5rem;
    }
    
    .time-range-inputs {
      flex-direction: column;
      align-items: stretch;
    }
    
    .date-input-group {
      width: 100%;
    }
  }
</style> 