const path = require('node:path');
const { ModpackError, deepFreeze } = require('../services/modpacks/errors.cjs');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail = (code = 'INVALID_REQUEST') => new ModpackError(code, 'The management session request could not be completed');
function validate(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))) throw fail();
  const keys = ['clientInstanceId', 'clientPath', 'reason', 'observedBindingGeneration', 'observedRevision'];
  if (Object.keys(input).some(key => !keys.includes(key)) || !Object.hasOwn(input, 'reason') ||
      Object.hasOwn(input, 'clientInstanceId') === Object.hasOwn(input, 'clientPath')) throw fail();
  if (Object.hasOwn(input, 'clientInstanceId') ? !identifier(input.clientInstanceId) :
      typeof input.clientPath !== 'string' || input.clientPath.length > 32767 || !path.isAbsolute(input.clientPath) || /[\u0000-\u001f\u007f]/u.test(input.clientPath)) throw fail();
  if (input.reason === 'reuse') {
    if (Object.hasOwn(input, 'observedBindingGeneration') || Object.hasOwn(input, 'observedRevision')) throw fail();
  } else if (!['authorization-rejected', 'explicit-reconnect'].includes(input.reason) ||
      !identifier(input.observedBindingGeneration) || !Number.isSafeInteger(input.observedRevision) || input.observedRevision < 0) throw fail();
}
function project(snapshot) {
  if (!snapshot || typeof snapshot.token !== 'string' || !snapshot.token || snapshot.token.length > 16384 || /[\u0000-\u001f\u007f]/u.test(snapshot.token) ||
      !identifier(snapshot.bindingGeneration) || snapshot.binding?.generation !== snapshot.bindingGeneration ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || typeof snapshot.baseOrigin !== 'string') throw fail('CLIENT_PACK_UNAVAILABLE');
  let origin;
  try { origin = new URL(snapshot.baseOrigin); } catch { throw fail('CLIENT_PACK_UNAVAILABLE'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== snapshot.baseOrigin || origin.username || origin.password) throw fail('CLIENT_PACK_UNAVAILABLE');
  return deepFreeze({ sessionToken: snapshot.token, baseOrigin: snapshot.baseOrigin, bindingGeneration: snapshot.bindingGeneration, revision: snapshot.revision });
}
function publicError(error) {
  const code = error instanceof ModpackError && ['INVALID_REQUEST', 'PLAN_STALE', 'CANCELLED', 'CLIENT_PACK_UNAVAILABLE'].includes(error.code)
    ? error.code : 'CLIENT_PACK_UNAVAILABLE';
  return fail(code).toPublicResult();
}
function waitOwned(work, signal) {
  if (signal.aborted) return Promise.reject(fail('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(fail('CANCELLED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw fail('CANCELLED'); return work(); }).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); }
    );
  });
}
function createManagementSessionHandlers({ win, broker, resolveClientByPath } = {}) {
  if (!win?.webContents || typeof broker?.acquire !== 'function' || typeof resolveClientByPath !== 'function') throw fail();
  const owner = win.webContents; const pending = new Set(); let closed = false; let disposal;
  function trusted(event) {
    return !closed && !win.isDestroyed?.() && !owner.isDestroyed?.() && event?.sender === owner &&
      !!owner.mainFrame && event.senderFrame === owner.mainFrame;
  }
  function abortOwned() { closed = true; for (const record of pending) record.controller.abort(fail('CANCELLED')); }
  owner.once('destroyed', abortOwned);
  const handler = (event, input, ...extra) => {
    const record = { controller: new AbortController(), promise: null };
    record.promise = Promise.resolve().then(async () => {
      if (!trusted(event) || extra.length) throw fail(); validate(input); input = { ...input };
      const clientId = Object.hasOwn(input, 'clientInstanceId') ? input.clientInstanceId :
        (await waitOwned(() => resolveClientByPath(input.clientPath), record.controller.signal))?.clientId;
      if (!trusted(event) || record.controller.signal.aborted) throw fail('CANCELLED');
      if (!identifier(clientId)) throw fail();
      const snapshot = await broker.acquire(clientId, { signal: record.controller.signal, reason: input.reason,
        ...(input.reason === 'reuse' ? {} : { observedBindingGeneration: input.observedBindingGeneration, observedRevision: input.observedRevision }) });
      if (!trusted(event) || record.controller.signal.aborted) throw fail('CANCELLED');
      return deepFreeze({ ok: true, value: project(snapshot) });
    }).catch(publicError).finally(() => pending.delete(record));
    pending.add(record); return record.promise;
  };
  function dispose() {
    if (!disposal) { abortOwned(); owner.removeListener('destroyed', abortOwned); disposal = Promise.allSettled([...pending].map(record => record.promise)).then(() => undefined); }
    return disposal;
  }
  return { handlers: { 'management-session:acquire': handler }, dispose };
}
module.exports = { createManagementSessionHandlers };
