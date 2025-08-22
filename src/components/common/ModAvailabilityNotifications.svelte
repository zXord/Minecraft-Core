<script>
  import { modAvailabilityWatchStore } from '../../stores/modAvailabilityWatchStore.js';
  export let limit = 5;
  function dismiss(i){
    modAvailabilityWatchStore.dismissNotification(i);
  }
  $: notifications = ($modAvailabilityWatchStore.notifications || []).slice(0, limit);
</script>

<div class="mod-availability-notify-container" aria-live="polite">
  {#each notifications as n, i (n.projectId + n.at)}
    <div class="mod-availability-toast">
      <div class="icon">✅</div>
      <div class="body">
        <div class="line"><strong>{n.modName}</strong> now available</div>
        <div class="target">{n.target.mc}/{n.target.fabric} • {n.versionFound}</div>
        <div class="time">{new Date(n.at).toLocaleString()}</div>
      </div>
      <button class="close" on:click={() => dismiss(i)} aria-label="Dismiss">✖</button>
    </div>
  {/each}
</div>

<style>
  .mod-availability-notify-container{position:fixed; top:68px; right:16px; display:flex; flex-direction:column; gap:8px; z-index:6000; width:260px; pointer-events:none;}
  .mod-availability-toast{background:rgba(25,111,61,0.92); border:1px solid rgba(72,187,120,0.45); border-radius:6px; padding:8px 10px 8px 8px; color:#e6fffa; font-size:12px; display:flex; gap:8px; box-shadow:0 4px 12px rgba(0,0,0,0.35); animation:fadeSlide 0.25s ease; pointer-events:auto;}
  .icon{font-size:16px; line-height:16px;}
  .body{flex:1; display:flex; flex-direction:column; gap:2px;}
  .line{font-weight:600;}
  .target{font-family:'Courier New', monospace; font-size:11px; color:#c6f6d5;}
  .time{font-size:10px; color:#9ae6b4;}
  .close{background:transparent; border:none; color:#fed7d7; cursor:pointer; font-size:12px; align-self:flex-start; padding:0 2px;}
  .close:hover{color:#fff;}
  @keyframes fadeSlide{from{opacity:0; transform:translateY(-6px);} to{opacity:1; transform:translateY(0);} }
</style>