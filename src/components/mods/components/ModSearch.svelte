<!-- @ts-ignore -->
<script>
  import { createEventDispatcher } from "svelte";
  import { onMount } from "svelte";
  import {
    searchKeyword,
    modSource,
    searchResults,
    isSearching,
    searchError,
    currentPage,
    totalPages,
    totalResults,
    expandedModId,
    minecraftVersion,
    loaderType,
    filterMinecraftVersion,
    filterModLoader,
    installedModInfo,
    isCheckingUpdates,
    successMessage,
    // Content type stores
    activeContentType,
    shaderResults,
    resourcePackResults,
    CONTENT_TYPES,
    installedShaderInfo,
    installedResourcePackInfo,
    contentTypeCache,
  } from "../../../stores/modStore.js";
  import {
    searchContent,
    fetchModVersions,
    checkForUpdates,
  } from "../../../utils/mods/modAPI.js";
  import ModCard from "./ModCard.svelte";
  import ModFilters from "./ModFilters.svelte";
  // Props
  export const serverPath = "";

  /** @type {Set<string> | undefined} */
  export let serverManagedSet = undefined;
  // Local state
  let versionsCache = {};
  let versionsLoading = {};
  let versionsError = {};
  let displayTotalPages = 1; // For UI pagination display
  let visibleMods = []; // Mods to display on current page
  let hasLoadedOnce = false;
  let pageDebounceTimer = null;
  const PAGE_DEBOUNCE_MS = 100;
  // Content-type specific filter states
  let modsSortBy = "relevance";
  let modsFilterType = "all";
  let shadersSortBy = "relevance";
  let shadersFilterType = "all";
  let resourcePacksSortBy = "relevance";
  let resourcePacksFilterType = "all";
  
  // Current filter states based on active content type
  $: sortBy = $activeContentType === CONTENT_TYPES.SHADERS ? shadersSortBy 
    : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? resourcePacksSortBy 
    : modsSortBy;
  
  $: filterType = $activeContentType === CONTENT_TYPES.SHADERS ? shadersFilterType 
    : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? resourcePacksFilterType 
    : modsFilterType;
  
  let sortAppliedMessage = "";
  let sortMessageTimer = null;

  // Event dispatcher
  const dispatch = createEventDispatcher();

  // Set the current Minecraft version as filter on component load and check for updates
  onMount(async () => {
    // Always default to current version on mount
    filterMinecraftVersion.set($minecraftVersion);

    // Run an initial search with current filters when component mounts
    const initialSearchOptions = {
      sortBy,
      environmentType: filterType,
      filterMinecraftVersion: $filterMinecraftVersion,
      filterModLoader: $loaderType,
    };

    // Only automatically search when component mounts if we have content in the search field
    if ($searchKeyword) {
      await handleSearch(null, initialSearchOptions);
    }

    if (!$isCheckingUpdates) {
      await checkForUpdates(serverPath);
    }
  });

  // After each successful search, set hasLoadedOnce to true
  $: if (visibleMods.length > 0 && !hasLoadedOnce) {
    hasLoadedOnce = true;
  }

  // When search results change, check for updates for mods in the search results
  $: if (visibleMods.length > 0 && !$isCheckingUpdates) {
    checkUpdatesForDisplayedMods();
  }

  // Function to check updates for mods in the current search results
  async function checkUpdatesForDisplayedMods() {
    try {
      // Get installed mod IDs
      const installedMods = $installedModInfo.filter((info) => info.projectId);

      // For each installed mod that appears in search results, load its versions
      for (const mod of visibleMods) {
        if (installedMods.some((info) => info.projectId === mod.id)) {
          // Load mod versions if not already cached
          if (!versionsCache[mod.id]) {
            await loadVersions({ detail: { modId: mod.id, loadAll: true } });
          }
        }
      }
    } catch (error) {}
  }

  // Handle content type changes
  $: if ($activeContentType) {
    // When switching content types, set to current version if filter is null/undefined (but not empty string)
    if ($filterMinecraftVersion === null || $filterMinecraftVersion === undefined) {
      filterMinecraftVersion.set($minecraftVersion);
    }
  }

  // Load mods or search results
  async function loadMods() {
    await searchContent($activeContentType, { sortBy });
  }

  // Post-process search results to ensure they have compatible versions
  $: if (visibleMods.length > 0 && $filterMinecraftVersion) {
    // We don't need to auto-load versions anymore
    // This will be done on-demand when a user expands a mod card
  } // Update display total pages based on API response
  $: displayTotalPages = $totalPages || 1;

  // Calculate visible mods based on active content type
  $: {
    switch ($activeContentType) {
      case CONTENT_TYPES.SHADERS:
        visibleMods = $shaderResults;
        break;
      case CONTENT_TYPES.RESOURCE_PACKS:
        visibleMods = $resourcePackResults;
        break;
      case CONTENT_TYPES.MODS:
      default:
        visibleMods = $searchResults;
        break;
    }
  }

  // Handle search submission
  async function handleSearch(event, filterOptions) {
    if (event) event.preventDefault();

    // Get search options
    const searchOptions = {
      sortBy: filterOptions?.sortBy || sortBy,
      environmentType: filterOptions?.filterType || filterType, // Include the environment filter type
    };

    await searchContent($activeContentType, searchOptions);
  }

  function showSortMessage(sortOption) {
    // Clear any existing timer
    if (sortMessageTimer) {
      clearTimeout(sortMessageTimer);
    }

    // Set the message based on the sort option
    let message;
    switch (sortOption) {
      case "relevance":
        message = "Sorting by Relevance (best match for your search)";
        break;
      case "downloads":
        message = "Sorting by Most Downloads (showing most popular mods first)";
        break;
      case "follows":
        message = "Sorting by Most Follows (showing most followed mods first)";
        break;
      case "newest":
        message = "Sorting by Newest Mods (recently created projects first)";
        break;
      case "updated":
        message = "Sorting by Recently Updated (latest updates first)";
        break;
      default:
        message = "Applied Filters";
    }

    sortAppliedMessage = message;

    // Auto-hide after 3 seconds
    sortMessageTimer = setTimeout(() => {
      sortAppliedMessage = "";
    }, 3000);
  }

  // Handle filter change
  async function handleFilterChange(event) {
    // Reset expanded mod when filter changes
    expandedModId.set(null);
    currentPage.set(1);

    // Update the filter version from the event for all content types
    if (event && event.detail && event.detail.filterMinecraftVersion !== undefined) {
      filterMinecraftVersion.set(event.detail.filterMinecraftVersion);
    }

    // Get filter values
    if (event && event.detail) {
      // Update content-type-specific filter variables
      if ($activeContentType === CONTENT_TYPES.SHADERS) {
        shadersFilterType = event.detail.filterType;
        shadersSortBy = event.detail.sortBy;
      } else if ($activeContentType === CONTENT_TYPES.RESOURCE_PACKS) {
        resourcePacksFilterType = event.detail.filterType;
        resourcePacksSortBy = event.detail.sortBy;
      } else {
        modsFilterType = event.detail.filterType;
        modsSortBy = event.detail.sortBy;
      }

      // Show feedback message
      showSortMessage(event.detail.sortBy);

      // Dispatch event to notify parent
      dispatch("filterChange", event.detail);

      // Clear the cache to force a fresh search
      contentTypeCache.set(new Map());

      // Wait for store updates to propagate
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Always make a new API call when filter changes to get fresh results
      await handleSearch(null, event.detail);
    }
  }

  // Switch mod source
  function switchSource(source) {
    // Only allow switching to modrinth for now
    if (source !== "modrinth") {
      // Show a message to the user
      successMessage.set(
        "CurseForge support is coming soon. Using Modrinth for now.",
      );
      return;
    }

    modSource.set(source);
    loadMods();
  }

  // Go to page - always use API calls for pagination since filtering is done server-side
  async function goToPage(page) {
    if (!hasLoadedOnce || $isSearching || page < 1 || page > displayTotalPages)
      return;
    if (page === $currentPage) return;

    // Update the current page state
    currentPage.set(page);

    // Clear any existing debounce timer
    if (pageDebounceTimer) clearTimeout(pageDebounceTimer);

    // Make a new API call with the updated page immediately
    pageDebounceTimer = setTimeout(async () => {
      try {
        // Include both the current sort option and environment filter
        await handleSearch(null, {
          sortBy,
          environmentType: filterType,
        });
        window.scrollTo(0, 0);
      } catch (error) {
        // TODO: Add proper logging - Error during page change search
      }
    }, PAGE_DEBOUNCE_MS);
  }

  // Handle previous page
  function prevPage() {
    if ($currentPage > 1 && !$isSearching) {
      goToPage($currentPage - 1);
    }
  }

  // Handle next page
  function nextPage() {
    if ($currentPage < displayTotalPages && !$isSearching) {
      goToPage($currentPage + 1);
    }
  }

  // Calculate if we're at the beginning or end for pagination UI
  $: isFirstPage = $currentPage === 1;
  $: isLastPage = $currentPage === displayTotalPages || displayTotalPages <= 1;

  // Load versions for a mod
  async function loadVersions(event) {
    const { modId, loadLatestOnly = false, loadAll = false } = event.detail;

    // If we already have versions cached and we're not forcing a reload with loadAll
    if (versionsCache[modId] && !loadAll) {
      // If we already have versions and not requesting a full reload, just return
      if (versionsCache[modId].length > 0) {
        return;
      }
    }

    versionsLoading = { ...versionsLoading, [modId]: true };
    versionsError = { ...versionsError, [modId]: null };

    try {
      const versions = await fetchModVersions(
        modId,
        $modSource,
        loadLatestOnly,
        false,
        $activeContentType,
      );
      versionsCache = { ...versionsCache, [modId]: versions };
    } catch (error) {
      versionsError = {
        ...versionsError,
        [modId]: error.message || "Failed to load versions",
      };
    } finally {
      versionsLoading = { ...versionsLoading, [modId]: false };
    }
  }
  // Handle version selection
  function handleVersionSelect() {
    // Version selection handled by parent component
  }
  // Handle install
  function handleInstall(event) {
    const { mod, versionId } = event.detail;
    dispatch("install", { mod, versionId });
  }
</script>

<div class="mod-search">
  <div class="search-header">
    <form
      class="search-form"
      on:submit={(e) => {
        // Include current filter settings when submitting the form directly
        const currentFilters = {
          sortBy,
          environmentType: filterType,
          filterMinecraftVersion: $filterMinecraftVersion,
          filterModLoader: $filterModLoader,
        };
        handleSearch(e, currentFilters);
      }}
      role="search"
      aria-label="Search for mods"
    >
      <div
        class="source-toggle"
        role="radiogroup"
        aria-label="Select mod source"
      >
        <button
          type="button"
          class="source-button"
          class:active={$modSource === "modrinth"}
          on:click={() => switchSource("modrinth")}
          aria-checked={$modSource === "modrinth"}
          role="radio"
        >
          Modrinth
        </button>
        <button
          type="button"
          class="source-button coming-soon"
          disabled={true}
          title="Coming soon"
          aria-checked="false"
          role="radio"
        >
          CurseForge (Coming Soon)
        </button>
      </div>

      <div class="search-input-container">
        <input
          type="text"
          bind:value={$searchKeyword}
          placeholder="Search for {$activeContentType === CONTENT_TYPES.SHADERS
            ? 'shaders'
            : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
              ? 'resource packs'
              : 'mods'}..."
          class="search-input"
          aria-label="Search for {$activeContentType === CONTENT_TYPES.SHADERS
            ? 'shaders'
            : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
              ? 'resource packs'
              : 'mods'}"
        />
        <button type="submit" class="search-button" disabled={$isSearching}>
          {$isSearching ? "Searching..." : "Search"}
        </button>
      </div>
    </form>

    <!-- Use the ModFilters component instead of inline filters -->
    <ModFilters
      {sortBy}
      {filterType}
      filterMinecraftVersion={$filterMinecraftVersion}
      filterModLoader={$filterModLoader}
      activeContentType={$activeContentType}
      on:filterChange={handleFilterChange}
    />

    <!-- Show sort applied message -->
    {#if sortAppliedMessage}
      <div class="sort-message">
        {sortAppliedMessage}
      </div>
    {/if}

    <!-- Top pagination -->
    {#if visibleMods.length > 0}
      <div class="pagination top-pagination">
        <button
          class="pagination-button"
          on:click={() => goToPage(1)}
          disabled={isFirstPage || $isSearching || !hasLoadedOnce}
          title="First page"
        >
          «
        </button>
        <button
          class="pagination-button"
          on:click={prevPage}
          disabled={isFirstPage || $isSearching || !hasLoadedOnce}
          title="Previous page"
        >
          ‹
        </button>
        <span class="pagination-info">
          Page {$currentPage} of {displayTotalPages || 1}
          {#if $totalResults > 0}
            <span class="total-results"
              >({$totalResults}
              {$activeContentType === CONTENT_TYPES.SHADERS
                ? "shaders"
                : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
                  ? "resource packs"
                  : "mods"}{filterType !== "all"
                ? " matching filter"
                : ""})</span
            >
          {/if}
        </span>
        <button
          class="pagination-button"
          on:click={nextPage}
          disabled={isLastPage || $isSearching || !hasLoadedOnce}
          title="Next page"
        >
          ›
        </button>
        <button
          class="pagination-button"
          on:click={() => goToPage(displayTotalPages)}
          disabled={isLastPage || $isSearching || !hasLoadedOnce}
          title="Last page"
        >
          »
        </button>
      </div>
    {/if}
  </div>

  <div class="search-results">
    {#if visibleMods.length > 0}
      <div class="mods-grid">
        {#each visibleMods as mod (mod.id)}
          {@const installedInfo = (() => {
            let infoStore;
            switch ($activeContentType) {
              case CONTENT_TYPES.SHADERS:
                infoStore = $installedShaderInfo;
                break;
              case CONTENT_TYPES.RESOURCE_PACKS:
                infoStore = $installedResourcePackInfo;
                break;
              case CONTENT_TYPES.MODS:
              default:
                infoStore = $installedModInfo;
                break;
            }
            // Prefer projectId match; fallback to filename/name normalization for assets
            const byId = infoStore.find((info) => info.projectId === mod.id);
            if (byId) return byId;
            if ($activeContentType !== CONTENT_TYPES.MODS) {
              const normalize = (str) => (str || '')
                .toString()
                .toLowerCase()
                .replace(/\.(zip|jar)$/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
              const target = normalize(mod.slug || mod.name || mod.title || '');
              return infoStore.find((info) => {
                const name = normalize(info.name || info.fileName || '');
                return !!name && (name === target || name.startsWith(target) || target.startsWith(name));
              });
            }
            return undefined;
          })()}
          {@const serverManaged = Boolean(
            serverManagedSet && installedInfo && (
              (installedInfo.fileName && serverManagedSet.has(installedInfo.fileName.toLowerCase())) ||
              // As a fallback, check normalized name membership by scanning set if needed
              (() => {
                const normalize = (str) => (str || '')
                  .toString()
                  .toLowerCase()
                  .replace(/\.(zip|jar)$/g, '')
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '');
                const name = normalize(installedInfo.name || installedInfo.fileName || '');
                // serverManagedSet contains fileNames; fuzzy match via iteration for assets
                if (name && $activeContentType !== CONTENT_TYPES.MODS) {
                  for (const f of serverManagedSet) {
                    const base = normalize(f);
                    if (base === name || base.startsWith(name) || name.startsWith(base)) return true;
                  }
                }
                return false;
              })()
            )
          )}
          <ModCard
            {mod}
            expanded={$expandedModId === mod.id}
            versions={versionsCache[mod.id] || []}
            loading={versionsLoading[mod.id] || false}
            error={versionsError[mod.id] || null}
            filterMinecraftVersion={$filterMinecraftVersion}
            loadOnMount={true}
            installedVersionId={installedInfo?.versionId || ""}
            {serverManaged}
            on:loadVersions={(e) => loadVersions(e)}
            on:versionSelect={handleVersionSelect}
            on:install={handleInstall}
          />
        {/each}
      </div>

      {#if visibleMods.length === 0 && hasLoadedOnce}
        <div class="no-results">
          No {$activeContentType === CONTENT_TYPES.SHADERS
            ? "shaders"
            : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
              ? "resource packs"
              : "mods"} found matching the current filters.
          {#if $activeContentType === CONTENT_TYPES.MODS}
            <button
              class="switch-to-any"
              on:click={() => {
                if ($activeContentType === CONTENT_TYPES.SHADERS) {
                  shadersFilterType = "all";
                } else if ($activeContentType === CONTENT_TYPES.RESOURCE_PACKS) {
                  resourcePacksFilterType = "all";
                } else {
                  modsFilterType = "all";
                }
                handleFilterChange();
              }}
            >
              Show all mods
            </button>
          {/if}
        </div>
      {/if}

      <!-- Always show pagination when we have results -->
      <div class="pagination">
        <button
          class="pagination-button"
          on:click={() => goToPage(1)}
          disabled={$currentPage === 1 || $isSearching}
          title="First page"
        >
          «
        </button>

        <button
          class="pagination-button"
          on:click={() => goToPage($currentPage - 1)}
          disabled={$currentPage === 1 || $isSearching}
          title="Previous page"
        >
          ‹
        </button>

        <span class="pagination-info">
          Page {$currentPage} of {displayTotalPages || 1}
          {#if $totalResults > 0}
            <span class="total-results"
              >({$totalResults}
              {$activeContentType === CONTENT_TYPES.SHADERS
                ? "shaders"
                : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
                  ? "resource packs"
                  : "mods"}{filterType !== "all"
                ? " matching filter"
                : ""})</span
            >
          {/if}
        </span>

        <button
          class="pagination-button"
          on:click={() => goToPage($currentPage + 1)}
          disabled={$currentPage === displayTotalPages ||
            $isSearching ||
            displayTotalPages <= 1}
          title="Next page"
        >
          ›
        </button>

        <button
          class="pagination-button"
          on:click={() => goToPage(displayTotalPages)}
          disabled={$currentPage === displayTotalPages ||
            $isSearching ||
            displayTotalPages <= 1}
          title="Last page"
        >
          »
        </button>
      </div>
    {:else if $isSearching}
      <div class="loading-message">Searching for mods...</div>
    {:else if $searchError}
      <div class="error-message">
        {#if $modSource === "curseforge" && ($searchError.includes("CurseForge") || $searchError.includes("403"))}
          <div class="curseforge-message">
            <h4>CurseForge API Access Issue</h4>
            <p>
              The CurseForge API cannot be accessed directly from the
              application at this time due to API restrictions.
            </p>
            <p>
              The Modrinth API is fully functional. Use the toggle above to
              switch to Modrinth for mod browsing.
            </p>
            <button
              class="switch-source-button"
              on:click={() => {
                modSource.set("modrinth");
                searchError.set("");
                loadMods();
              }}
            >
              Switch to Modrinth
            </button>
          </div>
        {:else if $searchError.includes("429") || $searchError.includes("rate limit") || $searchError.includes("Rate limit")}
          <div class="rate-limit-message">
            <h4>Modrinth API Rate Limit</h4>
            <p>
              We've reached the rate limit for the Modrinth API. This happens
              when making too many requests in a short time.
            </p>
            <p>
              The app will automatically retry, but you can also try again
              manually after a short wait.
            </p>
            <button
              class="retry-button"
              on:click={() => {
                searchError.set("");
                setTimeout(() => loadMods(), 2000);
              }}
            >
              Retry in 2 seconds
            </button>
          </div>
        {:else}
          Error: {$searchError}
        {/if}
      </div>
    {:else if $searchKeyword}
      <div class="no-results">No mods found matching your criteria.</div>
    {:else}
      <div class="empty-state-message">
        <p>
          Enter a search term and click "Search" to find {$activeContentType ===
          CONTENT_TYPES.SHADERS
            ? "shaders"
            : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
              ? "resource packs"
              : "mods"}.
        </p>
        <p>
          {#if $filterMinecraftVersion}
            Searching for Minecraft version {$filterMinecraftVersion}.
          {:else}
            Searching across all Minecraft versions.
          {/if}
        </p>
      </div>
    {/if}
  </div>
</div>

<style>
  .mod-search {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
  }

  .search-header {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .search-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .source-toggle {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .source-button {
    flex: 1;
    padding: 0.5rem;
    border: none;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    transition: all 0.2s;
  }

  .source-button.active {
    background: #646cff;
    color: white;
  }

  .source-button:hover:not(.active) {
    background: rgba(255, 255, 255, 0.2);
  }

  .source-button.coming-soon {
    opacity: 0.5;
    text-decoration: line-through;
    cursor: not-allowed;
  }

  .search-input-container {
    display: flex;
    gap: 0.5rem;
  }

  .search-input {
    flex: 1;
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    outline: none;
    transition: all 0.2s;
  }

  .search-input:focus {
    background: rgba(255, 255, 255, 0.15);
    box-shadow: 0 0 0 2px rgba(100, 108, 255, 0.3);
  }

  .search-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    background: #646cff;
    color: white;
    cursor: pointer;
    transition: all 0.2s;
  }

  .search-button:hover:not(:disabled) {
    background: #7a81ff;
  }

  .search-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .switch-to-any {
    background: #646cff;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    margin-top: 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.2s;
  }

  .switch-to-any:hover {
    background: #7a81ff;
  }

  .mods-grid {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    padding: 0.5rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
  }

  .pagination-button {
    width: 2rem;
    height: 2rem;
    display: flex;
    justify-content: center;
    align-items: center;
    border: none;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    cursor: pointer;
    transition: all 0.2s;
  }

  .pagination-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .pagination-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .pagination-info {
    padding: 0 0.5rem;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
  }

  .loading-message,
  .error-message,
  .no-results {
    text-align: center;
    padding: 2rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.7);
  }

  .error-message {
    color: #ff6b6b;
  }

  .curseforge-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    text-align: center;
  }

  .rate-limit-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    text-align: center;
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    background-color: rgba(30, 30, 30, 0.95);
    border-radius: 8px;
    border-left: 4px solid #ff9800;
  }

  .rate-limit-message h4 {
    color: #ff9800;
    margin: 0;
  }

  .retry-button,
  .switch-source-button {
    margin-top: 0.5rem;
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    background: #646cff;
    color: white;
    cursor: pointer;
    transition: all 0.2s;
  }

  .retry-button:hover,
  .switch-source-button:hover {
    background: #7a81ff;
  }

  .top-pagination {
    margin-top: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .empty-state-message {
    text-align: center;
    padding: 2rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 1.1rem;
    border-left: 4px solid #646cff;
  }

  .sort-message {
    margin: 0.5rem auto;
    padding: 0.5rem 1rem;
    background-color: #4caf50;
    color: white;
    border-radius: 4px;
    text-align: center;
    font-weight: 500;
    animation: fadeIn 0.3s ease-in;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
