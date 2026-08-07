<script>
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();
  export let selected = '';

  const sources = [
    { id: 'modrinth', title: 'Browse Modrinth', description: 'Search server-compatible packs and choose an exact published version.', status: 'Available' },
    { id: 'github', title: 'GitHub Releases', description: 'Review uploaded ZIP or RAR release assets before downloading anything.', status: 'Available' },
    { id: 'local', title: 'Local archive', description: 'Inspect a local MRPACK, ZIP, or complete RAR set using the native file picker.', status: 'Available' }
  ];

  function choose(source) {
    selected = source.id;
    dispatch('select', { source: source.id });
  }

  function keyboardChoose(event, source) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(source);
    }
  }
</script>

<div class="modpack-surface mp-stack">
  <div>
    <p class="mp-kicker">Install Modpack</p>
    <h2 class="mp-title">Choose where the pack is published</h2>
    <p class="mp-subtitle">Every source is inspected and reviewed before Minecraft Core changes a server.</p>
  </div>

  <div class="mp-grid" role="radiogroup" aria-label="Modpack source">
    {#each sources as source (source.id)}
      <button
        type="button"
        class="mp-card source-card"
        class:selected={selected === source.id}
        role="radio"
        aria-checked={selected === source.id}
        on:click={() => choose(source)}
        on:keydown={(event) => keyboardChoose(event, source)}
      >
        <span class="mp-badge good">{source.status}</span>
        <strong>{source.title}</strong>
        <span>{source.description}</span>
        <span class="selection-state">{selected === source.id ? 'Selected' : 'Not selected'}</span>
      </button>
    {/each}

    <div class="mp-card source-card unavailable" aria-disabled="true">
      <span class="mp-badge">Unavailable</span>
      <strong>CurseForge (Unavailable)</strong>
      <span>CurseForge browsing is unavailable in this build.</span>
    </div>
  </div>

  <div class="mp-actions">
    <button type="button" class="mp-button" on:click={() => dispatch('back')}>Back</button>
  </div>
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .source-card { display: grid; align-content: start; gap: 0.7rem; min-height: 175px; color: inherit; text-align: left; font: inherit; }
  button.source-card { cursor: pointer; }
  button.source-card:hover, button.source-card:focus-visible, .source-card.selected { border-color: rgba(124, 131, 255, 0.75); transform: translateY(-1px); }
  .source-card strong { font-size: 1.05rem; }
  .source-card > span:not(.mp-badge):not(.selection-state) { color: var(--mp-muted); line-height: 1.5; }
  .selection-state { align-self: end; color: #c4c7ff; font-size: 0.8rem; }
  .unavailable { opacity: 0.68; }
</style>
