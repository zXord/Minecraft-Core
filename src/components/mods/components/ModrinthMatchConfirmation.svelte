<script>
  import { createEventDispatcher } from 'svelte';
  import { 
    pendingModrinthConfirmations, 
    modrinthSearchStates,
    confirmedModrinthMatches
  } from '../../../stores/modrinthMatchingStore.js';

  export let fileName;

  const dispatch = createEventDispatcher();
  
  let selectedVersion = '';

  // Reactive statements
  $: pendingConfirmation = $pendingModrinthConfirmations.get(fileName);
  $: searchState = $modrinthSearchStates.get(fileName);
  $: confirmedMatch = $confirmedModrinthMatches.get(fileName);
  $: hasConfirmedMatch = !!confirmedMatch;
  
  // Auto-select matching version if available
  $: if (pendingConfirmation?.matches?.[0]?.hasMatchingVersion && !selectedVersion) {
    const installedVersion = pendingConfirmation.metadata?.version || pendingConfirmation.metadata?.versionNumber;
    if (installedVersion) {
      const availableVersions = pendingConfirmation.matches[0].availableVersions;
      const matchingVersion = findMatchingVersion(installedVersion, availableVersions);
      if (matchingVersion) {
        selectedVersion = matchingVersion.versionNumber || matchingVersion.version_number;
      }
    }
  }

  // Helper function to find matching version with normalization
  function findMatchingVersion(searchVersion, availableVersions) {
    if (!searchVersion || !availableVersions) return null;
    
    const normalizeVersion = (version) => {
      return version
        .toLowerCase()
        .replace(/[-_+](fabric|forge|quilt|neoforge).*$/i, '')
        .replace(/^v/i, '')
        .trim();
    };
    
    const normalizedSearch = normalizeVersion(searchVersion);
    
    return availableVersions.find(v => {
      const versionStr = v.versionNumber || v.version_number || v.name || '';
      const normalizedAvailable = normalizeVersion(versionStr);
      
      // Exact match after normalization
      if (normalizedSearch === normalizedAvailable) {
        return true;
      }
      
      // Check if search version is contained in available version
      if (normalizedAvailable.startsWith(normalizedSearch + '-') || 
          normalizedAvailable.startsWith(normalizedSearch + '+') || 
          normalizedAvailable.startsWith(normalizedSearch + '_')) {
        return true;
      }
      
      // Check if available version is contained in search version
      if (normalizedSearch.startsWith(normalizedAvailable + '-') || 
          normalizedSearch.startsWith(normalizedAvailable + '+') || 
          normalizedSearch.startsWith(normalizedAvailable + '_')) {
        return true;
      }
      
      return false;
    });
  }

  function handleConfirmMatch() {
    if (pendingConfirmation) {
      const match = pendingConfirmation.matches[0];
      
      // If version is selected and available, include version info in the match
      let matchWithVersion = { ...match };
      if (selectedVersion && match.availableVersions) {
        const versionInfo = match.availableVersions.find(v => 
          (v.version_number === selectedVersion) || 
          (v.versionNumber === selectedVersion) ||
          (v.name === selectedVersion) ||
          (v.id === selectedVersion)
        );
        if (versionInfo) {
          matchWithVersion.selectedVersion = versionInfo;
        }
      }
      
      dispatch('matchConfirmed', {
        fileName,
        match: matchWithVersion
      });
    }
  }

  function handleRejectMatch() {
    dispatch('matchRejected', { fileName });
  }

  function triggerAutoSearch() {
    dispatch('triggerAutoSearch', { fileName });
  }

  function triggerManualSearch() {
    dispatch('triggerManualSearch', { fileName });
  }
</script>

<!-- Auto and Manual matching buttons (only show if no confirmed match) -->
{#if !hasConfirmedMatch}
  <div class="modrinth-matching-controls">
    {#if searchState?.state === 'checking'}
      <div class="search-status checking">
        <span class="spinner">⏳</span>
        <span>Searching...</span>
      </div>
    {:else if searchState?.state === 'no-matches'}
      <div class="search-status no-matches">
        <span>❌ No matches</span>
        <button class="manual-search-btn" on:click={triggerManualSearch} title="Search manually">
          🔍 Manual
        </button>
      </div>
    {:else if searchState?.state === 'failed'}
      <div class="search-status failed">
        <span>⚠️ Search failed</span>
        <button class="retry-btn" on:click={triggerAutoSearch} title="Retry search">
          🔄 Retry
        </button>
      </div>
    {:else}
      <div class="matching-buttons">
        <button class="auto-match-btn" on:click={triggerAutoSearch} title="Automatically search for Modrinth matches">
          🔍 Auto
        </button>
        <button class="manual-match-btn" on:click={triggerManualSearch} title="Manually search for Modrinth matches">
          📋 Manual
        </button>
      </div>
    {/if}
  </div>
{/if}

<!-- Confirmation UI for pending matches -->
{#if pendingConfirmation && !hasConfirmedMatch}
  <div class="match-confirmation">
    <div class="match-info">
      <strong>{pendingConfirmation.matches[0].title}</strong>
      <small>by {pendingConfirmation.matches[0].author}</small>
      
      <!-- Version selection if available versions -->
      {#if pendingConfirmation.matches[0].availableVersions && pendingConfirmation.matches[0].availableVersions.length > 0}
        <div class="version-selection">
          <label for="version-select-{fileName}">Select version:</label>
          <select id="version-select-{fileName}" bind:value={selectedVersion}>
            <option value="">-- Select version --</option>
            {#each pendingConfirmation.matches[0].availableVersions.slice(0, 10) as version (version.id)}
              <option value={version.versionNumber || version.version_number || version.name || version.id}>
                {version.versionNumber || version.version_number || version.name || version.id || 'Unknown Version'}
                {#if findMatchingVersion(pendingConfirmation.metadata?.version || pendingConfirmation.metadata?.versionNumber, [version])}
                  🎯
                {:else if version.isStable !== false}
                  ✅
                {:else}
                  🔶
                {/if}
                ({version.datePublished?.split('T')[0] || version.date_published?.split('T')[0] || 'No date'})
              </option>
            {/each}
          </select>
          
          {#if pendingConfirmation.matches[0].hasMatchingVersion}
            <small class="version-match">✅ Your version ({pendingConfirmation.metadata?.version || pendingConfirmation.metadata?.versionNumber || 'unknown'}) is available</small>
          {:else}
            <small class="version-mismatch">⚠️ Your version ({pendingConfirmation.metadata?.version || pendingConfirmation.metadata?.versionNumber || 'unknown'}) not found - select closest match</small>
          {/if}
        </div>
      {/if}
    </div>
    <div class="confirmation-buttons">
      <button 
        class="confirm-btn" 
        class:disabled={!selectedVersion}
        disabled={!selectedVersion}
        on:click={handleConfirmMatch} 
        title={selectedVersion ? "Confirm this match" : "Please select a version first"}
      >
        ✅ Confirm
      </button>
      <button class="reject-btn" on:click={handleRejectMatch} title="Reject this match">
        ❌ Reject
      </button>
    </div>
  </div>
{/if}

<style>
  .modrinth-matching-controls {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .matching-buttons {
    display: flex;
    gap: 4px;
  }

  .auto-match-btn,
  .manual-match-btn,
  .manual-search-btn,
  .retry-btn {
    padding: 2px 6px;
    font-size: 0.7rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.1);
    color: #ccc;
    cursor: pointer;
    transition: all 0.2s;
  }

  .auto-match-btn:hover,
  .manual-match-btn:hover,
  .manual-search-btn:hover,
  .retry-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.4);
  }

  .search-status {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.7rem;
    padding: 2px 4px;
  }

  .search-status.checking {
    color: #60a5fa;
  }

  .search-status.no-matches {
    color: #f87171;
  }

  .search-status.failed {
    color: #fbbf24;
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .match-confirmation {
    margin-top: 4px;
    padding: 6px;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 4px;
  }

  .match-info {
    margin-bottom: 4px;
  }

  .match-info strong {
    display: block;
    font-size: 0.8rem;
    color: #22c55e;
  }

  .match-info small {
    font-size: 0.7rem;
    color: #94a3b8;
  }

  .version-selection {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .version-selection label {
    display: block;
    font-size: 0.7rem;
    color: #94a3b8;
    margin-bottom: 4px;
  }

  .version-selection select {
    width: 100%;
    padding: 4px 6px;
    font-size: 0.7rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    color: #ccc;
    margin-bottom: 4px;
  }

  .version-selection select:focus {
    outline: none;
    border-color: rgba(34, 197, 94, 0.5);
    background: rgba(255, 255, 255, 0.15);
  }

  .version-match,
  .version-mismatch {
    display: block;
    font-size: 0.65rem;
    margin-top: 2px;
  }

  .version-match {
    color: #22c55e;
  }

  .version-mismatch {
    color: #fbbf24;
  }

  .confirmation-buttons {
    display: flex;
    gap: 4px;
  }

  .confirm-btn,
  .reject-btn {
    padding: 2px 6px;
    font-size: 0.7rem;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .confirm-btn {
    background: #22c55e;
    color: white;
  }

  .confirm-btn:hover {
    background: #16a34a;
  }

  .confirm-btn.disabled,
  .confirm-btn:disabled {
    background: #6b7280;
    cursor: not-allowed;
    opacity: 0.6;
  }

  .confirm-btn.disabled:hover,
  .confirm-btn:disabled:hover {
    background: #6b7280;
  }

  .reject-btn {
    background: #ef4444;
    color: white;
  }

  .reject-btn:hover {
    background: #dc2626;
  }
</style>
