import { writable } from 'svelte/store';
import { modpackApi } from '../utils/modpacks/modpackApi.js';

function createNotificationStore() {
  const { subscribe, update, set } = writable({ items: [], loading: false, error: null, open: false });
  let unsubscribe = null;

  async function listNotifications() {
    update(state => ({ ...state, loading: true, error: null }));
    try {
      const result = await modpackApi.listNotifications({ unreadOnly: false, limit: 200 });
      const items = Array.isArray(result) ? result : result?.items || [];
      update(state => ({ ...state, items, loading: false }));
      return items;
    } catch (error) {
      update(state => ({ ...state, loading: false, error }));
      throw error;
    }
  }

  async function ackNotification(notificationId) {
    await modpackApi.ackNotification(notificationId);
    update(state => ({ ...state, items: state.items.map(item => item.id === notificationId || item.notificationId === notificationId ? { ...item, read: true } : item) }));
  }

  async function performSafeAction(actionId, opaqueRef) {
    return modpackApi.performSafeAction(actionId, opaqueRef);
  }

  function connect() {
    if (unsubscribe) return;
    unsubscribe = modpackApi.onNotification(notification => {
      if (!notification) return;
      update(state => ({ ...state, items: [notification, ...state.items.filter(item => (item.id || item.notificationId) !== (notification.id || notification.notificationId))] }));
    });
  }

  function toggle(open) {
    update(state => ({ ...state, open: typeof open === 'boolean' ? open : !state.open }));
  }

  function destroy() {
    unsubscribe?.();
    unsubscribe = null;
    set({ items: [], loading: false, error: null, open: false });
  }

  return { subscribe, listNotifications, ackNotification, performSafeAction, connect, toggle, destroy };
}

export const modpackNotificationStore = createNotificationStore();
