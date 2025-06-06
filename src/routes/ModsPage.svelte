<script>
  export let serverPath = '';
  import ServerModManager from '../components/server/ServerModManager.svelte';
</script>

<div class="content-panel">
  <ServerModManager {serverPath} />
</div>
