<script>
  export let serverPath = '';
  import ServerControls from '../components/server/ServerControls.svelte';
  import ServerMetrics from '../components/server/ServerMetrics.svelte';
  import ServerConsole from '../components/server/ServerConsole.svelte';
</script>

<div class="dashboard-panel">
  <ServerControls {serverPath} />
  <ServerMetrics />
  <ServerConsole />
</div>

<style>
  .dashboard-panel {
    max-width: 1200px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
</style>
