import { writable } from 'svelte/store';
import { modpackApi } from '../utils/modpacks/modpackApi.js';

const NOTIFICATION_HISTORY_LIMIT = 1000;

function notificationIdentity(item) {
  return item?.notificationId || item?.id || '';
}

export function deriveModpackNotificationPresentation({
  items = [],
  serverId = '',
  excludeServerId = '',
  managed = false,
  recoveryCount = 0
} = {}) {
  const notifications = Array.isArray(items) ? items : [];
  const globalItems = excludeServerId
    ? notifications.filter(item => item?.serverId !== excludeServerId)
    : notifications;
  const currentServerItems = serverId
    ? notifications.filter(item => item?.serverId === serverId)
    : [];
  const globalUnreadActionableCount = globalItems.filter(item => !item?.read && item?.action).length;
  const currentServerUnreadCount = managed
    ? currentServerItems.filter(item => !item?.read).length
    : 0;
  return {
    globalItems,
    globalUnreadActionableCount,
    showGlobalBell: globalUnreadActionableCount > 0,
    currentServerItems,
    currentServerUnreadCount,
    showContextualControl: Boolean(managed)
  };
}

export function filterRecoveryRecordsForServer(records, serverId = '') {
  const items = Array.isArray(records) ? records : records?.items || [];
  if (!serverId || !Array.isArray(items)) return [];
  return items.filter(record => record && (
    record.serverId === serverId ||
    record.instanceId === serverId ||
    record.stableServerId === serverId
  ));
}

function createNotificationStore() {
  const initialState = () => ({ items: [], loading: false, error: null, actionError: null });
  const { subscribe, update, set } = writable(initialState());
  let unsubscribe = null;
  let mutationSequence = 0;
  let listRequestSequence = 0;
  let storeEpoch = 0;
  const itemMutationSequences = new Map();

  function recordItemMutation(item) {
    const identity = notificationIdentity(item);
    if (!identity) return;
    mutationSequence += 1;
    itemMutationSequences.set(identity, mutationSequence);
  }

  function mergeListWithNewerMutations(listedItems, currentItems, requestMutationSequence) {
    const newerItems = currentItems.filter(item => {
      const identity = notificationIdentity(item);
      return identity && (itemMutationSequences.get(identity) || 0) > requestMutationSequence;
    });
    const newerIdentities = new Set(newerItems.map(notificationIdentity));
    return [
      ...newerItems,
      ...listedItems.filter(item => !newerIdentities.has(notificationIdentity(item)))
    ];
  }

  async function listNotifications() {
    const requestMutationSequence = mutationSequence;
    const requestSequence = ++listRequestSequence;
    const requestEpoch = storeEpoch;
    update(state => ({ ...state, loading: true, error: null }));
    try {
      const result = await modpackApi.listNotifications({ unreadOnly: false, limit: NOTIFICATION_HISTORY_LIMIT });
      const items = Array.isArray(result) ? result : result?.items || [];
      if (requestEpoch !== storeEpoch || requestSequence !== listRequestSequence) return items;
      update(state => ({
        ...state,
        items: mergeListWithNewerMutations(items, state.items, requestMutationSequence),
        loading: false
      }));
      return items;
    } catch (error) {
      if (requestEpoch === storeEpoch && requestSequence === listRequestSequence) {
        update(state => ({ ...state, loading: false, error }));
      }
      throw error;
    }
  }

  async function ackNotification(notificationId) {
    await modpackApi.ackNotification(notificationId);
    mutationSequence += 1;
    itemMutationSequences.set(notificationId, mutationSequence);
    update(state => ({
      ...state,
      items: state.items.map(item => notificationIdentity(item) === notificationId ? { ...item, read: true } : item)
    }));
  }

  async function performSafeAction(actionId, opaqueRef) {
    return modpackApi.performSafeAction(actionId, opaqueRef);
  }

  async function performNotificationAction(item) {
    const notificationId = notificationIdentity(item);
    update(state => ({ ...state, actionError: null }));
    try {
      const result = item?.action
        ? await performSafeAction(item.action.actionId, item.action.opaqueRef)
        : null;
      if (!item?.read) await ackNotification(notificationId);
      return { ok: true, result };
    } catch (error) {
      update(state => ({
        ...state,
        actionError: { notificationId, error }
      }));
      return { ok: false, error };
    }
  }

  function connect() {
    if (unsubscribe) return;
    unsubscribe = modpackApi.onNotification(notification => {
      if (!notification) return;
      recordItemMutation(notification);
      const identity = notificationIdentity(notification);
      update(state => ({
        ...state,
        items: [notification, ...state.items.filter(item => notificationIdentity(item) !== identity)]
      }));
    });
  }

  function destroy() {
    unsubscribe?.();
    unsubscribe = null;
    storeEpoch += 1;
    listRequestSequence += 1;
    mutationSequence = 0;
    itemMutationSequences.clear();
    set(initialState());
  }

  return {
    subscribe,
    listNotifications,
    ackNotification,
    performSafeAction,
    performNotificationAction,
    connect,
    destroy
  };
}

export const modpackNotificationStore = createNotificationStore();
