<script>
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import {
    deriveModpackNotificationPresentation,
    modpackNotificationStore
  } from '../../stores/modpackNotificationStore.js';

  export let variant = 'global';
  export let serverId = '';
  export let managed = false;
  export let recoveryCount = 0;
  export let connectStore = true;
  export let open = false;
  export let suppressed = false;
  export let excludeServerId = '';

  const dispatch = createEventDispatcher();
  let actionBusy = '';
  let triggerButton;

  $: presentation = deriveModpackNotificationPresentation({
    items: $modpackNotificationStore.items,
    serverId,
    excludeServerId,
    managed,
    recoveryCount
  });
  $: panelId = `modpack-notifications-${variant}-${sanitizeIdentifier(
    variant === 'contextual' ? serverId || 'current' : excludeServerId ? `excluding-${excludeServerId}` : 'all'
  )}-panel`;
  $: visible = !suppressed && (variant === 'global'
    ? presentation.showGlobalBell
    : presentation.showContextualControl);
  $: if (!visible) open = false;
  $: unreadCount = variant === 'global'
    ? presentation.globalUnreadActionableCount
    : presentation.currentServerUnreadCount;
  $: displayItems = variant === 'contextual'
    ? presentation.currentServerItems
    : presentation.globalItems;
  $: actionError = $modpackNotificationStore.actionError && displayItems.some(
    item => (item.notificationId || item.id) === $modpackNotificationStore.actionError.notificationId
  )
    ? $modpackNotificationStore.actionError
    : null;

  function sanitizeIdentifier(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/gu, '-');
  }

  async function closePanel({ restoreFocus = true } = {}) {
    open = false;
    if (!restoreFocus) return;
    await tick();
    triggerButton?.focus?.();
  }

  function handlePanelKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  }

  function actionLabel(actionId) {
    return ({
      retry: 'Retry',
      'change-selection': 'Change selection',
      'open-details': 'Review details',
      'choose-another-asset': 'Choose asset',
      'return-to-server': 'Return to server',
      'review-restore-point': 'Review restore point',
      'restart-and-recover': 'Recover now',
      'review-recovery': 'Review recovery',
      'restore-from-restore-point': 'Restore from restore point'
    })[actionId] || 'Review';
  }

  async function perform(item) {
    actionBusy = item.notificationId;
    try {
      const outcome = await modpackNotificationStore.performNotificationAction(item);
      if (!outcome.ok || !item.action) return;
      const boundServerId = outcome.result?.destination?.releaseTarget?.serverId || item.serverId;
      dispatch('navigate', {
        serverId: boundServerId,
        notificationId: item.notificationId,
        notificationType: item.type,
        result: outcome.result
      });
      open = false;
    } finally {
      actionBusy = '';
    }
  }

  onMount(() => {
    if (!connectStore) return;
    modpackNotificationStore.connect();
    modpackNotificationStore.listNotifications().catch(() => {});
  });
  onDestroy(() => {
    if (connectStore) modpackNotificationStore.destroy();
  });
</script>

{#if visible}
<div class="notification-host" class:contextual={variant === 'contextual'}>
  <button bind:this={triggerButton} class="notification-button" type="button" aria-label={`Modpack notifications, ${unreadCount} unread`} aria-expanded={open} aria-controls={panelId} on:click={() => (open = !open)} on:keydown={handlePanelKeydown}>
    <span aria-hidden="true">🔔</span>{#if variant === 'contextual'}<span class="notification-label">Notifications</span>{/if}{#if unreadCount}<span class="notification-count">{unreadCount > 99 ? '99+' : unreadCount}</span>{/if}
  </button>

  {#if open}
    <section id={panelId} class="notification-panel" aria-label="Persistent modpack notifications" on:keydown={handlePanelKeydown}>
      <header><div><p>Modpack notifications</p><span>Persistent release, integrity, operation, and recovery history</span></div><button type="button" aria-label="Close notifications" on:click={() => closePanel()}>×</button></header>
      <div class="notification-content">
        {#if actionError}<div class="notification-state action-error" role="alert"><strong>Notification action failed</strong><span>{actionError.error?.message || 'The notification action could not be completed.'}</span><small>{actionError.error?.retryable ? 'Try again when you are ready.' : 'Refresh the notification history before trying again.'}</small></div>{/if}
        {#if $modpackNotificationStore.loading}<div class="notification-state">Loading notifications…</div>{:else if $modpackNotificationStore.error}<div class="notification-state error" role="alert">{$modpackNotificationStore.error.message}</div>{:else if displayItems.length === 0}<div class="notification-state">No modpack notifications yet.</div>{:else}
          <ul>
            {#each displayItems as item (item.notificationId)}
              <li class:unread={!item.read}><button type="button" disabled={actionBusy === item.notificationId} on:click={() => perform(item)}><span class="item-header"><strong>{item.title}</strong><small>{new Date(item.timestamp).toLocaleString()}</small></span><span class="item-message">{item.message}</span><span class="item-footer"><span>{item.source?.provider || 'local'}{item.release?.version ? ` · ${item.release.version}` : ''}</span><b>{item.action ? actionLabel(item.action.actionId) : item.read ? 'Read' : 'Mark read'}</b></span></button></li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  {/if}
</div>
{/if}

<style>
  .notification-host { position: relative; z-index: 1; text-align: left; }
  .notification-button { position: relative; width: 42px; height: 42px; display: grid; place-items: center; padding: 0; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 999px; background: rgba(25, 28, 38, 0.96); color: white; box-shadow: 0 8px 26px rgba(0, 0, 0, 0.3); }
  .contextual .notification-button { width: auto; grid-auto-flow: column; gap: 0.45rem; padding: 0 0.8rem; border-radius: 8px; box-shadow: none; }
  .notification-label { font-size: 0.82rem; font-weight: 650; }
  .notification-count { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 3px; border-radius: 999px; background: #f06464; color: white; font-size: 0.68rem; font-weight: 700; }
  .notification-panel { position: absolute; top: 50px; right: 0; width: min(410px, calc(100vw - 1.5rem)); max-height: min(680px, calc(100vh - 75px)); overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; background: rgba(24, 27, 37, 0.985); box-shadow: 0 18px 45px rgba(0, 0, 0, 0.45); color: rgba(255, 255, 255, 0.92); }
  .notification-content { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.8rem; padding: 1rem; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  header p { margin: 0; font-weight: 700; }
  header span { color: rgba(255, 255, 255, 0.58); font-size: 0.78rem; }
  header button { padding: 0; width: 30px; height: 30px; }
  ul { min-height: 0; flex: 1; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
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
  .notification-state.action-error { display: grid; gap: 0.25rem; padding: 0.75rem 1rem; border-bottom: 1px solid rgba(255, 138, 138, 0.2); background: rgba(255, 102, 102, 0.08); color: #ffb0b0; }
  .notification-state.action-error span { color: rgba(255, 255, 255, 0.78); }
  .notification-state.action-error small { color: rgba(255, 255, 255, 0.58); }
</style>
