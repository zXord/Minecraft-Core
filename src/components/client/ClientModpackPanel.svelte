<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { clientPackApi } from '../../utils/clientPacks/clientPackApi.js';
  export let clientId;
  export let destinationLabel = '';
  const dispatch = createEventDispatcher();
  let mounted = false;
  let currentId;
  let generation = 0;
  let operation = 0;
  let controller;
  let state = null;
  let plan = null;
  let choices = {};
  let progress = null;
  let busy = false;
  let error = null;
  let cleanupNotice = null;
  const statuses = new Set(['unmanaged','install-required','unpaired','update-required','modified','ready','runtime-incomplete','recovery-required']);
  const labels = {
    'install-required':'Matching pack installation required', unpaired:'No matching client pack paired',
    'update-required':'Matching pack update required', modified:'Matching pack files modified', ready:'Matching pack ready',
    'runtime-incomplete':'Matching runtime incomplete', 'recovery-required':'Matching pack recovery required'
  };
  $: if (mounted && clientId !== currentId) switchClient();
  $: canInstall = !!plan && !busy && plan.conflicts.every(item => choices[item.path] === 'preserve' || (choices[item.path] === 'replace' && item.replaceAllowed));
  function number(value) { try { return BigInt(value).toLocaleString(); } catch { return 'Unknown'; } }
  function switchClient() {
    currentId = clientId;
    generation += 1;
    operation += 1;
    controller?.abort(); controller = null;
    state = null; plan = null; choices = {}; progress = null; error = null; cleanupNotice = null; busy = false;
    dispatch('state', {clientId, status:'loading'});
    if (clientId) refresh();
  }
  async function run(action, apply, cancellable = false, refreshOnError = false) {
    const id = clientId, epoch = generation, token = ++operation;
    controller?.abort();
    const ownedController = cancellable ? new AbortController() : null;
    controller = ownedController;
    const current = () => mounted && clientId === id && epoch === generation && token === operation;
    busy = true; error = null; progress = cancellable ? {phase:'preparing'} : null;
    try {
      const result = await action(id, {signal:ownedController?.signal,onProgress:event => {if (current()) progress=event;}});
      if (current()) apply(result);
    } catch (caught) {
      if (!current()) return;
      if (caught.code === 'PLAN_STALE') {
        plan = null; choices = {};
        error = {message:'The server requirement or client files changed. Refresh the requirement and review a fresh plan before installing. Review a fresh plan; nothing will be retried automatically.'};
        state = {...state,status:'update-required',verified:false};
        dispatch('state', state);
        try {
          const fresh = await clientPackApi.getState(id);
          if (current()) applyState(fresh);
        } catch {
          if (current()) applyState({clientId:id,status:'unavailable',verified:false});
        }
      } else {
        error = caught;
        if (!state) applyState({clientId:id,status:'unavailable',verified:false});
        if (caught.code === 'RECOVERY_REQUIRED' || refreshOnError) {
          plan=null; choices={};
          try {
            const fresh=await clientPackApi.getState(id);
            if(current()) applyState(fresh);
          } catch {
            if(current()) applyState({clientId:id,status:'unavailable',verified:false});
          }
        }
      }
    } finally {
      if (current()) {busy=false; progress=null; controller=null;}
    }
  }
  function applyState(value) {
    state = statuses.has(value?.status) ? value : {clientId,status:'unavailable',verified:false};
    dispatch('state', state);
  }
  export function refresh() {
    plan=null; choices={}; state=null;
    dispatch('state',{clientId,status:'loading'});
    return run(id => clientPackApi.getState(id), applyState);
  }
  export function checkRequirement() { if (!busy && !plan) return refresh(); }
  function preview(optionalFileIds) {
    plan = null; choices = {};
    return run((id,options) => clientPackApi.preview({clientId:id,...(optionalFileIds === undefined ? {} : {optionalFileIds})},options), value => {plan=value;},true);
  }
  function changeOptional(id, selected) {
    const next = new Set(plan.optionalFileIds);
    if (selected) next.add(id); else next.delete(id);
    preview([...next]);
  }
  function install() {
    const reviewed = plan;
    const reviewedChoices = {...choices};
    plan = null;
    return run((id,options) => clientPackApi.install({clientId:id,planId:reviewed.planId,conflictChoices:reviewedChoices},options), value => {
      if (['complete','retained','pending'].includes(value.cleanup?.status)) cleanupNotice = value.cleanup.status === 'complete' ? null : value.cleanup.status;
      applyState({...state,...value});
    },true);
  }
  function verify() {return run(id => clientPackApi.verify(id), applyState);}
  function recover() {
    return run(async id => {await clientPackApi.recover(id);return clientPackApi.getState(id);},applyState,false,true);
  }
  onMount(() => {mounted=true;});
  onDestroy(() => {mounted=false;generation+=1;operation+=1;controller?.abort();});
</script>

{#if state?.status !== 'unmanaged'}
<section class="matching-pack" aria-label="Matching client modpack" aria-busy={busy}>
  <header><p class="eyebrow">Matching client pack</p><h2>{state ? labels[state.status] || 'Matching pack unavailable' : 'Checking matching pack…'}</h2></header>
  {#if error}<p role="alert">{error.message}</p>{/if}
  {#if cleanupNotice}<div role="status" aria-label="Installation cleanup" aria-live="polite">
    <p>Installation cleanup {cleanupNotice}: cleanup is incomplete. Previous transaction directories or cleanup records may remain safely retained. No automatic deletion is promised.</p>
    {#if state?.status === 'ready' && state?.verified}<p>The matching pack remains verified and ready to launch.</p>{:else}<p>This notice does not change the matching pack verification result.</p>{/if}
  </div>{/if}
  {#if state?.descriptor}<p>Server release {state.descriptor.serverVersion}</p>{/if}
  {#if state?.status === 'unpaired'}
    <p>Ask the server owner to pair the same-release MRPACK or MultiMC ZIP in the server’s Modpack overview. GitHub supports both; Modrinth supports MRPACK only. Loose-mod synchronization is disabled for this managed server.</p>
  {:else if state?.status === 'unavailable'}
    <p>The server requirement could not be classified. Content changes and launch stay blocked until it can be checked.</p>
  {:else if state?.status === 'ready'}
    <p>The matching pack is verified. Sign in with Microsoft and use the normal launch action.</p>
  {:else if state?.status === 'modified'}
    <p>Managed files differ from the reviewed pack. Review conflicts before restoring; preserved divergent mods cannot be called ready.</p>
  {:else if state?.status === 'runtime-incomplete'}
    <p>The exact managed runtime is incomplete. Review the matching installation; no alternate runtime will be chosen.</p>
  {:else if state?.status === 'recovery-required'}
    <p>An interrupted publication must be recovered before content changes or launch.</p>
    {#if state.recoveryReason === 'restart-required'}<p>Save your work, restart Windows, then reopen Minecraft Core and retry recovery. The app will not restart Windows for you.</p>{/if}
  {/if}
  {#if progress}
    <div role="status" aria-live="polite"><strong>{progress.phase.replaceAll('-',' ')}</strong>
      {#if progress.completedBytes !== undefined}<p>{number(progress.completedBytes)}{progress.totalBytes !== undefined ? ` / ${number(progress.totalBytes)}` : ''} bytes</p>{/if}
      {#if progress.completedItems !== undefined}<p>{number(progress.completedItems)}{progress.totalItems !== undefined ? ` / ${number(progress.totalItems)}` : ''} files</p>{/if}
      {#if progress.totalBytes !== undefined && Number(progress.totalBytes)>0 && progress.completedBytes !== undefined}<progress aria-label="Measured download progress" max={Number(progress.totalBytes)} value={Number(progress.completedBytes)}></progress>{:else}<progress aria-label="Working; total unknown"></progress>{/if}
      {#if controller}<button type="button" on:click={() => controller?.abort()}>Cancel request</button>{/if}
    </div>
  {/if}
  {#if plan}
    <div class="review"><h3>Review installation</h3><p>Destination: <strong>{destinationLabel || 'Selected existing client instance'}</strong></p>
      <p>Server release {plan.descriptor.serverVersion} · Minecraft {plan.descriptor.runtime.minecraftVersion} · {plan.descriptor.runtime.loaderFamily} {plan.descriptor.runtime.loaderVersion}</p>
      <p>Additional pack-file downloads: {number(plan.downloadBytes)} bytes</p>
      {#if plan.downloadBytes==='0'}<p>Bundled content still needs installation.</p>{/if}
      <p>Archive acquisition and Minecraft/loader runtime preparation are separate costs, not included in additional pack-file downloads.</p>
      <p>Minecraft Core prepares the declared Minecraft/loader runtime. Launcher commands and settings are not imported.</p>
      {#if plan.optionalFiles.length}<fieldset><legend>Optional client files</legend>{#each plan.optionalFiles as item (item.id)}<label><input type="checkbox" checked={plan.optionalFileIds.includes(item.id)} disabled={busy} on:change={event => changeOptional(item.id,event.currentTarget.checked)} />{item.label}</label>{/each}</fieldset>{/if}
      {#each [['Additions',plan.additions],['Removals',plan.removals],['Replacements',plan.replacements],['Preserved files',plan.preserved]] as [title, files]}
        {#if files.length}<details class="file-changes"><summary>{title} ({files.length})</summary><div class="file-scroll-region" role="region" aria-label={`${title} file list`}><ul>{#each files as file}<li>{file}</li>{/each}</ul></div></details>
        {:else}<p>{title} (0)</p>{/if}
      {/each}
      {#if plan.conflicts.length}<h4>Conflicts — choose for every file</h4>{#each plan.conflicts as item (item.path)}<fieldset><legend>{item.path} · {item.reason.replaceAll('-',' ')} ({item.action})</legend>
        <label><input type="radio" name={`conflict-${clientId}-${item.path}`} checked={choices[item.path]==='preserve'} on:change={() => choices={...choices,[item.path]:'preserve'}} aria-label={`Preserve ${item.path}`} />Preserve</label>
        <label><input type="radio" name={`conflict-${clientId}-${item.path}`} disabled={!item.replaceAllowed} checked={choices[item.path]==='replace'} on:change={() => choices={...choices,[item.path]:'replace'}} aria-label={`Replace ${item.path}`} />Replace{!item.replaceAllowed ? ' — protected from replacement' : ''}</label>
      </fieldset>{/each}{/if}
      <p>Personal settings, saved servers, saves and authentication remain preserved.</p>
      <button class="primary" type="button" disabled={!canInstall} on:click={install}>Install reviewed pack</button>
    </div>
  {/if}
  <footer>
    {#if ['install-required','update-required','modified','runtime-incomplete'].includes(state?.status) && !plan}<button class="primary" type="button" disabled={busy} on:click={() => preview()}>Review matching pack</button>{/if}
    {#if state?.status === 'recovery-required'}<button class="primary" type="button" disabled={busy} on:click={recover}>Retry recovery</button>{/if}
    {#if state?.status === 'ready' || state?.status === 'modified'}<button type="button" disabled={busy} on:click={verify}>Verify matching pack</button>{/if}
    <button type="button" disabled={busy} on:click={refresh}>Refresh requirement</button>
  </footer>
</section>
{/if}

<style>
  .file-changes{margin:.5rem 0}.file-changes summary{cursor:pointer;padding:.25rem 0}.file-scroll-region{max-height:14rem;overflow:auto;overscroll-behavior:contain}.file-changes summary:focus-visible,.file-scroll-region:focus-visible{outline:2px solid #ba95f0;outline-offset:3px}
  .matching-pack{color:#eeeaf6;background:rgba(20,19,27,.7);padding:1.1rem;border-block:1px solid #393540;line-height:1.5;overflow-wrap:anywhere}.eyebrow{font-size:.76rem;color:#b6acc8;text-transform:uppercase;letter-spacing:.08em;margin:0}h2{font-size:1.2rem;margin:.2rem 0 .7rem}h3{font-size:1.1rem}h4{margin:.9rem 0 .2rem}p{color:#c8c3d1;margin:.5rem 0}footer{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}button{background:#302d38;color:#eeeaf6;border:1px solid #514b5d;border-radius:6px;padding:.55rem .8rem;cursor:pointer;transition:background .12s}button:hover{background:#403949}button.primary{background:#6d46b0;border-color:#8966c7}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:2px solid #ba95f0;outline-offset:3px}fieldset{border:0;border-top:1px solid #393540;padding:.65rem 0;margin:.5rem 0}label{display:flex;align-items:center;gap:.5rem;margin:.35rem 0}input{accent-color:#986ad5}ul{margin:.2rem 0;padding-left:1.2rem}.review{border-top:1px solid #514b5d;margin-top:1rem}progress{display:block;width:min(100%,28rem);margin:.6rem 0;accent-color:#986ad5}[role=alert]{border-left:3px solid #bc8792;padding-left:.7rem;color:#f3d6dc}@media(prefers-reduced-motion:reduce){button{transition:none}}
</style>
