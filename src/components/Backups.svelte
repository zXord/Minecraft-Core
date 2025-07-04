<script>
  import { onMount, tick } from 'svelte';
  import ConfirmationDialog from './common/ConfirmationDialog.svelte';
  import { serverState } from '../stores/serverState.js';
  import { writable } from 'svelte/store';

  export let serverPath = '';
  let backups = [];
  let loading = false;
  let error = '';
  let showDeleteDialog = false;
  let showRenameDialog = false;
  let backupToDelete = null;
  let backupToRename = null;
  let newName = '';
  let status = '';
  let lastServerPath = '';
  let renameInputEl;
  let renameDialogJustOpened = false;
  let showRestoreDialog = false;
  let backupToRestore = null;
  let selectedBackups = writable(new Set());
  let selectAll = false;
  let showBulkDeleteDialog = false;
  let lastAutoBackup = '';
  
  // Automation settings
  let autoBackupEnabled = false;
  let backupFrequency = 86400000; // Default to daily (24 hours in ms)
  let backupType = 'world';
  let retentionCount = 14;
  let runOnLaunch = false;
  let backupHour = 3; // Default to 3 AM
  let backupMinute = 0; // Default to 00 minutes
  let backupDay = 0; // Default to Sunday (0-based, 0=Sunday, 6=Saturday)
  let manualBackupType = 'world';
  
  // Define frequency options (in milliseconds)
  const frequencyOptions = [
    { value: 900000, label: 'Every 15 minutes' },
    { value: 1800000, label: 'Every 30 minutes' },
    { value: 3600000, label: 'Hourly' },
    { value: 21600000, label: 'Every 6 hours' },
    { value: 86400000, label: 'Daily' },
    { value: 604800000, label: 'Weekly' }
  ];
  
  // Day names for weekly backup day selection
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  $: isServerRunning = $serverState.status === 'Running';
  $: $selectedBackups;

  // Set visible based on frequency selection - show time selector for all except very short intervals
  $: showTimeSelector = backupFrequency >= 3600000; // Show for hourly and longer options
  
  // Only show day selector for weekly backups
  $: showDaySelector = backupFrequency >= 604800000; // Weekly

  // Assume window.electronAPI is exposed via preload for IPC
  async function fetchBackups() {
    loading = true;
    error = '';
    try {
      backups = await window.electron.invoke('backups:list', { serverPath });
      // Update last auto backup time if available
      const autoBackups = backups.filter(b => 
        b.metadata && (b.metadata.trigger === 'auto' || b.metadata.trigger === 'app-launch')
      );
      if (autoBackups.length > 0) {
        // Sort by timestamp to get the most recent
        autoBackups.sort((a, b) => {
          const timeA = a.metadata?.timestamp ? new Date(a.metadata.timestamp).getTime() : new Date(a.created).getTime();
          const timeB = b.metadata?.timestamp ? new Date(b.metadata.timestamp).getTime() : new Date(b.created).getTime();
          return timeB - timeA;
        });
        if (autoBackups[0]?.metadata?.timestamp) {
          const date = new Date(autoBackups[0].metadata.timestamp);
          lastAutoBackup = date.toLocaleString();
        }
      }
    } catch (e) {
      error = e.message || 'Failed to load backups';
    }
    loading = false;
  }

  // Only fetch backups when serverPath is set, valid, and changes
  $: if (serverPath && serverPath.trim() !== '' && serverPath !== lastServerPath) {
    lastServerPath = serverPath;
    fetchBackups();
    loadAutomationSettings();
  }

  // Load automation settings from electron store
  async function loadAutomationSettings() {
    try {
      const result = await window.electron.invoke('backups:get-automation-settings');
      if (result && result.success && result.settings) {
        const settings = result.settings;
        autoBackupEnabled = settings.enabled || false;
        backupFrequency = settings.frequency || 86400000;
        backupType = settings.type || 'world';
        manualBackupType = backupType;
        retentionCount = settings.retentionCount || 7;
        runOnLaunch = settings.runOnLaunch || false;
        backupHour = settings.hour || 3;
        backupMinute = settings.minute || 0;
        backupDay = settings.day !== undefined ? settings.day : 0;
        
        // If we have a last run time, update the UI
        if (settings.lastRun) {
          lastAutoBackup = new Date(settings.lastRun).toLocaleString();
        }
      }
    } catch (e) {
    }
  }
  
  // Save automation settings
  async function saveAutomationSettings() {
    try {
      await window.electron.invoke('backups:configure-automation', {
        enabled: autoBackupEnabled,
        frequency: backupFrequency,
        type: backupType,
        retentionCount: retentionCount,
        runOnLaunch: runOnLaunch,
        hour: backupHour,
        minute: backupMinute,
        day: backupDay,
        serverPath: serverPath
      });
      status = 'Backup automation settings saved';
      setTimeout(() => status = '', 2000);
      
      // Refresh automation settings to get updated next backup time
      loadAutomationSettings();
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Failed to save automation settings';
    }
  }
  
  // Run backup now
  async function runAutoBackupNow() {
    loading = true;
    error = '';
    try {
      const result = await window.electron.invoke('backups:run-immediate-auto', {
        serverPath,
        type: manualBackupType
      });
      
      if (result && !result.error) {
        status = `Manual ${manualBackupType === 'full' ? 'full' : 'world-only'} backup created successfully`;
        await fetchBackups(); // Refresh the backup list
        setTimeout(() => status = '', 2000);
      } else {
        error = result?.error || 'Failed to create manual backup';
      }
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Failed to create manual backup';
    }
    loading = false;
  }
  // Handle rename dialog focus without reactive loop
  function handleRenameDialogFocus(dialogVisible, inputElement, justOpened) {
    if (dialogVisible && inputElement && justOpened) {
      tick().then(() => {
        if (inputElement) {
          inputElement.focus();
          const base = newName.endsWith('.zip') ? newName.slice(0, -4) : newName;
          inputElement.setSelectionRange(0, base.length);
        }
      });
      renameDialogJustOpened = false;
    }
  }

  // Call focus handler when needed
  $: handleRenameDialogFocus(showRenameDialog, renameInputEl, renameDialogJustOpened);

  function cleanErrorMessage(msg) {
    if (!msg) return '';
    // Remove Electron's remote method error prefix    return msg.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  }

  function confirmDelete(backup) {
    backupToDelete = backup;
    showDeleteDialog = true;
  }

  async function deleteBackup() {
    loading = true;
    error = '';
    try {
      const result = await window.electron.invoke('backups:delete', { serverPath, name: backupToDelete.name });
      if (!result || result.success !== true) {
        throw new Error(result && result.error ? result.error : 'Delete failed');
      }
      await fetchBackups();
      status = 'Backup deleted.';
      showDeleteDialog = false;
      backupToDelete = null;
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Delete failed';
    }
    loading = false;
  }

  function promptRename(backup) {
    backupToRename = backup;
    newName = backup.name;
    showRenameDialog = true;
    renameDialogJustOpened = true;
  }

  async function renameBackup() {
    loading = true;
    error = '';
    try {
      let finalName = newName.trim();
      if (!finalName.toLowerCase().endsWith('.zip')) {
        finalName += '.zip';
      }
      await window.electron.invoke('backups:rename', { serverPath, oldName: backupToRename.name, newName: finalName });
      await fetchBackups();
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Rename failed';
    }
    loading = false;
    showRenameDialog = false;
    backupToRename = null;
  }

  function confirmRestore(backup) {
    backupToRestore = backup;
    showRestoreDialog = true;
  }

  async function doRestoreBackup() {
    loading = true;
    error = '';
    try {
      const result = await window.electron.invoke('backups:restore', { serverPath, name: backupToRestore.name, serverStatus: $serverState.status });
      if (result && result.success) {
        status = result.message || 'Backup restored successfully.';
        if (result.preRestoreBackup) {
          status += ` (Previous state saved as ${result.preRestoreBackup})`;
        }
        await fetchBackups();
      } else {
        error = cleanErrorMessage(result && result.error ? result.error : 'Restore failed');
        showRestoreDialog = false;
        backupToRestore = null;
        loading = false;
        return;
      }
      showRestoreDialog = false;
      backupToRestore = null;
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Restore failed';
    }
    loading = false;
  }

  // Derived value for selectAll
  $: selectAll = backups.length > 0 && $selectedBackups.size === backups.length;

  function toggleSelectAll() {
    if (!selectAll) {
      $selectedBackups = new Set(backups.map(b => b.name));
    } else {
      $selectedBackups = new Set();
    }
  }

  function toggleSelect(name) {
    const newSet = new Set($selectedBackups);
    if (newSet.has(name)) {
      newSet.delete(name);
    } else {
      newSet.add(name);
    }
    $selectedBackups = newSet;
  }

  async function bulkDeleteBackups() {
    loading = true;
    error = '';
    try {
      for (const name of $selectedBackups) {
        await window.electron.invoke('backups:delete', { serverPath, name });
      }
      await fetchBackups();
      status = 'Selected backups deleted.';
      $selectedBackups = new Set();
      showBulkDeleteDialog = false;
      setTimeout(() => status = '', 2000);
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Bulk delete failed';
    }
    loading = false;
  }

  // Add notification event listener
  onMount(() => {
    // Set up event listener for backup notifications
    const notificationHandler = (notification) => {
      if (notification && notification.message) {
        if (notification.success) {
          status = notification.message;
          // If it's an automatic backup notification, refresh the backup list
          if (notification.message.includes('auto-backup')) {
            fetchBackups();
          }
        } else {
          error = notification.message;
        }
        // Clear after a delay
        setTimeout(() => {
          if (status === notification.message) status = '';
          if (error === notification.message) error = '';
        }, 5000);
      }
    };
    
    // Register event handler
    window.electron.on('backup-notification', notificationHandler);
    
    // Initial load of automation settings
    loadAutomationSettings();
    
    // Add a visibility change handler to refresh backups when tab becomes active
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchBackups();
      }
    };
    
    // Add event listeners
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Clean up on destroy
    return () => {
      window.electron.removeListener('backup-notification', notificationHandler);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  // Helper function to format timestamps consistently
  function formatTimestamp(timestamp) {
    if (!timestamp) return '-';
    
    try {
      // Handle both ISO strings and Date objects
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return timestamp; // Return original if invalid
      
      return date.toLocaleString(); // Convert to local time
    } catch (e) {
      return timestamp; // Return original if conversion fails
    }
  }
</script>

<div class="backups-container">
  <!-- Modern Header -->
  <div class="backups-header">
    <h1 class="backups-title">Backup Automation</h1>
    <div class="header-controls">
      <div class="backup-type-selector">
        <select bind:value={manualBackupType} class="type-select">
          <option value="world">World-only</option>
          <option value="full">Full</option>
        </select>
        <span class="select-arrow">▼</span>
      </div>
      <button
        class="run-backup-btn"
        on:click={runAutoBackupNow}
        disabled={loading}
      >
        Run Backup Now
      </button>
    </div>
  </div>

  <!-- Main Settings Card -->
  <div class="settings-card">
    <!-- Enable Toggle -->
    <div class="enable-section">
      <div class="toggle-container">
        <input
          type="checkbox"
          id="enable-automation"
          bind:checked={autoBackupEnabled}
          on:change={saveAutomationSettings}
          class="modern-checkbox"
        />
        <label for="enable-automation" class="enable-label">
          Enable Automatic Backups
        </label>
      </div>
    </div>

    <!-- Settings Grid -->
    <div class="settings-grid" class:disabled={!autoBackupEnabled}>
      <!-- Frequency -->
      <div class="setting-group">
        <label class="setting-label" for="frequency-select">Frequency</label>
        <div class="select-wrapper">
          <select 
            id="frequency-select"
            bind:value={backupFrequency} 
            on:change={saveAutomationSettings}
            disabled={!autoBackupEnabled}
            class="modern-select"
          >
            {#each frequencyOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <span class="select-arrow">▼</span>
        </div>
      </div>

      <!-- Schedule Time -->
      {#if showTimeSelector}
        <div class="setting-group">
          <label class="setting-label" for="hour-select">Schedule at</label>
          <div class="time-controls">
            {#if showDaySelector}
              <div class="select-wrapper small">
                <select 
                  id="day-select"
                  bind:value={backupDay}
                  on:change={saveAutomationSettings}
                  disabled={!autoBackupEnabled}
                  class="modern-select small"
                >
                  {#each dayNames as day, index}
                    <option value={index}>{day.slice(0,3)}</option>
                  {/each}
                </select>
                <span class="select-arrow">▼</span>
              </div>
            {/if}
            <div class="select-wrapper small">
              <select 
                id="hour-select"
                bind:value={backupHour}
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
                class="modern-select small"
              >
                {#each Array(24).fill().map((_, i) => i) as hour}
                  <option value={hour}>{hour.toString().padStart(2, '0')}</option>
                {/each}
              </select>
              <span class="select-arrow">▼</span>
            </div>
            <span class="time-separator">:</span>
            <div class="select-wrapper small">
              <select 
                id="minute-select"
                bind:value={backupMinute}
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
                class="modern-select small"
              >
                {#each [0, 15, 30, 45] as minute}
                  <option value={minute}>{minute.toString().padStart(2, '0')}</option>
                {/each}
              </select>
              <span class="select-arrow">▼</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- Retention -->
      <div class="setting-group">
        <label class="setting-label" for="retention-input">Retention</label>
        <div class="retention-control">
          <input
            id="retention-input"
            type="number"
            min="1"
            max="100"
            bind:value={retentionCount}
            on:change={saveAutomationSettings}
            disabled={!autoBackupEnabled}
            class="retention-input"
          />
          <span class="retention-suffix">backups</span>
        </div>
      </div>

      <!-- Backup Type -->
      <div class="setting-group">
        <span class="setting-label">Content</span>
        <div class="radio-group">
          <div class="radio-option">
            <input
              type="radio"
              id="type-full"
              name="backup-type"
              value="full"
              bind:group={backupType}
              on:change={saveAutomationSettings}
              disabled={!autoBackupEnabled}
              class="modern-radio"
            />
            <label for="type-full" class="radio-label">Full</label>
          </div>
          <div class="radio-option">
            <input
              type="radio"
              id="type-world"
              name="backup-type"
              value="world"
              bind:group={backupType}
              on:change={saveAutomationSettings}
              disabled={!autoBackupEnabled}
              class="modern-radio"
            />
            <label for="type-world" class="radio-label">World-only</label>
          </div>
        </div>
      </div>
    </div>

    <!-- Status Footer -->
    {#if autoBackupEnabled}
      <div class="status-footer">
        <div class="next-backup">
          {#if backupFrequency >= 604800000}
            Next backup: {dayNames[backupDay]} at {backupHour.toString().padStart(2, '0')}:{backupMinute.toString().padStart(2, '0')}
          {:else if backupFrequency >= 86400000}
            Next backup: daily at {backupHour.toString().padStart(2, '0')}:{backupMinute.toString().padStart(2, '0')}
          {:else}
            Next backup: every {Math.floor(backupFrequency / 3600000)}h {Math.floor((backupFrequency % 3600000) / 60000)}m
          {/if}
        </div>
        <div class="last-backup">
          <span class="status-icon">✓</span>
          <span>Last backup: {lastAutoBackup || 'Never'}</span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Status Messages -->
  {#if status}
    <div class="status-message success">{status}</div>
  {/if}
  {#if error}
    <div class="status-message error">{error}</div>
  {/if}

  <!-- Backup List -->
  <div class="backup-list-section">
    <div class="list-header">
      <h2 class="list-title">Backup List</h2>
      {#if $selectedBackups.size > 0}
        <button class="bulk-delete-btn" on:click={() => showBulkDeleteDialog = true} disabled={loading}>
          🗑️ Delete Selected ({$selectedBackups.size})
        </button>
      {/if}
    </div>

    <div class="table-container">
      <table class="modern-table">
        <thead>
          <tr>
            <th class="checkbox-col">
              <input 
                type="checkbox" 
                checked={selectAll} 
                on:change={toggleSelectAll}
                class="modern-checkbox small"
              />
            </th>
            <th>Name</th>
            <th>Type</th>
            <th>Size</th>
            <th>Timestamp</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each backups as backup}
            <tr>
              <td class="checkbox-col">
                <input 
                  type="checkbox" 
                  checked={$selectedBackups.has(backup.name)} 
                  on:change={() => toggleSelect(backup.name)}
                  class="modern-checkbox small"
                />
              </td>
              <td class="backup-name">
                {backup.name}
                {#if backup.metadata?.automated}
                  <span class="backup-badge">🤖</span>
                {/if}
              </td>
              <td>{backup.metadata?.type || '-'}</td>
              <td>{(backup.size/1024/1024).toFixed(2)} MB</td>
              <td>{formatTimestamp(backup.metadata?.timestamp || backup.created)}</td>
              <td>
                <div class="action-buttons">
                  <button 
                    class="action-btn restore" 
                    on:click={() => confirmRestore(backup)} 
                    disabled={loading || isServerRunning}
                    title="Restore"
                  >
                    ↻
                  </button>
                  <button 
                    class="action-btn rename" 
                    on:click={() => promptRename(backup)} 
                    disabled={loading}
                    title="Rename"
                  >
                    ✏️
                  </button>
                  <button 
                    class="action-btn delete" 
                    on:click={() => confirmDelete(backup)} 
                    disabled={loading}
                    title="Delete"
                  >
                    🗑️
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>

{#if showDeleteDialog}
  <ConfirmationDialog
    visible={showDeleteDialog}
    message={`Delete backup ${backupToDelete?.name}?`}
    on:confirm={deleteBackup}
    on:cancel={() => { showDeleteDialog = false; backupToDelete = null; }}
  />
{/if}

{#if showRenameDialog}
  <div class="rename-dialog-modal">
    <div class="rename-dialog-content">
      <h3>Rename Backup</h3>
      <label for="rename-input">New name:</label>
      <input
        id="rename-input"
        bind:value={newName}
        bind:this={renameInputEl}
        class="rename-input"
        on:keydown={(e) => { if (e.key === 'Enter') renameBackup(); }}
      />
      <div class="rename-dialog-actions">
        <button class="rename-confirm" on:click={renameBackup} disabled={loading}>Rename</button>
        <button class="rename-cancel" on:click={() => { showRenameDialog = false; backupToRename = null; }}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

{#if showRestoreDialog}
  <ConfirmationDialog
    visible={showRestoreDialog}
    message={`Restore backup ${backupToRestore?.name}? This will overwrite your current server/world data.`}
    on:confirm={doRestoreBackup}
    on:cancel={() => { showRestoreDialog = false; backupToRestore = null; }}
  />
{/if}

{#if showBulkDeleteDialog}
  <ConfirmationDialog
    visible={showBulkDeleteDialog}
    message={`Delete ${$selectedBackups.size} selected backups? This cannot be undone.`}
    on:confirm={bulkDeleteBackups}
    on:cancel={() => showBulkDeleteDialog = false}
  />
{/if}

<style>
  .backups-container {
    padding: 1rem;
    box-sizing: border-box;
    max-width: 100%;
    overflow-x: auto;
  }

  .backups-header {
    background: #2a2e36;
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
    border: 1px solid #444;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .backups-title {
    margin: 0;
    color: #d9eef7;
    font-size: 1.8rem;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .backup-type-selector {
    position: relative;
    display: flex;
    align-items: center;
    background: #2a2e36;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    color: #d9eef7;
    font-size: 0.95rem;
  }

  .type-select {
    background: transparent;
    border: none;
    color: #d9eef7;
    font-size: 0.95rem;
    padding: 0.2rem 1.5rem 0.2rem 0.5rem; /* Add right padding so text doesn't overlap arrow */
    cursor: pointer;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    width: 100%;
  }

  .select-arrow {
    position: absolute;
    right: 0.5rem;
    pointer-events: none;
    color: #555;
  }

  .run-backup-btn {
    background: #3498db;
    border: none;
    border-radius: 4px;
    padding: 0.6rem 1.2rem;
    color: white;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
  }

  .run-backup-btn:hover:not(:disabled) {
    background: #2980b9;
  }

  .run-backup-btn:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }

  .settings-card {
    background: #2a2e36;
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.25rem;
    border: 1px solid #444;
    max-width: 100%;
    overflow-x: auto;
    box-sizing: border-box;
  }

  .enable-section {
    margin-bottom: 1.5rem;
    /* Only one separator - remove bottom border, rely on settings-grid top border */
    padding-bottom: 0.5rem;
  }

  .toggle-container {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 0.8rem;
  }

  .enable-label {
    color: #bbb;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
  }

  .modern-checkbox {
    width: 1.25rem;
    height: 1.25rem;
    accent-color: #3498db;
  }

  .modern-checkbox:checked {
    background-color: #3498db;
    border-color: #3498db;
  }

  .modern-checkbox:focus {
    outline: 2px solid #3498db;
    outline-offset: 2px;
  }

     .settings-grid {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
     gap: 1rem;
     margin-top: 1rem;
     padding-top: 1rem;
     border-top: 1px solid #444;
     max-width: 100%;
     overflow-x: auto;
     align-items: end; /* Align items for better vertical alignment */
   }

   .settings-grid.disabled {
     opacity: 0.7;
     pointer-events: none;
   }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .setting-label {
    color: #bbb;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .select-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.4rem 0.8rem;
    color: #eee;
    font-size: 0.95rem;
    width: 100%;
    max-width: 200px; /* Limit width for select */
  }

  .select-wrapper.small {
    max-width: 100px; /* Smaller select for time */
  }

  .modern-select {
    background: transparent;
    border: none;
    color: #eee;
    font-size: 0.95rem;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    width: 100%;
  }

  .modern-select:focus {
    outline: none;
    box-shadow: 0 0 0 2px #3498db;
  }

  .time-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .time-separator {
    color: #555;
    font-size: 1.1rem;
    font-weight: bold;
  }

  .retention-control {
     display: flex;
     align-items: center;
     gap: 0.25rem;
     background: #1e2228;
     border: 1px solid #444;
     border-radius: 4px;
     padding: 0.32rem 0.6rem; /* match select vertical padding for equal height */
     color: #eee;
     font-size: 0.9rem;
     width: fit-content; /* shrink to content */
     max-width: 160px;
   }

  .retention-input {
    background: transparent;
    border: none;
    color: #eee;
    font-size: 0.95rem;
    width: 38px;
    text-align: right;
  }

  .retention-input:focus {
    outline: none;
    box-shadow: 0 0 0 2px #3498db;
  }

  .retention-suffix {
    color: #bbb;
    font-size: 0.8rem;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .radio-option {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .modern-radio {
    width: 1.25rem;
    height: 1.25rem;
    accent-color: #3498db;
  }

  .modern-radio:checked {
    background-color: #3498db;
    border-color: #3498db;
  }

  .modern-radio:focus {
    outline: 2px solid #3498db;
    outline-offset: 2px;
  }

  .radio-label {
    color: #bbb;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .status-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #444;
    color: #999;
    font-size: 0.9rem;
  }

  .next-backup {
    color: #d9eef7;
    font-weight: 500;
  }

  .last-backup {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-icon {
    color: #2ecc71;
    font-size: 1rem;
  }

  .backup-list-section {
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid #444;
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.8rem;
  }

  .list-title {
    margin: 0;
    color: #d9eef7;
    font-size: 1.2rem;
  }

  .bulk-delete-btn {
    background: #f44336;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .bulk-delete-btn:hover:not(:disabled) {
    background: #c62828;
  }

     .bulk-delete-btn:disabled {
     background: #e57373;
     cursor: not-allowed;
   }

   .table-container {
     background: #2a2e36;
     border-radius: 8px;
     overflow: hidden;
     border: 1px solid #444;
   }

   .modern-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 0.5rem;
    table-layout: fixed;
    max-width: 100%;
  }

     .modern-table th {
     background: #3a3e46;
     color: #d9eef7;
     font-weight: 500;
     text-transform: uppercase;
     font-size: 0.8rem;
     letter-spacing: 0.05em;
     padding: 0.75rem 1rem;
     border-bottom: 1px solid #444;
     text-align: left;
   }

   .modern-table td {
     padding: 0.55rem 0.8rem;
     border-bottom: 1px solid #444;
     color: #bbb;
     overflow: hidden;
     text-overflow: ellipsis;
     white-space: nowrap;
   }

   .modern-table tbody tr:hover {
     background: #32383f;
   }

  .checkbox-col {
    width: 40px; /* Checkbox column */
  }

     .backup-name {
     width: 30%; /* Name column */
     color: #d9eef7;
     font-weight: 500;
   }

   .backup-badge {
     margin-left: 0.5rem;
     font-size: 0.8rem;
     color: #3498db;
   }

  .action-buttons {
    display: flex;
    gap: 0.3rem;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
  }

  .action-btn {
    min-width: 28px;
    height: 28px;
    padding: 0.2rem;
    border: 1px solid #555;
    border-radius: 4px;
    background: #2a2e36;
    color: #d9eef7;
    cursor: pointer;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .action-btn:hover:not(:disabled) {
    background: #3a3e46;
    border-color: #666;
    transform: translateY(-1px);
  }

  .action-btn:disabled {
    background: #1a1e26;
    color: #777;
    cursor: not-allowed;
    border-color: #333;
  }

  .restore:hover:not(:disabled) {
    background: #27ae60;
    border-color: #2ecc71;
    color: white;
  }

  .rename:hover:not(:disabled) {
    background: #3498db;
    border-color: #2980b9;
    color: white;
  }

  .delete:hover:not(:disabled) {
    background: #e74c3c;
    border-color: #c0392b;
    color: white;
  }

  .rename-dialog-modal {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 1001;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .rename-dialog-content {
    background: #2a2e36;
    border-radius: 8px;
    padding: 2rem;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    max-width: 400px;
    width: 90%;
    text-align: center;
  }

  .rename-dialog-content h3 {
    margin-top: 0;
    margin-bottom: 1.5rem;
    color: #d9eef7;
  }

  .rename-dialog-content label {
    display: block;
    margin-bottom: 0.8rem;
    color: #bbb;
    font-size: 0.95rem;
  }

  .rename-input {
    width: 100%;
    padding: 0.6rem 1rem;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1e2228;
    color: #eee;
    font-size: 1rem;
    box-sizing: border-box;
  }

  .rename-input:focus {
    outline: none;
    border-color: #3498db;
    box-shadow: 0 0 0 2px #3498db;
  }

  .rename-dialog-actions {
    display: flex;
    justify-content: space-around;
    margin-top: 1.5rem;
  }

  .rename-confirm, .rename-cancel {
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.2s;
  }

  .rename-confirm {
    background: #3498db;
    color: white;
  }

  .rename-confirm:hover:not(:disabled) {
    background: #2980b9;
  }

  .rename-confirm:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }

  .rename-cancel {
    background: #e74c3c;
    color: white;
  }

  .rename-cancel:hover:not(:disabled) {
    background: #c0392b;
  }

  .rename-cancel:disabled {
    background: #e57373;
    cursor: not-allowed;
  }

  .status-message {
    padding: 0.8rem 1rem;
    border-radius: 4px;
    margin-bottom: 0.8rem;
    font-weight: 500;
    font-size: 0.95rem;
  }

  .status-message.success {
    background-color: #2ecc71;
    color: white;
  }

  .status-message.error {
    background-color: #e74c3c;
    color: white;
  }

  .modern-select option,
  .type-select option { /* ensure header dropdown too */
    color: #000;
    background: #fff;
  }
</style>