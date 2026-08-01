const path = require('node:path');
const { deepFreeze } = require('./errors.cjs');

function createModpackPaths(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath.trim()) throw new TypeError('A userData path is required');
  const root = path.join(path.resolve(userDataPath), 'modpack-lifecycle');
  return deepFreeze({
    root,
    cache: path.join(root, 'cache'),
    selections: path.join(root, 'selections'),
    notifications: path.join(root, 'notifications'),
    recoveryActive: path.join(root, 'active'),
    recoveryHistory: path.join(root, 'history'),
    operations: path.join(root, 'operations'),
    plans: path.join(root, 'plans'),
    workspaces: path.join(root, 'workspaces')
  });
}

module.exports = { createModpackPaths };
