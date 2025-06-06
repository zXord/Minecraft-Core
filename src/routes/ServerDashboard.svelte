<script>
  export let serverPath = '';
  import ServerControls from '../components/server/ServerControls.svelte';
  import ServerMetrics from '../components/server/ServerMetrics.svelte';
  import ServerConsole from '../components/server/ServerConsole.svelte';
  import ServerRepair from '../components/settings/ServerRepair.svelte';
</script>

<div class="dashboard-panel">
  <ServerControls {serverPath} />
  <ServerMetrics />
  <ServerConsole />
  <hr/>
  <ServerRepair {serverPath} />
</div>
