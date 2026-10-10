<script>
  import {onMount,onDestroy} from 'svelte';
  import {clientPackApi} from '../../utils/clientPacks/clientPackApi.js';
  export let serverId;
  export let managed = false;
  export let localArchive = false;
  let mounted=false,currentId,currentManaged,generation=0,operation=0,controller;
  let descriptor=null,assets=null,selected='',inspection=null,error=null,busy=false,progress=null;
  $: if (mounted && (serverId !== currentId || managed !== currentManaged)) reset();
  function reset(){currentId=serverId;currentManaged=managed;generation+=1;operation+=1;controller?.abort();descriptor=null;assets=null;selected='';inspection=null;error=null;progress=null;busy=false;if(managed&&serverId)refresh();}
  async function run(action,apply,cancellable=false,channel='Pairing status'){
    const id=serverId,epoch=generation,token=++operation;
    controller?.abort();const owned=cancellable?new AbortController():null;controller=owned;
    const current=()=>mounted&&id===serverId&&epoch===generation&&token===operation;
    busy=true;error=null;progress=cancellable?{phase:'inspecting'}:null;
    try{const value=await action(id,{signal:owned?.signal,current,publish:update=>{if(!current())return false;update();return true;},setChannel:value=>{channel=value;},onProgress:event=>{if(current())progress=event;}});if(current())apply(value);}
    catch(caught){if(current()){
      const code=typeof caught?.code==='string'&&/^[A-Z][A-Z_]{1,47}$/.test(caught.code)?caught.code:'CLIENT_PACK_UNAVAILABLE';
      let guidance='Refresh the companion list and try again.';
      if(code==='PLAN_STALE'||code==='CLIENT_PACK_SERVER_CHANGED'){
        inspection=null;assets=null;selected='';
        guidance=code==='PLAN_STALE'?'The server or verification evidence changed during this request. Refresh the companion list and try again.':"The server's managed mod files differ from the installed pack. Use Modpack Verify and Repair before installing or launching its matching client pack.";
      }else if(code==='SERVER_RUNNING')guidance='Stop the server before accepting this matching client pack. The inspected pack has not been paired.';
      error={channel,code,message:`${channel} failed (${code}). ${guidance}`};
    }}
    finally{if(current()){busy=false;controller=null;progress=null;}}
  }
  function refresh(){
    descriptor=null;assets=null;selected='';inspection=null;
    return run(async(id,{current,publish,setChannel})=>{
      const snapshot=await clientPackApi.getCompanion(id);
      if(!current())return;
      if(!snapshot)throw {code:'CLIENT_PACK_UNAVAILABLE'};
      if(!publish(()=>{descriptor=snapshot;}))return;
      if(!current())return;
      setChannel('Asset discovery');
      const listing=await clientPackApi.listCompanionAssets(id);
      if(!current())return;
      if(listing.serverFingerprint!==snapshot.serverFingerprint)throw {code:'PLAN_STALE'};
      return listing;
    },value=>{assets=value;});
  }
  function inspect(){inspection=null;return run((id,options)=>clientPackApi.inspectCompanion({serverId:id,expectedServerFingerprint:assets.serverFingerprint,assetId:selected},options),value=>{inspection=value;},true,'Pack inspection');}
  function accept(){return run(id=>clientPackApi.acceptCompanion({serverId:id,expectedServerFingerprint:inspection.serverFingerprint,inspectionId:inspection.inspectionId}),value=>{descriptor=value;inspection=null;},false,'Pairing acceptance');}
  function number(value){try{return BigInt(value).toLocaleString();}catch{return 'Unknown';}}
  onMount(()=>{mounted=true;});
  onDestroy(()=>{mounted=false;generation+=1;operation+=1;controller?.abort();});
</script>

{#if managed}
<section class="companion" aria-label="Matching client pack" aria-busy={busy}>
  <p class="eyebrow">Matching client pack</p><h2>{descriptor?.status==='ready'?(assets&&!error?'Paired for this server release':'Saved pairing for this server release'):descriptor?.status==='unpaired'?'Pair a same-release client pack':busy?'Loading pairing status':'Pairing status unavailable'}</h2>
  {#if error}<p role="alert">{error.message}</p>{/if}
  {#if descriptor}<p>Server release {descriptor.serverVersion}</p>{/if}
  {#if descriptor?.status==='ready'&&(!assets||error)}<p>This is the saved pairing snapshot. Current server health is not currently verified; it does not authorize client installation or launch.</p>{/if}
  {#if !descriptor&&!busy}<p>Pairing status could not be loaded. Refresh the companion list to retry.</p>{/if}
  {#if localArchive}<p>Local server archives remain supported. They cannot advertise a downloadable matching client pack; use an official GitHub or Modrinth release for companion pairing.</p>
  {:else if assets}
    {#if assets.assets.length===0}<p>No MRPACK client asset is available for this installed server release. Server installation is unaffected.</p>
    {:else}<fieldset disabled={busy}><legend>MRPACK assets from this exact release</legend>{#each assets.assets as asset (asset.assetId)}<label><input type="radio" name={`companion-${serverId}`} bind:group={selected} value={asset.assetId} on:change={()=>inspection=null}/><span>{asset.fileName}</span><small>{number(asset.size)} bytes</small></label>{/each}</fieldset>
      <button type="button" disabled={busy||!selected} on:click={inspect}>Inspect selected pack</button>
    {/if}
  {/if}
  {#if progress}<div role="status" aria-live="polite"><p>{progress.phase.replaceAll('-',' ')}</p>{#if progress.completedBytes!==undefined}<p>{number(progress.completedBytes)}{progress.totalBytes!==undefined?` / ${number(progress.totalBytes)}`:''} bytes</p>{/if}<progress aria-label="Inspecting client archive"></progress><button type="button" on:click={()=>controller?.abort()}>Cancel request</button></div>{/if}
  {#if inspection}<div class="review"><h3>Review matching runtime</h3><p>{inspection.name} · {inspection.version}</p><p>Minecraft {inspection.runtime.minecraftVersion} · {inspection.runtime.loaderFamily} {inspection.runtime.loaderVersion}</p><p>{number(inspection.downloadBytes)} bytes referenced by the client pack</p><p>This pairs the inspected MRPACK only. Client installation is a separate reviewed action. Stop the server before accepting.</p><button class="primary" type="button" disabled={busy} on:click={accept}>Accept matching client pack</button></div>{/if}
  <button type="button" disabled={busy} on:click={refresh}>Refresh companion list</button>
</section>
{/if}
<style>
  .companion{color:#eeeaf6;background:rgba(20,19,27,.7);padding:1.1rem;border-block:1px solid #393540;line-height:1.5;overflow-wrap:anywhere}.eyebrow{font-size:.76rem;color:#b6acc8;text-transform:uppercase;letter-spacing:.08em;margin:0}h2{font-size:1.2rem;margin:.2rem 0 .7rem}h3{font-size:1.1rem}p{color:#c8c3d1}fieldset{border:0;border-top:1px solid #393540;padding:.65rem 0}label{display:flex;align-items:center;gap:.5rem;padding:.5rem}label:has(input:checked){background:#332d3d}small{color:#b6acc8;margin-left:auto}input{accent-color:#986ad5}button{background:#302d38;color:#eeeaf6;border:1px solid #514b5d;border-radius:6px;padding:.55rem .8rem;cursor:pointer;margin:.4rem .4rem .4rem 0;transition:background .12s}button:hover{background:#403949}button.primary{background:#6d46b0;border-color:#8966c7}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:2px solid #ba95f0;outline-offset:3px}.review{border-top:1px solid #514b5d;margin-top:.8rem}progress{display:block;width:min(100%,28rem);accent-color:#986ad5}[role=alert]{border-left:3px solid #bc8792;padding-left:.7rem;color:#f3d6dc}@media(prefers-reduced-motion:reduce){button{transition:none}}@media(max-width:550px){label{flex-wrap:wrap}small{margin-left:1.5rem}}
</style>
