const { ModpackError } = require('../errors.cjs');
const { validateModpackIpcEvent } = require('../ipc-schemas.cjs');

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The native modpack notification request is invalid', { cause });
}

class NativeModpackNotificationBridge {
  constructor({ Notification = null, getWindow } = {}) {
    if ((Notification !== null && typeof Notification !== 'function') || typeof getWindow !== 'function') throw invalid();
    this.Notification = Notification;
    this.getWindow = getWindow;
    this.active = new Set();
  }

  start() { return true; }

  publishJobEvent(value) {
    const channel = value?.channel === 'progress'
      ? 'modpacks:job-progress'
      : value?.channel === 'log'
        ? 'modpacks:job-log'
        : null;
    if (!channel) throw invalid();
    const event = validateModpackIpcEvent(channel, value);
    this.#sendChannel(channel, event);
    return event;
  }

  publishStateChanged(value) {
    const event = validateModpackIpcEvent('modpacks:state-changed', value);
    this.#sendChannel('modpacks:state-changed', event);
    return event;
  }

  publish(value) {
    const notification = validateModpackIpcEvent('modpacks:notification', value);
    this.#send(notification);
    if (!this.Notification || (typeof this.Notification.isSupported === 'function' && !this.Notification.isSupported())) {
      return notification;
    }
    try {
      const native = new this.Notification({
        title: notification.title,
        body: notification.message,
        silent: false
      });
      this.active.add(native);
      native.on?.('click', () => {
        const window = this.#window();
        window?.show?.();
        window?.focus?.();
        this.#send(notification);
      });
      native.on?.('close', () => this.active.delete(native));
      native.on?.('failed', () => this.active.delete(native));
      native.show();
    } catch { /* the persistent notification and renderer event remain authoritative */ }
    return notification;
  }

  stop() {
    for (const notification of this.active) {
      try { notification.close?.(); } catch { /* best effort native UI cleanup */ }
    }
    this.active.clear();
  }

  #window() {
    const window = this.getWindow();
    return window && typeof window === 'object' && window.isDestroyed?.() !== true ? window : null;
  }

  #send(notification) {
    this.#sendChannel('modpacks:notification', notification);
  }

  #sendChannel(channel, value) {
    const window = this.#window();
    try { window?.webContents?.send?.(channel, value); } catch { /* persistence remains available */ }
  }
}

module.exports = { NativeModpackNotificationBridge };
