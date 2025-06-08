<script>
  import { createEventDispatcher } from 'svelte';
  
  export let serverPath = '';
  export let currentInstance;
  import { openFolder, validateServerPath } from '../utils/folderUtils.js';
  import AutoRestartSettings from '../components/settings/AutoRestartSettings.svelte';
  import VersionUpdater from '../components/settings/VersionUpdater.svelte';
  import WorldSettings from '../components/settings/WorldSettings.svelte';
  import ServerPropertiesEditor from '../components/settings/ServerPropertiesEditor.svelte';
  import InstanceSettings from '../components/settings/InstanceSettings.svelte';
  import { errorMessage } from '../stores/modStore.js';
  
  const dispatch = createEventDispatcher();
</script>

<div class="content-panel">
  <h2>Server Settings</h2>
  <div class="server-path-section">
    <h3>Server Location</h3>
    <div class="path-container">
      <div class="path-text">{serverPath}</div>
      <button
        class="folder-button"
        on:click={async () => {
          if (!validateServerPath(serverPath)) {
            errorMessage.set('Server path is empty or invalid. Please set up the server first.');
            setTimeout(() => errorMessage.set(''), 5000);
            return;
          }
          const success = await openFolder(serverPath);
          if (!success) {
            errorMessage.set(`Failed to open folder. Please access it manually at: ${serverPath}`);
            setTimeout(() => errorMessage.set(''), 5000);
          }
        }}
        title="Open server folder"
      >
        📁
      </button>
    </div>
  </div>
  <ServerPropertiesEditor serverPath={serverPath} />
  <WorldSettings serverPath={serverPath} />
  <AutoRestartSettings />
  <VersionUpdater serverPath={serverPath} />  {#if currentInstance}
    <InstanceSettings
      instance={currentInstance}
      on:deleted={(e) => {
        // Forward the deletion event to the parent component (App.svelte)
        dispatch('deleted', e.detail);
      }}
    />
  {/if}
</div>
