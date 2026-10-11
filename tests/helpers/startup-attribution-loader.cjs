const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

// Replace diagnostics only within these startup-attribution test modules.
// Other dependencies retain normal require behavior; no global loader hooks.
function loadStartupAttributionModule(entryModule, markStartupTrace, recurseDependency) {
  const load = filename => {
    const localRequire = Module.createRequire(filename);
    const module = { exports: {} };
    const wrapper = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
    wrapper(module.exports, request => {
      if (request.endsWith('/startup-trace.cjs')) return { markStartupTrace };
      if (recurseDependency(request)) return load(localRequire.resolve(request));
      return localRequire(request);
    }, module, filename, path.dirname(filename));
    return module.exports;
  };
  return load(entryModule);
}

module.exports = { loadStartupAttributionModule };
