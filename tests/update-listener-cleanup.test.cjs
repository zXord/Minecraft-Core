const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPONENTS = [
  'src/components/common/UpdateChecker.svelte',
  'src/components/common/UpdateNotification.svelte'
];

function readComponent(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function extractEvents(source, method) {
  const regex = new RegExp(`window\\.electron\\.${method}\\(\\s*['"]([^'"]+)['"]`, 'g');
  return Array.from(source.matchAll(regex), match => match[1])
    .filter(eventName => eventName.startsWith('update-'));
}

test('update components remove every update listener they register', () => {
  for (const component of COMPONENTS) {
    const source = readComponent(component);
    const registered = extractEvents(source, 'on');
    const removed = new Set(extractEvents(source, 'removeListener'));

    for (const eventName of registered) {
      assert.equal(
        removed.has(eventName),
        true,
        `${component} registers ${eventName} without removing it`
      );
    }
  }
});

test('update components do not use inline update listener callbacks', () => {
  for (const component of COMPONENTS) {
    const source = readComponent(component);
    assert.doesNotMatch(
      source,
      /window\.electron\.on\(\s*['"]update-[^'"]+['"]\s*,\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      `${component} uses an inline update listener callback that cannot be removed safely`
    );
    assert.doesNotMatch(
      source,
      /window\.electron\.removeListener\(\s*['"]update-[^'"]+['"]\s*,\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      `${component} removes an inline callback instead of the original listener`
    );
  }
});
