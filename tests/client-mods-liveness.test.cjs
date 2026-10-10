const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
let api;
test.before(() => {
  // Bundle the real utility and real writable stores, without unrelated app startup.
  const source = fs.readFileSync(path.resolve('src/utils/clientMods.ts'), 'utf8')
    .replace(/from '\.\.\/stores\/(?:modStore\.js|clientModManager\.js)'/g, "from 'liveness-stores'")
    .replace(/import logger from '\.\/logger\.js';/, 'const logger = {error(){},debug(){}};');
  const names = ['installedModIds','installedModInfo','serverManagedFiles','successMessage','errorMessage','connectionStatus','serverMods','requiredMods','optionalMods','allClientMods','installedModsInfo','modSyncStatus','isLoadingMods','lastModCheck','acknowledgedDeps','minecraftVersion'];
  const stores = `import {writable} from 'svelte/store';${names.map(n=>`export const ${n}=writable(${/Ids|Files|Deps/.test(n)?'new Set()':/Message|Status|Version/.test(n)?"''":'[]'});`).join('')} export const removeServerManagedFiles=names=>serverManagedFiles.update(s=>new Set([...s].filter(n=>!names.includes(n))));export const updateServerManagedFiles=(action,names)=>serverManagedFiles.update(s=>action==='add'?new Set([...s,...names]):new Set([...s].filter(n=>!names.includes(n))));`;
  // buildSync has no plugins, so use esbuild's virtual stdin and substitute stores in a single module.
  const input = source.replace(/import\s*\{([^}]+)\}\s*from 'liveness-stores';/g,'').replace(/import \{ safeInvoke \} from '\.\/ipcUtils\.js';/, "const safeInvoke=(channel,...args)=>window.electron.invoke(channel,...args);")
    .replace("from './managementAuth.js'", "from './src/utils/managementAuth.js'");
  const result = buildSync({stdin:{contents:stores+'\n'+input+'\nexport {get} from "svelte/store";',resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs'});
  const filename = path.resolve('tests/liveness-bundle.cjs'); const compiled = new Module(filename); compiled.filename = filename; compiled.paths = module.paths; compiled._compile(result.outputFiles[0].text, filename); api = compiled.exports;
});
const cases = [
  ['downloadRequiredMods',[]],['downloadOptionalMods',[]],['downloadSingleRequiredMod',[{fileName:'a.jar'}]],['downloadSingleOptionalMod',[{fileName:'a.jar'}]],
  ['handleModDelete',['a.jar']],['handleServerModRemoval',['a.jar']],['handleBulkServerModRemoval',[['a.jar']]],['handleDependencyAcknowledgment',['a.jar']],['acknowledgeAllDependencies',[]],['handleModToggle',['a.jar',true]],
  ['updateServerMod',[{detail:{fileName:'a.jar',name:'A',currentVersion:'1',newVersion:'2',mod:{required:true}}}]]
];
for (const [method,args] of cases) test(`${method} retires post-operation store/read continuations`, async t => {
  let current = true, release; const calls=[],timers=[];
  const oldWindow=global.window,oldTimer=global.setTimeout;
  global.setTimeout=(fn)=>{timers.push(fn);return 0;};
  global.window={electron:{invoke:async(channel,...args)=>{calls.push([channel,...args]);return calls.length===1?new Promise(resolve=>{release=resolve;}):channel==='get-client-installed-mod-info'?[]:{success:true};}}};
  t.after(()=>{global.window=oldWindow;global.setTimeout=oldTimer;});
  api.requiredMods.set([{fileName:'a.jar',downloadUrl:'/api/mods/download/a.jar',required:true}]);
  api.allClientMods.set([{fileName:'a.jar',downloadUrl:'/api/mods/download/a.jar',required:false}]);
  api.modSyncStatus.set({missingMods:['a.jar'],missingOptionalMods:['a.jar'],acknowledgments:[{fileName:'a.jar'}]});
  api.installedModsInfo.set([{fileName:'a.jar',versionNumber:'1'}]);api.installedModInfo.set([{fileName:'a.jar',projectId:'project'}]);api.installedModIds.set(new Set(['project']));api.serverManagedFiles.set(new Set(['a.jar']));api.acknowledgedDeps.set(new Set());api.successMessage.set('B-success');api.errorMessage.set('B-error');
  const before=JSON.stringify([api.get(api.installedModsInfo),api.get(api.installedModInfo),[...api.get(api.serverManagedFiles)],[...api.get(api.acknowledgedDeps)]]);
  const pending=api[method]({path:'C:/old-a'},...args,{isCurrent:()=>current});
  assert.equal(calls.length,1);current=false;release({success:true,downloaded:1,count:1,removedMods:['a.jar'],downloadedFiles:['new.jar']});await pending;
  for(const timer of timers)await timer();
  assert.equal(calls.length,1);assert.equal(api.get(api.successMessage),'B-success');assert.equal(api.get(api.errorMessage),'B-error');
  assert.equal(JSON.stringify([api.get(api.installedModsInfo),api.get(api.installedModInfo),[...api.get(api.serverManagedFiles)],[...api.get(api.acknowledgedDeps)]]),before);
});
for (const method of ['downloadSingleRequiredMod','downloadSingleOptionalMod']) test(`${method} timer captures original owner and same-client control still refreshes`, async t => {
  let current=true;const calls=[],timers=[];const oldWindow=global.window,oldTimer=global.setTimeout;
  global.setTimeout=(fn,ms)=>{if(ms===1500)timers.push(fn);return 0;};
  global.window={electron:{invoke:async(channel,...args)=>{calls.push([channel,...args]);return channel==='get-client-installed-mod-info'?[]:{success:true};}}};
  t.after(()=>{global.window=oldWindow;global.setTimeout=oldTimer;});
  await api[method]({path:'C:/old-a'},{fileName:'a.jar'},{isCurrent:()=>current});assert.equal(timers.length,1);
  current=false;await timers.shift()();assert.equal(calls.length,1);
  current=true;await api[method]({path:'C:/old-a'},{fileName:'a.jar'},{isCurrent:()=>current});await timers.shift()();
  assert.ok(calls.some(([channel])=>channel==='get-client-installed-mod-info'));assert.ok(calls.some(([channel])=>channel==='minecraft-check-mods'));
});
