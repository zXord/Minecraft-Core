<script>
  import { onMount, tick } from 'svelte';
  import ConfirmationDialog from './common/ConfirmationDialog.svelte';
  import StatusMessage from './common/StatusMessage.svelte';
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
  let retentionCount = 7;
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
      console.error('Failed to load automation settings:', e);
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
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Failed to save automation settings';
    }
  }
  
  // Run backup now
  async function runAutoBackupNow() {
    loading = true;
    status = 'Running backup now...';
    error = '';
    try {
      await window.electron.invoke('backups:run-immediate-auto', { serverPath, type: manualBackupType });
      await fetchBackups(); // Refresh the list
      status = 'Backup completed!';
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Backup failed';
    }
    loading = false;
    setTimeout(() => status = '', 2000);
  }

  $: if (showRenameDialog && renameInputEl && renameDialogJustOpened) {
    tick().then(() => {
      renameInputEl.focus();
      const base = newName.endsWith('.zip') ? newName.slice(0, -4) : newName;
      renameInputEl.setSelectionRange(0, base.length);
      renameDialogJustOpened = false;
    });
  }

  function cleanErrorMessage(msg) {
    if (!msg) return '';
    // Remove Electron's remote method error prefix
    return msg.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  }

  async function createBackup(type) {
    loading = true;
    status = `Creating ${type} backup...`;
    error = '';
    try {
      const result = await window.electron.invoke('backups:create', { serverPath, type, trigger: 'manual' });
      if (result.error) throw new Error(result.error);
      status = 'Backup complete!';
      await fetchBackups();
    } catch (e) {
      error = cleanErrorMessage(e.message) || 'Backup failed';
    }
    loading = false;
    setTimeout(() => status = '', 2000);
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
</script>

<div class="backups-tab">
  <h2>Backups</h2>
  
  <!-- Automation Settings Section -->
  <div class="automation-section">
    <div class="section-header">
      <h3>Backup Automation</h3>
      <div class="run-now-controls">
        <select bind:value={manualBackupType} class="manual-type-select" title="Backup content">
          <option value="full">Full</option>
          <option value="world">World-only</option>
        </select>
        <button
          class="run-now-button"
          on:click={runAutoBackupNow}
          disabled={loading}
          title="Run a backup now with the selected content"
        >
          Run Backup Now
        </button>
      </div>
    </div>
    
    <div class="automation-controls">
      <div class="enable-row">
        <label class="toggle-label">
          <input 
            type="checkbox" 
            bind:checked={autoBackupEnabled} 
            on:change={saveAutomationSettings}
          />
          <span>🕒 Enable Automatic Backups</span>
        </label>
        
        {#if lastAutoBackup}
          <div class="last-backup-info">
            🕓 Last: {lastAutoBackup}
          </div>
        {/if}
      </div>
      
      <div class="settings-grid" class:disabled={!autoBackupEnabled}>
        <!-- More horizontal layout with 3 columns -->
        <div class="grid-item">
          <label for="backup-frequency">Frequency:</label>
          <select 
            id="backup-frequency"
            bind:value={backupFrequency} 
            on:change={saveAutomationSettings}
            disabled={!autoBackupEnabled}
          >
            {#each frequencyOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
        
        <div class="grid-item">
          <label>Content:</label>
          <div class="radio-group horizontal">
            <label class="radio-label">
              <input 
                type="radio" 
                name="backup-type" 
                value="full" 
                bind:group={backupType} 
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
              />
              <span>Full</span>
            </label>
            <label class="radio-label">
              <input 
                type="radio" 
                name="backup-type" 
                value="world" 
                bind:group={backupType} 
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
              />
              <span>World-only</span>
            </label>
          </div>
        </div>
        
        <div class="grid-item">
          <label for="retention-count">Keep last:</label>
          <div class="retention-input">
            <input 
              id="retention-count"
              type="number" 
              min="1" 
              max="100" 
              bind:value={retentionCount} 
              on:change={saveAutomationSettings}
              disabled={!autoBackupEnabled}
            />
            <span>backups</span>
          </div>
        </div>
        
        {#if showTimeSelector}
          <div class="grid-item schedule-item">
            <label>Schedule at:</label>
            <div class="time-selectors">
              {#if showDaySelector}
                <select 
                  id="backup-day"
                  bind:value={backupDay} 
                  on:change={saveAutomationSettings}
                  disabled={!autoBackupEnabled}
                  title="Day of the week"
                >
                  {#each dayNames as day, index}
                    <option value={index}>{day.slice(0,3)}</option>
                  {/each}
                </select>
              {/if}
              
              <select 
                bind:value={backupHour} 
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
                title="Hour"
              >
                {#each Array(24).fill().map((_, i) => i) as hour}
                  <option value={hour}>{hour.toString().padStart(2, '0')}</option>
                {/each}
              </select>
              <span>:</span>
              <select 
                bind:value={backupMinute} 
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
                title="Minute"
              >
                {#each [0, 15, 30, 45] as minute}
                  <option value={minute}>{minute.toString().padStart(2, '0')}</option>
                {/each}
              </select>
            </div>
          </div>
        {/if}
        
        <div class="grid-item">
          <label class="toggle-label">
            <input 
              type="checkbox" 
              bind:checked={runOnLaunch} 
              on:change={saveAutomationSettings}
              disabled={!autoBackupEnabled}
            />
            <span>Run on app launch</span>
          </label>
        </div>
      </div>
      
      {#if showTimeSelector}
        <div class="time-explanation">
          {#if showDaySelector}
            Backup will run on {dayNames[backupDay]} at {backupHour.toString().padStart(2, '0')}:{backupMinute.toString().padStart(2, '0')}.
          {:else if backupFrequency >= 86400000}
            Backup will run daily at {backupHour.toString().padStart(2, '0')}:{backupMinute.toString().padStart(2, '0')}.
          {:else}
            First backup at {backupHour.toString().padStart(2, '0')}:{backupMinute.toString().padStart(2, '0')}, then repeats at the selected frequency.
          {/if}
        </div>
      {/if}
    </div>
  </div>
  
  {#if status}
    <StatusMessage message={status} type="info" />
  {/if}
  {#if error}
    <StatusMessage message={error} type="error" />
  {/if}
  {#if loading}
    <p>Loading...</p>
  {/if}
  
  <div class="backups-list-header">
    <h3>Backup List</h3>
    {#if $selectedBackups.size > 0}
      <button class="bulk-delete" on:click={() => showBulkDeleteDialog = true} disabled={loading}>
        🗑️ Delete Selected ({$selectedBackups.size})
      </button>
    {/if}
  </div>
  
  <table class="backups-table">
    <thead>
      <tr>
        <th><input type="checkbox" checked={selectAll} on:change={toggleSelectAll} /></th>
        <th>Name</th>
        <th>Type</th>
        <th>Size</th>
        <th>Timestamp</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#each backups as b}
        <tr class:world-delete-backup={b.metadata?.type === 'world-delete'} class:auto-backup={b.metadata?.automated}>
          <td><input type="checkbox" checked={$selectedBackups.has(b.name)} on:change={() => toggleSelect(b.name)} /></td>
          <td>
            {b.name} 
            {#if b.metadata?.type === 'world-delete'}
              <span title="Created automatically before world deletion">🗑️</span>
            {/if}
            {#if b.metadata?.automated}
              <span title="Created by automation">🤖</span>
            {/if}
          </td>
          <td>{b.metadata?.type || '-'}</td>
          <td>{(b.size/1024/1024).toFixed(2)} MB</td>
          <td>{b.metadata?.timestamp || b.created}</td>
          <td>
            <button on:click={() => confirmRestore(b)} disabled={loading || isServerRunning}>Restore</button>
            <button on:click={() => confirmDelete(b)} disabled={loading}>Delete</button>
            <button on:click={() => promptRename(b)} disabled={loading}>Rename</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

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
</div>

<style>
  .backups-tab { padding: 1rem; }
  .backups-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  .backups-table th, .backups-table td { border: 1px solid #ccc; padding: 0.5rem; }

  .rename-dialog-modal {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 1001;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  /* Automation Section Styles - More compact horizontally */
  .automation-section {
    background: #2a2e36;
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1rem;
    border: 1px solid #444;
  }
  
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.8rem;
  }
  
  .section-header h3 {
    margin: 0;
    color: #d9eef7;
    font-size: 1.2rem;
  }

  .run-now-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .manual-type-select {
    padding: 0.3rem;
    border-radius: 4px;
    background: #2a2e36;
    color: #d9eef7;
    border: 1px solid #555;
  }
  
  .automation-controls {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  
  .enable-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 500;
    cursor: pointer;
  }
  
  .run-now-button {
    background: #3498db;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 0.8rem;
    color: white;
    font-weight: 500;
    cursor: pointer;
  }
  
  .run-now-button:hover:not(:disabled) {
    background: #2980b9;
  }
  
  .run-now-button:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }
  
  .settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem 2rem;
    margin-top: 0.5rem;
    padding-top: 0.8rem;
    border-top: 1px solid #444;
  }
  
  .schedule-item {
    grid-column: span 2;
  }
  
  .settings-grid.disabled {
    opacity: 0.7;
    pointer-events: none;
  }
  
  .grid-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .grid-item label {
    color: #bbb;
    font-size: 0.9rem;
  }
  
  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  
  .radio-group.horizontal {
    flex-direction: row;
    gap: 1rem;
  }
  
  .radio-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  
  select, input[type="number"] {
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.4rem;
    color: #eee;
    font-size: 0.95rem;
  }
  
  select:disabled, input:disabled {
    background: #2c3037;
    color: #aaa;
    cursor: not-allowed;
  }
  
  .retention-input {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .retention-input input {
    width: 50px;
  }
  
  .last-backup-info {
    background: #32383f;
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    font-size: 0.9rem;
    color: #2ecc71;
    white-space: nowrap;
  }
  
  .time-explanation {
    font-size: 0.85rem;
    color: #999;
    padding: 0.4rem 0.8rem;
    background: #222;
    border-radius: 4px;
    border-left: 3px solid #3498db;
  }
  
  .time-selectors {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  
  .time-selectors select {
    width: auto;
    min-width: 55px;
    text-align: center;
  }
  
  .backup-warning {
    color: #ff9800;
    background: #232323;
    border: 1px solid #ff9800;
    border-radius: 5px;
    padding: 0.5rem 1rem;
    margin-top: 0.5rem;
    font-size: 0.95rem;
    display: inline-block;
  }
  
  .bulk-delete {
    background: #f44336;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  
  .bulk-delete:disabled {
    background: #e57373;
    cursor: not-allowed;
  }
  
  .world-delete-backup td {
    background: rgba(255, 0, 0, 0.08);
    color: #ff5555;
  }
  
  .auto-backup td {
    background: rgba(46, 204, 113, 0.08);
  }
  
  .backups-list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1.5rem;
    margin-bottom: 0.5rem;
    border-top: 1px solid #444;
    padding-top: 1rem;
  }
  
  .backups-list-header h3 {
    margin: 0;
  }
</style> 