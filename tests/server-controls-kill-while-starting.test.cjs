const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const component = fs.readFileSync(
  path.resolve(__dirname, '../src/components/server/ServerControls.svelte'),
  'utf8'
);

function killButtonDisabledExpression() {
  const match = component.match(/class="btn-compact kill-button"[\s\S]*?disabled=\{([^}]*)\}/u);
  assert.ok(match, 'the Kill button has a disabled expression');
  return match[1].trim();
}

function reactiveExpression(name) {
  const match = component.match(new RegExp(`\\$:\\s*${name}\\s*=\\s*([^;]+);`, 'u'));
  return match ? match[1].trim() : 'undefined';
}

function functionBody(signature) {
  const start = component.indexOf(signature);
  assert.notEqual(start, -1, `${signature} exists`);
  // The body starts after the parameter list, which may hold a `{}` default.
  const open = component.indexOf(') {', start) + 2;
  let depth = 0;
  for (let index = open; index < component.length; index += 1) {
    if (component[index] === '{') depth += 1;
    if (component[index] === '}') depth -= 1;
    if (depth === 0) return component.slice(open, index + 1);
  }
  throw new Error(`${signature} is not closed`);
}

// Evaluates the component's own expressions for one status and backend liveness answer.
function killDisabled(status, serverProcessLive) {
  const canKillServer = new Function('status', 'serverProcessLive', `return (${reactiveExpression('canKillServer')});`)(
    status,
    serverProcessLive
  );
  return new Function('status', 'serverProcessLive', 'canKillServer', `return (${killButtonDisabledExpression()});`)(
    status,
    serverProcessLive,
    canKillServer
  );
}

test('Kill stays available while a live server process is still starting', () => {
  // A modpack server waits in Starting until its crash protection arms, which can take minutes.
  assert.equal(killDisabled('Starting', true), false);
  assert.equal(killDisabled('Error', true), false);
  assert.equal(killDisabled('Running', false), false);
  assert.equal(killDisabled('Running', true), false);
  assert.equal(killDisabled('Stopping', false), false);
  // Before a process exists (Java download, runtime checks) there is nothing to kill.
  assert.equal(killDisabled('Starting', false), true);
  assert.equal(killDisabled('Error', false), true);
  assert.equal(killDisabled('Stopped', false), true);
  assert.equal(killDisabled('Unknown', false), true);
});

test('the live-process flag comes from the backend status and clears when the server stops', () => {
  assert.match(component, /let\s+serverProcessLive\s*=\s*false;/u);
  const update = functionBody('function applyServerProcessLive(');
  assert.match(update, /typeof\s+value\.isRunning\s*===\s*'boolean'/u);
  assert.match(update, /serverProcessLive\s*=\s*value\.isRunning/u);

  const applyStatus = functionBody('function applyServerStatus(');
  assert.match(applyStatus, /normalizedStatus\s*===\s*'Stopped'[\s\S]*serverProcessLive\s*=\s*false/u);
  assert.match(applyStatus, /backendConfirmed\s*===\s*true[\s\S]*applyServerProcessLive\(nextStatus\)/u);

  const checkStatus = functionBody('async function checkServerStatus(');
  assert.match(checkStatus, /applyServerProcessLive\(statusResult\)/u);
});
