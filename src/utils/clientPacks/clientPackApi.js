export class ClientPackApiError extends Error {
  constructor(error = {}) {
    super(error.message || 'Matching client pack is unavailable. Refresh and try again.');
    this.name = 'ClientPackApiError';
    this.code = error.code || 'CLIENT_PACK_UNAVAILABLE';
    this.retryable = error.retryable === true;
  }
}

function bridge() {
  if (!globalThis.window?.electron?.invoke) throw new ClientPackApiError();
  return window.electron;
}
function unwrap(result) {
  if (result?.ok !== true) throw new ClientPackApiError(result?.error);
  return result.value;
}
async function invoke(name, request) {
  return unwrap(await bridge().invoke(`client-packs:${name}`, request));
}
let sequence = 0;
async function request(name, input, { signal, onProgress } = {}) {
  if (signal?.aborted) throw new ClientPackApiError({ code: 'CANCELLED', message: 'The request was cancelled.' });
  const electron = bridge();
  const requestId = `client-pack-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${++sequence}`}`;
  const scopeKey = input.clientId ? 'clientId' : 'serverId';
  let cancellation;
  const cancel = () => {
    cancellation ||= invoke('cancel', { requestId });
    // A rejected cancellation is retained for the owner to observe below.
    cancellation.catch(() => {});
  };
  const progress = event => {
    if (event?.requestId !== requestId || event?.[scopeKey] !== input[scopeKey] || signal?.aborted) return;
    const measured = {...event};
    for (const key of ['completedBytes','totalBytes','completedItems','totalItems']) {
      if (typeof measured[key] !== 'string' || !/^\d{1,30}$/.test(measured[key])) delete measured[key];
    }
    onProgress?.(measured);
  };
  if (onProgress) electron.on('client-packs:progress', progress);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const pending = electron.invoke(`client-packs:${name}`, { ...input, requestId });
    if (signal?.aborted) cancel();
    const result = await pending;
    if (cancellation) await cancellation;
    // Late publication may succeed. Never invent cancelled after main reports success.
    return unwrap(result);
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (onProgress) electron.removeListener('client-packs:progress', progress);
  }
}
export function allowsLegacyClient(state) { return state?.status === 'unmanaged'; }
export const clientPackApi = Object.freeze({
  getCompanion: serverId => invoke('get-companion', { serverId }),
  listCompanionAssets: serverId => invoke('list-companion-assets', { serverId }),
  inspectCompanion: (input, options) => request('inspect-companion', input, options),
  acceptCompanion: input => invoke('accept-companion', input),
  getState: clientId => invoke('get-state', { clientId }),
  preview: (input, options) => request('preview', input, options),
  install: (input, options) => request('install', input, options),
  verify: clientId => invoke('verify', { clientId }),
  recover: clientId => invoke('recover', { clientId })
});
