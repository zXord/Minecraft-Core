const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(path.resolve(
  __dirname,
  '../src/utils/server/inviteDisplayState.js'
)).href;

async function loadDisplayState() {
  try {
    return await import(`${MODULE_URL}?test=${Date.now()}-${Math.random()}`);
  } catch (error) {
    assert.fail(`Invite display-state helper could not be loaded: ${error?.code || error?.message}`);
  }
}

test('invite display state distinguishes missing setup, loading, and an existing invite', async () => {
  const { getInviteDisplayState } = await loadDisplayState();

  const cases = [
    {
      name: 'missing setup',
      input: { configured: false, requiresSetup: true, inviteLink: '', status: 'idle' },
      expected: {
        configured: false,
        placeholder: 'Invite link not set up',
        actionLabel: 'Set up invite'
      }
    },
    {
      name: 'loading',
      input: { configured: false, requiresSetup: true, inviteLink: '', status: 'loading' },
      expected: {
        configured: false,
        placeholder: 'Loading invite link...',
        actionLabel: 'Set up invite'
      }
    },
    {
      name: 'setup-required response without configured flag',
      input: {
        requiresSetup: true,
        inviteLink: 'https://server.example:8080/#secret=stale',
        status: 'idle'
      },
      expected: {
        configured: false,
        placeholder: 'Invite link not set up',
        actionLabel: 'Set up invite'
      }
    },
    {
      name: 'existing invite',
      input: {
        configured: true,
        requiresSetup: false,
        inviteLink: 'https://server.example:8080/#secret=existing',
        status: 'idle'
      },
      expected: {
        configured: true,
        placeholder: 'Invite link',
        actionLabel: 'Regenerate'
      }
    }
  ];

  for (const { name, input, expected } of cases) {
    assert.deepEqual(getInviteDisplayState(input), expected, name);
  }
});

test('invite display state remains compatible with responses that predate setup flags', async () => {
  const { getInviteDisplayState } = await loadDisplayState();

  assert.deepEqual(getInviteDisplayState({
    inviteLink: 'https://server.example:8080/#secret=legacy',
    status: 'idle'
  }), {
    configured: true,
    placeholder: 'Invite link',
    actionLabel: 'Regenerate'
  });
});
