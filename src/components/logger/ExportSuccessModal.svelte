<script>
  import { createEventDispatcher } from 'svelte';
  export let visible = false;
  export let filePath = '';
  export let count = 0;
  const dispatch = createEventDispatcher();
  function close() { visible = false; dispatch('close'); }
  async function openFolder() {
    if (!filePath) return;
    // Extract directory from file path in a cross-platform way
    const dir = filePath.replace(/[\\/][^\\/]+$/, '');
    try { await window.electron.invoke('open-folder-direct', dir); } catch {}
    close();
  }
  // Close on Escape for backdrop accessibility
  function handleBackdropKey(e){ if(e.key==='Escape') close(); }
</script>
{#if visible}
<div class="export-modal-backdrop" on:click|self={close} role="presentation" tabindex="-1" on:keydown={handleBackdropKey}>
  <div class="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <h3 id="export-title">Logs exported</h3>
    <p>{count} logs saved to:</p>
    <pre class="file-path">{filePath}</pre>
    <div class="actions">
      <button class="open-btn" on:click={openFolder}>Open Folder</button>
      <button class="close-btn" on:click={close}>Close</button>
    </div>
  </div>
</div>
{/if}
<style>
  .export-modal-backdrop{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000;outline:none}
  .export-modal{background:#182634;border:1px solid #314d68;border-radius:8px;padding:1rem;max-width:500px;width:90%;color:#fff;display:flex;flex-direction:column;gap:.5rem}
  .file-path{background:#223649;padding:.25rem .5rem;border-radius:4px;font-size:.8rem;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}
  .actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:.5rem}
  .open-btn{background:#0c7ff2;border:none;color:#fff;padding:.3rem .75rem;border-radius:4px;font-size:.8rem;cursor:pointer}
  .open-btn:hover{background:#0369a1}
  .close-btn{background:#374151;border:none;color:#fff;padding:.3rem .75rem;border-radius:4px;font-size:.8rem;cursor:pointer}
  .close-btn:hover{background:#4b5563}
</style> 