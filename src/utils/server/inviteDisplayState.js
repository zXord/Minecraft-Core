export function getInviteDisplayState({
  configured,
  requiresSetup,
  inviteLink = '',
  status = 'idle'
} = {}) {
  const resolvedConfigured = typeof configured === 'boolean'
    ? configured
    : typeof requiresSetup === 'boolean'
      ? !requiresSetup
      : Boolean(inviteLink);

  return {
    configured: resolvedConfigured,
    placeholder: status === 'loading'
      ? 'Loading invite link...'
      : resolvedConfigured
        ? 'Invite link'
        : 'Invite link not set up',
    actionLabel: resolvedConfigured ? 'Regenerate' : 'Set up invite'
  };
}
