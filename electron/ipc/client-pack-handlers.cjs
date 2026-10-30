const { ModpackError, deepFreeze } = require('../services/modpacks/errors.cjs');
const { normalizeCompanionDescriptor } = require('../services/client-modpacks/companion-contracts.cjs');

const CHANNELS = Object.freeze(['get-companion', 'list-companion-assets', 'inspect-companion', 'accept-companion',
  'get-state', 'preview', 'install', 'cancel', 'verify', 'recover'].map(name => `client-packs:${name}`));
const fail = (code = 'INVALID_REQUEST') => new ModpackError(code, 'The matching client pack request could not be completed');
function plain(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))) throw fail();
  return value;
}
function exact(value, keys, required = keys) {
  plain(value);
  if (Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail();
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw fail(); return value; }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fail(); return value; }
function text(value, max = 512) { if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail(); return value; }
function relative(value) {
  text(value, 1024);
  if (/[\\:]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw fail();
  return value;
}
function list(value, map, max = 10000) { if (!Array.isArray(value) || value.length > max) throw fail(); return value.map(map); }
function decimal(value) { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(value)) throw fail(); return value; }
function bool(value) { if (typeof value !== 'boolean') throw fail(); return value; }
function one(value, values) { if (!values.includes(value)) throw fail(); return value; }
function options(value) { return list(value, item => ({id:id(item.id), label:relative(item.label), defaultSelected:one(item.defaultSelected,[true])})); }
function descriptor(value) { return normalizeCompanionDescriptor(value); }
function validateRequest(name, input) {
  const byServer = ['get-companion', 'list-companion-assets'];
  if (byServer.includes(name)) { exact(input, ['serverId']); id(input.serverId); }
  else if (['get-state','verify'].includes(name)) { exact(input,['clientId','requestId'],['clientId']); id(input.clientId); if (input.requestId !== undefined) id(input.requestId); }
  else if (name === 'recover') { exact(input,['clientId']); id(input.clientId); }
  else if (name === 'inspect-companion') {
    exact(input,['serverId','expectedServerFingerprint','assetId','requestId'],['serverId','expectedServerFingerprint','requestId']);
    id(input.serverId); digest(input.expectedServerFingerprint); id(input.requestId); if (input.assetId !== undefined) id(input.assetId);
  } else if (name === 'accept-companion') {
    exact(input,['serverId','expectedServerFingerprint','inspectionId']); id(input.serverId); digest(input.expectedServerFingerprint); id(input.inspectionId);
  } else if (name === 'preview') {
    exact(input,['clientId','optionalFileIds','requestId'],['clientId','requestId']); id(input.clientId); id(input.requestId);
    if (input.optionalFileIds !== undefined) { const ids=list(input.optionalFileIds,id); if (new Set(ids).size !== ids.length) throw fail(); }
  } else if (name === 'install') {
    exact(input,['clientId','planId','conflictChoices','requestId']); id(input.clientId); id(input.planId); id(input.requestId); plain(input.conflictChoices);
    if (Object.keys(input.conflictChoices).length > 10000) throw fail();
    for (const [path, choice] of Object.entries(input.conflictChoices)) { relative(path); one(choice,['preserve','replace']); }
  } else if (name === 'cancel') {
    plain(input);
    if (Object.hasOwn(input,'requestId')) { exact(input,['requestId']); id(input.requestId); }
    else { exact(input,['clientId','operationId']); id(input.clientId); id(input.operationId); }
  } else throw fail();
  return input;
}
function publicValue(name, value) {
  if (['get-companion','accept-companion'].includes(name)) return value === null && name === 'get-companion' ? null : descriptor(value);
  if (name === 'list-companion-assets') return {serverFingerprint:digest(value.serverFingerprint),serverVersion:text(value.serverVersion,128),assets:list(value.assets,a=>({assetId:id(a.assetId),fileName:relative(a.fileName),size:decimal(String(a.size))}),1000)};
  if (name === 'inspect-companion') {
    const fields = Object.fromEntries(['schemaVersion','status','serverFingerprint','serverVersion','source','runtime','artifactSha256'].map(key=>[key,value[key]]));
    return {inspectionId:id(value.inspectionId),...descriptor(fields),name:text(value.name),version:text(value.version,128),optionalFiles:options(value.optionalFiles),downloadBytes:decimal(value.downloadBytes)};
  }
  if (['get-state','verify'].includes(name)) {
    const result={clientId:id(value.clientId),status:one(value.status,['unmanaged','install-required','unpaired','update-required','modified','ready','runtime-incomplete','recovery-required','requirement-unavailable']),verified:bool(value.verified),descriptor:value.descriptor === null ? null : descriptor(value.descriptor)};
    if (value.recoveryReason !== undefined) {
      if (result.status !== 'recovery-required') throw fail();
      result.recoveryReason=one(value.recoveryReason,['restart-required']);
    }
    return result;
  }
  if (name === 'preview') return {clientId:id(value.clientId),planId:id(value.planId),descriptor:descriptor(value.descriptor),optionalFiles:options(value.optionalFiles),optionalFileIds:list(value.optionalFileIds,id),downloadBytes:decimal(value.downloadBytes),
    ...Object.fromEntries(['additions','removals','replacements','preserved'].map(key=>[key,list(value[key],relative,100000)])),
    conflicts:list(value.conflicts,c=>({path:relative(c.path),action:one(c.action,['replace','remove']),reason:one(c.reason,['modified-owned','unowned']),replaceAllowed:bool(c.replaceAllowed)}))};
  if (name === 'install') {
    const result={clientId:id(value.clientId),status:one(value.status,['ready','modified']),verified:bool(value.verified)};
    if (value.cleanup) result.cleanup={status:one(value.cleanup.status,['complete','pending','retained']),...Object.fromEntries(['completed','retained','pending','forgetPending'].map(key=>[key,list(value.cleanup[key],id,256)]))};
    return result;
  }
  if (name === 'recover') return value === null ? null : {phase:one(value.phase,['committed','abandoned']),operationId:id(value.operationId)};
  if (name === 'cancel') return Object.hasOwn(value,'clientId') ? {clientId:id(value.clientId),operationId:id(value.operationId),cancelled:bool(value.cancelled)} : {cancelled:bool(value.cancelled)};
  throw fail();
}
function publicError(error) {
  if (error instanceof ModpackError) return error.toPublicResult();
  if (error?.code === 'CLIENT_RUNNING') return new ModpackError('OPERATION_IN_PROGRESS', 'Close the running Minecraft client before changing its pack').toPublicResult();
  return fail('CLIENT_PACK_UNAVAILABLE').toPublicResult();
}
function scopedValue(name,value,input) {
  const result=publicValue(name,value);
  if (result?.clientId !== undefined && result.clientId !== input.clientId) throw fail('CLIENT_PACK_UNAVAILABLE');
  if (input.expectedServerFingerprint !== undefined && result?.serverFingerprint !== input.expectedServerFingerprint) throw fail('PLAN_STALE');
  return result;
}

function createClientPackHandlers({clientPackService,companionService} = {}) {
  for (const [service,methods] of [[clientPackService,['getState','preview','install','cancel','verify','recover']], [companionService,['getStatus','listAssets','inspect','accept']]]) {
    if (!service || methods.some(method=>typeof service[method] !== 'function')) throw fail();
  }
  const owners=new Map(); const inFlight=new Set(); const cancellationBarriers=new Set(); let closed=false; let disposal;
  function ownerFor(sender) {
    if (!sender || !Number.isSafeInteger(sender.id) || sender.id < 0 || typeof sender.send !== 'function' || typeof sender.once !== 'function' || typeof sender.removeListener !== 'function' || sender.isDestroyed?.()) throw fail();
    let owner=owners.get(sender);
    if (!owner) {
      if (owners.size >= 64) throw fail('OPERATION_IN_PROGRESS');
      owner={sender,records:new Map(),capabilities:new Map(),destroyed:false};
      owner.onDestroyed=()=>{
        owner.destroyed=true;
        for (const record of owner.records.values()) if (!record.settled) void cancelRecord(record).catch(()=>{});
        const pending=[...owner.records.values()].flatMap(record=>[record.promise,record.cancellation]);
        void Promise.allSettled(pending).then(()=>{sender.removeListener('destroyed',owner.onDestroyed);owners.delete(sender);});
      };
      sender.once('destroyed',owner.onDestroyed);owners.set(sender,owner);
    }
    if (owner.destroyed) throw fail(); return owner;
  }
  function resultCancellation(record) {
    if (record.outcome?.ok) return {cancelled:false};
    if (record.outcome?.error?.code === 'CANCELLED') return {cancelled:true};
    throw record.failure || fail('CLIENT_PACK_UNAVAILABLE');
  }
  function cancelRecord(record) {
    if (record.cancellation) return record.cancellation;
    record.controller.abort();
    record.cancellation=(async()=>{
      // Service cancellation is a quiescence barrier, not merely an abort signal.
      const serviceCancel=record.operationId && record.input.clientId && !record.settled
        ? Promise.resolve().then(()=>clientPackService.cancel({clientId:record.input.clientId,operationId:record.operationId})) : null;
      const [serviceResult]=await Promise.allSettled([serviceCancel,record.promise]);
      if (serviceResult.status === 'rejected') {
        // A service may have already removed its settled operation; the recorded
        // outcome is authoritative only for this same sender-owned request.
        if (!(serviceResult.reason?.code === 'INVALID_REQUEST' && record.settled)) throw serviceResult.reason;
      }
      return resultCancellation(record);
    })();
    record.cancellationSettled=false;
    cancellationBarriers.add(record.cancellation);
    const forgetBarrier=()=>{record.cancellationSettled=true;cancellationBarriers.delete(record.cancellation);};
    record.cancellation.then(forgetBarrier,forgetBarrier);
    return record.cancellation;
  }
  function progress(owner, record, event) {
    if (closed || owner.destroyed || record.settled || owner.sender.isDestroyed?.()) return;
    const output={requestId:record.input.requestId,[record.input.clientId?'clientId':'serverId']:record.input.clientId || record.input.serverId};
    const phase=event?.phase ?? event?.activity ?? (event?.setBytes !== undefined ? 'downloading-archive' : undefined);
    if (typeof phase !== 'string' || !/^[a-z-]{1,40}$/.test(phase)) return;
    output.phase=phase;
    if (event.operationId !== undefined) {
      try { id(event.operationId); } catch { return; }
      if (record.operationId && record.operationId !== event.operationId) return;
      record.operationId=event.operationId;output.operationId=event.operationId;
    }
    for (const key of ['completedBytes','totalBytes','completedItems','totalItems']) {
      const value=key === 'completedBytes' ? event.completedBytes ?? event.processedBytes ?? event.setBytes : event[key];
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') continue;
      try { output[key]=decimal(String(value)); } catch { /* Unknown is not zero. */ }
    }
    try { owner.sender.send('client-packs:progress',deepFreeze(output)); } catch { /* Observer only. */ }
  }
  const methods={'get-companion':[companionService,'getStatus'],'list-companion-assets':[companionService,'listAssets'],'inspect-companion':[companionService,'inspect'],'accept-companion':[companionService,'accept'],
    'get-state':[clientPackService,'getState'],preview:[clientPackService,'preview'],install:[clientPackService,'install'],verify:[clientPackService,'verify'],recover:[clientPackService,'recover']};
  async function invoke(name,event,input) {
    if (closed) throw fail('CLIENT_PACK_UNAVAILABLE'); validateRequest(name,input); const owner=ownerFor(event?.sender);
    if (name === 'cancel') {
      const record=input.requestId ? owner.records.get(input.requestId) : [...owner.records.values()].find(r=>r.operationId === input.operationId && r.input.clientId === input.clientId);
      if (!record) throw fail(); const result=await cancelRecord(record);
      return input.requestId ? result : {...input,...result};
    }
    const [service,method]=methods[name];
    if (input.requestId) {
      const existing=owner.records.get(input.requestId);
      if (existing && (!existing.settled || (existing.cancellation && !existing.cancellationSettled))) throw fail('OPERATION_IN_PROGRESS');
      for (const [key,record] of owner.records) if (record.settled && (!record.cancellation || record.cancellationSettled) && (owner.records.size >= 64 || Date.now()-record.finishedAt > 300000)) owner.records.delete(key);
      if (owner.records.size >= 64) throw fail('OPERATION_IN_PROGRESS');
    }
    if (name === 'accept-companion' || name === 'install') {
      const key=name === 'install' ? `plan:${input.planId}` : `inspection:${input.inspectionId}`;
      const cap=owner.capabilities.get(key);
      if (!cap || Date.now()-cap.createdAt >= 900000 || (name === 'install' ? cap.clientId !== input.clientId :
        cap.serverId !== input.serverId || cap.fingerprint !== input.expectedServerFingerprint)) {
        if (name === 'install') throw new ModpackError('INVALID_REQUEST',
          'This installation review is no longer valid. Review matching pack again before installing.');
        throw fail();
      }
      owner.capabilities.delete(key);
    }
    if (!input.requestId) return service[method](input);
    const record={input,controller:new AbortController(),settled:false,operationId:null,promise:null}; owner.records.set(input.requestId,record);
    const {requestId,...request}=input;
    record.promise=Promise.resolve().then(()=>service[method](request,{signal:record.controller.signal,onProgress:event=>progress(owner,record,event)}))
      .then(value=>{
        const result=scopedValue(name,value,input);
        if (name === 'preview' || name === 'inspect-companion') {
          for (const [key,cap] of owner.capabilities) if (Date.now()-cap.createdAt >= 900000) owner.capabilities.delete(key);
          if (owner.capabilities.size >= 16) owner.capabilities.delete(owner.capabilities.keys().next().value);
          const key=name === 'preview' ? `plan:${result.planId}` : `inspection:${result.inspectionId}`;
          owner.capabilities.set(key,{clientId:input.clientId,serverId:input.serverId,fingerprint:input.expectedServerFingerprint,createdAt:Date.now()});
        }
        record.outcome={ok:true};return result;
      }).catch(error=>{record.failure=error;record.outcome=publicError(error);throw error;})
      .finally(()=>{record.settled=true;record.finishedAt=Date.now();});
    return record.promise;
  }
  const handlers=Object.fromEntries(CHANNELS.map(channel=>[channel,(event,input)=>{
    const name=channel.slice('client-packs:'.length);
    const promise=Promise.resolve().then(()=>invoke(name,event,input)).then(value=>deepFreeze({ok:true,value:scopedValue(name,value,input)}),publicError).catch(publicError);
    inFlight.add(promise); promise.finally(()=>inFlight.delete(promise)); return promise;
  }]));
  function dispose() {
    if (disposal) return disposal;closed=true;
    disposal=(async()=>{
      const cancellations=[];
      for (const owner of owners.values()) for (const record of owner.records.values()) if (!record.settled) cancellations.push(cancelRecord(record));
      await Promise.allSettled([...cancellations,...cancellationBarriers,...inFlight]);
      for (const owner of owners.values()) owner.sender.removeListener('destroyed',owner.onDestroyed);
      owners.clear();
    })();return disposal;
  }
  return {handlers,dispose};
}
module.exports={createClientPackHandlers,CLIENT_PACK_INVOKE_CHANNELS:CHANNELS};
