<script>
  import { createEventDispatcher } from 'svelte';
  import { modrinthMatchingModals, modrinthMatchingActions } from '../../../stores/modrinthMatchingStore.js';

  const dispatch = createEventDispatcher();

  let searchQuery = '';
  let searchResults = [];
  let isSearching = false;
  let selectedMod = null;
  let selectedVersion = '';
  let availableVersions = [];
  let isLoadingVersions = false;
  let searchTimeout = null;

  $: modal = $modrinthMatchingModals.manualMatchingModal;
  $: modData = modal.mod;
  $: fileName = typeof modData === 'string' ? modData : (modData?.fileName || '');

  // Auto-search when modal opens
  $: if (modal.visible && modData && !searchQuery) {
    const baseName = typeof modData === 'string' ? modData : fileName;
    searchQuery = (typeof modData === 'object' && modData.pendingData?.searchedName) || 
                  baseName.replace(/\.jar$/i, '');
    performSearch();
  }

  async function performSearch() {
    if (!searchQuery.trim()) return;

    isSearching = true;
    try {
      searchResults = await modrinthMatchingActions.searchModrinthManual(searchQuery.trim(), 'fabric', 20);
    } catch (error) {
      // TODO: Add proper logging - Search error
      searchResults = [];
    } finally {
      isSearching = false;
    }
  }

  function handleSearchInput() {
    // Debounce search
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(performSearch, 500);
  }

  function selectMod(mod) {
    selectedMod = mod;
    selectedVersion = '';
    loadVersionsForMod(mod);
  }

  async function loadVersionsForMod(mod) {
    if (!mod) return;
    
    isLoadingVersions = true;
    try {
      const result = await modrinthMatchingActions.getProjectDetails(mod.project_id);
      if (result && result.versions) {
        availableVersions = result.versions.slice(0, 10); // Get first 10 versions
      } else {
        availableVersions = [];
      }
    } catch (error) {
      // TODO: Add proper logging - Error loading versions
      availableVersions = [];
    } finally {
      isLoadingVersions = false;
    }
  }

  async function confirmSelection() {
    if (!selectedMod || !fileName || !selectedVersion) {
      return;
    }

    try {
      // Include selected version in the match data
      let matchWithVersion = { ...selectedMod };
      if (selectedVersion && availableVersions.length > 0) {
        const versionInfo = availableVersions.find(v => 
          (v.version_number === selectedVersion) || 
          (v.versionNumber === selectedVersion) ||
          (v.name === selectedVersion) ||
          (v.id === selectedVersion)
        );
        if (versionInfo) {
          matchWithVersion.selectedVersion = versionInfo;
        }
      }

      const success = await modrinthMatchingActions.confirmMatch(
        fileName,
        selectedMod.project_id,
        matchWithVersion
      );

      if (success) {
        // Dispatch event to parent component
        dispatch('matchConfirmed', {
          fileName,
          match: matchWithVersion
        });
        
        // Close modal
        closeModal();
      }
    } catch (error) {
      // TODO: Add proper logging - Error confirming manual selection
    }
  }

  function closeModal() {
    modrinthMatchingActions.hideManualMatchingModal();
    searchQuery = '';
    searchResults = [];
    selectedMod = null;
    selectedVersion = '';
    availableVersions = [];
    isLoadingVersions = false;
  }

  function handleModalKeyDown(event) {
    if (event.key === 'Escape') {
      closeModal();
    }
  }

  function handleModResultKeyDown(event, mod) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectMod(mod);
    }
  }

  function formatDownloads(count) {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    } else if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
  }
</script>

{#if modal.visible}
  <div 
    class="modal-overlay" 
    role="dialog" 
    aria-modal="true" 
    aria-labelledby="modal-title"
    on:keydown={handleModalKeyDown}
    tabindex="-1"
  >
    <div 
      class="modal-content" 
      role="document"
    >
      <div class="modal-header">
        <h3 id="modal-title">Find Modrinth Match for: <span class="mod-name">{fileName}</span></h3>
        <button class="close-btn" on:click={() => {
          closeModal();
        }}>×</button>
      </div>

      <div class="modal-body">
        <div class="search-section">
          <div class="search-input-container">
            <input
              type="text"
              bind:value={searchQuery}
              on:input={handleSearchInput}
              placeholder="Search Modrinth for mods..."
              class="search-input"
            />
            <button 
              class="search-btn" 
              on:click={performSearch}
              disabled={isSearching}
            >
              {isSearching ? '🔄' : '🔍'}
            </button>
          </div>
        </div>

        <div class="results-section">
          {#if isSearching}
            <div class="loading">Searching Modrinth...</div>
          {:else if searchResults.length > 0}
            <div class="results-list">
              {#each searchResults as mod (mod.project_id)}
                <div 
                  class="mod-result"
                  class:selected={selectedMod?.project_id === mod.project_id}
                  role="button"
                  tabindex="0"
                  aria-label="Select {mod.title} by {mod.author}"
                  on:click={() => selectMod(mod)}
                  on:keydown={(e) => handleModResultKeyDown(e, mod)}
                >
                  <div class="mod-icon">
                    {#if mod.icon_url}
                      <img src={mod.icon_url} alt="{mod.title} icon" />
                    {:else}
                      <div class="default-icon">📦</div>
                    {/if}
                  </div>
                  
                  <div class="mod-info">
                    <div class="mod-title">{mod.title}</div>
                    <div class="mod-description">{mod.description}</div>
                    <div class="mod-meta">
                      <span class="mod-author">by {mod.author}</span>
                      <span class="mod-downloads">{formatDownloads(mod.downloads)} downloads</span>
                      {#if mod.categories && mod.categories.length > 0}
                        <span class="mod-categories">
                          {mod.categories.slice(0, 2).join(', ')}
                        </span>
                      {/if}
                    </div>
                  </div>

                  <div class="selection-indicator">
                    {#if selectedMod?.project_id === mod.project_id}
                      ✓
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {:else if searchQuery}
            <div class="no-results">No mods found for "{searchQuery}"</div>
          {:else}
            <div class="no-search">Enter a search term to find mods</div>
          {/if}
        </div>
      </div>

      <!-- Version selection section -->
      {#if selectedMod}
        <div class="version-selection-section">
          <h4>Select Version for {selectedMod.title}</h4>
          <div class="version-selection">
            {#if isLoadingVersions}
              <div class="loading-versions">Loading versions...</div>
            {:else if availableVersions.length === 0}
              <div class="no-versions">No versions available</div>
            {:else}
              <label for="version-select">Choose version:</label>
              <select id="version-select" bind:value={selectedVersion}>
                <option value="">-- Select version --</option>
                {#each availableVersions as version (version.id)}
                  <option value={version.versionNumber || version.version_number || version.name || version.id}>
                    {version.versionNumber || version.version_number || version.name || version.id || 'Unknown Version'}
                    {#if version.isStable !== false}
                      ✅
                    {:else}
                      🔶
                    {/if}
                    ({version.datePublished?.split('T')[0] || version.date_published?.split('T')[0] || 'No date'})
                  </option>
                {/each}
              </select>

            {/if}
          </div>
        </div>
      {/if}

      <div class="modal-footer">
        <div class="footer-actions">
          <button class="cancel-btn" on:click={closeModal}>
            Cancel
          </button>
          
          <button 
            class="skip-btn" 
            on:click={() => {
              modrinthMatchingActions.rejectMatch(fileName, 'User skipped manual matching');
              closeModal();
            }}
          >
            Skip Matching
          </button>
          
          <button 
            class="confirm-btn" 
            disabled={!selectedMod || !selectedVersion}
            on:click={confirmSelection}
          >
            Confirm Selection
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: #2a2a2a;
    border-radius: 8px;
    width: 90%;
    max-width: 700px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #444;
  }

  .modal-header h3 {
    margin: 0;
    color: #fff;
    font-size: 16px;
  }

  .mod-name {
    color: #64b5f6;
    font-weight: normal;
  }

  .close-btn {
    background: none;
    border: none;
    color: #ccc;
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-btn:hover {
    color: #fff;
    background: #444;
    border-radius: 50%;
  }

  .modal-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 20px;
  }

  .search-section {
    margin-bottom: 16px;
  }

  .search-input-container {
    display: flex;
    gap: 8px;
  }

  .search-input {
    flex: 1;
    padding: 10px 12px;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 6px;
    color: #fff;
    font-size: 14px;
  }

  .search-input:focus {
    outline: none;
    border-color: #64b5f6;
  }

  .search-btn {
    padding: 10px 16px;
    background: #64b5f6;
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    font-size: 14px;
  }

  .search-btn:hover:not(:disabled) {
    background: #42a5f5;
  }

  .search-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .results-section {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .loading, .no-results, .no-search {
    text-align: center;
    color: #ccc;
    padding: 40px 20px;
    font-style: italic;
  }

  .results-list {
    flex: 1;
    overflow-y: auto;
    padding-right: 8px;
  }

  .mod-result {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border: 1px solid #444;
    border-radius: 6px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .mod-result:hover {
    border-color: #64b5f6;
    background: #333;
  }

  .mod-result.selected {
    border-color: #4caf50;
    background: #1b4332;
  }

  .mod-icon {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #444;
  }

  .mod-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .default-icon {
    font-size: 20px;
  }

  .mod-info {
    flex: 1;
    min-width: 0;
  }

  .mod-title {
    font-weight: bold;
    color: #fff;
    margin-bottom: 4px;
  }

  .mod-description {
    color: #ccc;
    font-size: 13px;
    margin-bottom: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mod-meta {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: #aaa;
  }

  .mod-author {
    color: #64b5f6;
  }

  .mod-downloads {
    color: #4caf50;
  }

  .mod-categories {
    color: #ff9800;
  }

  .selection-indicator {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #4caf50;
    font-size: 18px;
    font-weight: bold;
  }

  .modal-footer {
    border-top: 1px solid #444;
    padding: 16px 20px;
  }

  .footer-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
  }

  .footer-actions button {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .cancel-btn {
    background: #757575;
    color: white;
  }

  .cancel-btn:hover {
    background: #616161;
  }

  .skip-btn {
    background: #ff9800;
    color: white;
  }

  .skip-btn:hover {
    background: #f57c00;
  }

  .confirm-btn {
    background: #4caf50;
    color: white;
  }

  .confirm-btn:hover:not(:disabled) {
    background: #45a049;
  }

  .confirm-btn:disabled {
    background: #444;
    color: #666;
    cursor: not-allowed;
  }

  /* Version selection section */
  .version-selection-section {
    border-top: 1px solid #333;
    padding-top: 16px;
    margin-top: 16px;
  }

  .version-selection-section h4 {
    margin: 0 0 12px 0;
    font-size: 1rem;
    color: #e0e0e0;
  }

  .version-selection {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .version-selection label {
    font-size: 0.9rem;
    color: #ccc;
  }

  .version-selection select {
    padding: 8px 12px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #2a2a2a;
    color: #e0e0e0;
    font-size: 0.9rem;
  }

  .version-selection select:focus {
    outline: none;
    border-color: #4caf50;
  }

  .loading-versions, .no-versions {
    padding: 8px 12px;
    text-align: center;
    color: #888;
    font-style: italic;
  }

  /* Scrollbar styling */
  .results-list::-webkit-scrollbar {
    width: 8px;
  }

  .results-list::-webkit-scrollbar-track {
    background: #1a1a1a;
    border-radius: 4px;
  }

  .results-list::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 4px;
  }

  .results-list::-webkit-scrollbar-thumb:hover {
    background: #666;
  }
</style>
