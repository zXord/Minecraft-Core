<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { modpackNotificationStore } from '../../stores/modpackNotificationStore.js';

  const dispatch = createEventDispatcher();
  let actionBusy = '';

  $: unreadCount = $modpackNotificationStore.items.filter(item => !item.read).length;

  function actionLabel(actionId) {
    return ({
      retry: 'Retry',
      'change-selection': 'Change selection',
      'open-details': 'Review details',
      'choose-another-asset': 'Choose asset',
      'return-to-server': 'Return to server',
      'review-restore-point': 'Review restore point',
      'restart-and-recover': 'Restart and recover',
      'review-recovery': 'Review recovery',
      'restore-from-restore-point': 'Restore from restore point'
    })[actionId] || 'Review';
  }

  async function acknowledge(item) {
    if (!item.read) await modpackNotificationStore.ackNotification(item.notificationId);
  }

  async function perform(item) {
    if (!item.action) return acknowledge(item);
    actionBusy = item.notificationId;
    try {
      await acknowledge(item);
      const result = await modpackNotificationStore.performSafeAction(item.action.actionId, item.action.opaqueRef);
      dispatch('navigate', {
        serverId: item.serverId,
        notificationId: item.notificationId,
        notificationType: item.type,
        result
      });
      modpackNotificationStore.toggle(false);
    } finally {
      actionBusy = '';
    }
  }

  onMount(() => {
    modpackNotificationStore.connect();
    modpackNotificationStore.listNotifications().catch(() => {});
  });
  onDestroy(() => modpackNotificationStore.destroy());
</script>

<div class="notification-host">
  <button class="notification-button" type="button" aria-label={`Modpack notifications, ${unreadCount} unread`} aria-expanded={$modpackNotificationStore.open} on:click={() => modpackNotificationStore.toggle()}>
    <span aria-hidden="true">🔔</span>{#if unreadCount}<span class="notification-count">{unreadCount > 99 ? '99+' : unreadCount}</span>{/if}
  </button>

  {#if $modpackNotificationStore.open}
    <section class="notification-panel" aria-label="Persistent modpack notifications">
      <header><div><p>Modpack notifications</p><span>Persistent release, integrity, operation, and recovery history</span></div><button type="button" aria-label="Close notifications" on:click={() => modpackNotificationStore.toggle(false)}>×</button></header>
      {#if $modpackNotificationStore.loading}<div class="notification-state">Loading notifications…</div>{:else if $modpackNotificationStore.error}<div class="notification-state error" role="alert">{$modpackNotificationStore.error.message}</div>{:else if $modpackNotificationStore.items.length === 0}<div class="notification-state">No modpack notifications yet.</div>{:else}
        <ul>
          {#each $modpackNotificationStore.items as item (item.notificationId)}
            <li class:unread={!item.read}><button type="button" disabled={actionBusy === item.notificationId} on:click={() => perform(item)}><span class="item-header"><strong>{item.title}</strong><small>{new Date(item.timestamp).toLocaleString()}</small></span><span class="item-message">{item.message}</span><span class="item-footer"><span>{item.source?.provider || 'local'}{item.release?.version ? ` · ${item.release.version}` : ''}</span><b>{item.action ? actionLabel(item.action.actionId) : item.read ? 'Read' : 'Mark read'}</b></span></button></li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .notification-host { position: fixed; top: 0.8rem; right: 0.85rem; z-index: 950; text-align: left; }
  .notification-button { position: relative; width: 42px; height: 42px; display: grid; place-items: center; padding: 0; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 999px; background: rgba(25, 28, 38, 0.96); color: white; box-shadow: 0 8px 26px rgba(0, 0, 0, 0.3); }
  .notification-count { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 3px; border-radius: 999px; background: #f06464; color: white; font-size: 0.68rem; font-weight: 700; }
  .notification-panel { position: absolute; top: 50px; right: 0; width: min(410px, calc(100vw - 1.5rem)); max-height: min(680px, calc(100vh - 75px)); overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; background: rgba(24, 27, 37, 0.985); box-shadow: 0 18px 45px rgba(0, 0, 0, 0.45); color: rgba(255, 255, 255, 0.92); }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.8rem; padding: 1rem; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  header p { margin: 0; font-weight: 700; }
  header span { color: rgba(255, 255, 255, 0.58); font-size: 0.78rem; }
  header button { padding: 0; width: 30px; height: 30px; }
  ul { margin: 0; padding: 0; overflow-y: auto; list-style: none; }
  li { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  li.unread { box-shadow: inset 3px 0 #7c83ff; background: rgba(124, 131, 255, 0.07); }
  li > button { width: 100%; display: grid; gap: 0.45rem; padding: 0.85rem 1rem; border: 0; border-radius: 0; background: transparent; color: inherit; text-align: left; font: inherit; }
  li > button:hover, li > button:focus-visible { background: rgba(255, 255, 255, 0.06); }
  .item-header, .item-footer { display: flex; justify-content: space-between; gap: 0.6rem; }
  .item-header small, .item-footer { color: rgba(255, 255, 255, 0.55); font-size: 0.74rem; }
  .item-footer b { color: #bfc2ff; }
  .item-message { color: rgba(255, 255, 255, 0.72); line-height: 1.45; }
  .notification-state { padding: 1.4rem; color: rgba(255, 255, 255, 0.65); }
  .notification-state.error { color: #ff8a8a; }
</style>
