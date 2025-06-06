<script>
  export let serverPath = '';
  import ModManager from '../components/mods/ModManager.svelte';
</script>

<div class="content-panel">
  <ModManager {serverPath} />
</div>
