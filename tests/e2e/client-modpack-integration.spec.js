import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {compile,compileModule} from 'svelte/compiler';

let bundle;
test.beforeAll(async()=>{
  const root=process.cwd();
  const fixture=`<script>
    import Interface from './src/components/client/ClientInterface.svelte';
    import Settings from './src/components/client/SettingsTab.svelte';
    import Setup from './src/components/client/ClientSetupWizard.svelte';
    import ModpackPage from './src/routes/ModpackPage.svelte';
    import Manager from './src/components/client/ClientModManager.svelte';
    import {clientState,setActiveTab} from './src/stores/clientStore.js';
    import {requiredMods as managedRequiredMods,modSyncStatus,installedModsInfo} from './src/stores/clientModManager.js';
    import {downloadSingleOptionalMod} from './src/utils/clientMods.js';
    let kind='interface'; let props={};
    let instance={id:'registered-a',path:'C:/fixture/client-a',name:'Fixture client',type:'client',serverIp:'server.test',serverPort:'8080',serverProtocol:'https',sessionToken:'fixture-only',clientId:'management-a'};
    export function show(nextKind,nextProps={}) {kind=nextKind;props=nextProps;}
    export function switchInstance(id) {instance={...instance,id,path:'C:/fixture/'+id};}
    export function authority(host) {instance={...instance,serverIp:host};}
    export function currentInstance() {return {...instance};}
    export function status() {return $clientState.minecraftServerStatus;}
    export function requiredNames() {return $managedRequiredMods.map(item=>item.fileName);}
    export function seedDownload() {managedRequiredMods.set([{fileName:'fixture.jar',name:'Fixture mod',required:true,downloadUrl:'/api/mods/download/fixture.jar'}]);modSyncStatus.set({synchronized:false,missingMods:['fixture.jar'],needsDownload:1});}
    export function installedNames() {return $installedModsInfo.map(item=>item.fileName);}
    export function downloadMod() {return downloadSingleOptionalMod(instance,{fileName:'fixture.jar',downloadUrl:'/api/mods/download/fixture.jar'});}
    export function tab(value){setActiveTab(value);}
  </script>
  {#if kind==='interface'}<Interface {instance}/>{:else if kind==='manager'}<Manager {instance}/>{:else if kind==='setup'}<Setup/>{:else if kind==='server'}<ModpackPage currentInstance={{id:'server-fixture',type:'server'}}/>{:else}<Settings {instance} {...props}/>{/if}`;
  const result=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`import Fixture from 'integration-fixture';import {mount,flushSync} from 'svelte';const fixture=mount(Fixture,{target:document.querySelector('#fixture')});window.fixture={show:(...args)=>flushSync(()=>fixture.show(...args)),switchInstance:id=>flushSync(()=>fixture.switchInstance(id)),authority:host=>flushSync(()=>fixture.authority(host)),currentInstance:()=>fixture.currentInstance(),status:()=>fixture.status(),requiredNames:()=>fixture.requiredNames(),seedDownload:()=>flushSync(()=>fixture.seedDownload()),installedNames:()=>fixture.installedNames(),downloadMod:()=>fixture.downloadMod(),tab:value=>flushSync(()=>fixture.tab(value))};`},bundle:true,write:false,platform:'browser',format:'iife',conditions:['browser','svelte'],loader:{'.svg':'dataurl','.png':'dataurl'},plugins:[{name:'real-client-integration',setup(builder){
    builder.onResolve({filter:/^integration-fixture$/},()=>({path:'IntegrationFixture.svelte',namespace:'fixture'}));
    builder.onLoad({filter:/./,namespace:'fixture'},()=>({contents:compile(fixture,{filename:path.join(root,'IntegrationFixture.svelte'),generate:'client',css:'injected'}).js.code,resolveDir:root}));
    builder.onLoad({filter:/\.svelte$/},async({path:filename})=>({contents:compile(await fs.readFile(filename,'utf8'),{filename,generate:'client',css:'injected'}).js.code,resolveDir:path.dirname(filename)}));
    builder.onLoad({filter:/\.svelte\.js$/},async({path:filename})=>({contents:compileModule(await fs.readFile(filename,'utf8'),{filename,generate:'client'}).js.code,resolveDir:path.dirname(filename)}));
  }}]});bundle=result.outputFiles[0].text;
});
async function start(page,status='unpaired',authenticated=true,options={}){
  await page.route('**/*',route=>route.request().url()==='http://client-pack-fixture.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><style>body{background:#15151c;color:white;--content-area-width:900px}</style><div id="fixture"></div>'}):route.abort());
  await page.goto('http://client-pack-fixture.test/');
  await page.evaluate(({status,authenticated,options})=>{
    window.calls=[];window.listeners=new Map();window.classification=status;window.authenticated=authenticated;
    window.pendingStates=[];window.deferState=false;
    window.pendingAuth=[];window.deferAuth=false;
    window.serverManaged=true;window.serverProvider='github';
    window.legacyClientNeeded=options.legacyClientNeeded===true;
    window.fetches=[];window.sessionRevision=4;window.pendingSessions=[];window.deferSessions=false;window.running=false;
    window.rejectOnce=new Set(options.rejectOnce||[]);
    window.deferredInfo=()=>{let cancelled=false;return new Response(new ReadableStream({start(controller){window.pendingInfo.push(payload=>{if(!cancelled){controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));controller.close();}});},cancel(){cancelled=true;}}));};
    window.fetch=async(url,request={})=>{
      const pathname=new URL(url).pathname;
      window.fetches.push({url,pathname,headers:{...request.headers},redirect:request.redirect});
      if(window.rejectOnce.delete(pathname))return new Response('{}',{status:401});
      const payload=pathname==='/api/app/version'?{success:true,appVersion:'26.6.1'}:pathname==='/api/server/info'?{success:true,instanceId:'server-fixture',minecraftVersion:'1.20.1',loaderType:'forge',loaderVersion:'47.3.12',requiredMods:[],allClientMods:[],minecraftServerStatus:window.running?'running':'stopped'}:pathname==='/api/server/status'?{success:true,isRunning:window.running}:pathname==='/api/mods/list'?{success:true,mods:{client:[],server:[]}}:{success:true,items:[]};
      return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});
    };
    window.electron={on:(channel,fn)=>{if(!window.listeners.has(channel))window.listeners.set(channel,new Set());window.listeners.get(channel).add(fn);},removeListener:(channel,fn)=>window.listeners.get(channel)?.delete(fn),removeAllListeners:channel=>window.listeners.delete(channel),invoke:async(channel,...args)=>{
      window.calls.push({channel,args});
      if(channel==='management-session:acquire'){
        const request=args[0];
        if(request.reason!=='reuse')window.sessionRevision++;
        const result={ok:true,value:{sessionToken:`memory-${window.sessionRevision}`,baseOrigin:'https://server.test:8080',bindingGeneration:`binding-${request.clientInstanceId||'path'}`,revision:window.sessionRevision,registrationAttempted:false}};
        if(window.deferSessions)return new Promise(resolve=>window.pendingSessions.push({resolve,result}));
        return result;
      }
      if(channel==='client-packs:get-state'){
        const value={clientId:args[0].clientId,status:window.classification,verified:window.classification==='ready',descriptor:null};
        if(window.deferState)return new Promise(resolve=>window.pendingStates.push({resolve,value}));
        return {ok:true,value};
      }
      if(channel==='modpacks:get-state')return {ok:true,value:{modpackManaged:window.serverManaged,lifecycleMode:window.serverManaged?'managed':'unmanaged',source:{provider:window.serverProvider,title:'Fixture server pack',version:'0.13.4',releaseId:'2'},runtime:{minecraftVersion:'1.20.1',loaderFamily:'forge',loaderVersion:'47.3.12',javaMajor:17,os:'win32',architecture:'x64'}}};
      if(channel==='modpacks:list-history')return {ok:true,value:{items:[],nextCursor:null}};
      if(channel==='modpacks:get-active-jobs')return {ok:true,value:{serverId:args[0].serverId,items:[]}};
      if(channel==='modpacks:list-recovery')return {ok:true,value:[]};
      if(channel==='modpacks:list-notifications')return {ok:true,value:[]};
      if(channel==='client-packs:get-companion')return {ok:true,value:{schemaVersion:1,status:'unpaired',serverFingerprint:'f'.repeat(64),serverVersion:'0.13.4',source:null,runtime:null,artifactSha256:null}};
      if(channel==='client-packs:list-companion-assets')return {ok:true,value:{serverFingerprint:'f'.repeat(64),serverVersion:'0.13.4',assets:window.serverProvider==='local'?[]:[{assetId:'3',fileName:'fixture-0.13.4.mrpack',size:'2048'}]}};
      if(channel==='get-current-version')return {success:true,version:'26.6.1'};
      if(channel==='minecraft-load-auth')return {success:window.authenticated,username:'Fixture',uuid:'controlled-test-only'};
      if(channel==='minecraft-auth'&&window.deferAuth)return new Promise(resolve=>window.pendingAuth.push(resolve));
      if(channel==='minecraft-check-refresh-auth')return {success:true};
      if(channel==='minecraft-get-status')return {isRunning:false,isLaunching:false};
      if(channel==='get-staged-specific-version-update')return null;
      if(channel==='get-download-preferences')return {primarySource:'modrinth',fallbackSource:'server'};
      if(channel==='load-expected-mod-state')return {success:true,requiredMods:[],optionalMods:[]};
      if(channel==='minecraft-check-mods')return {success:true,synchronized:true,missingMods:[],outdatedMods:[],requiredRemovals:[],optionalRemovals:[]};
      if(channel==='minecraft-check-client')return {success:true,synchronized:!window.legacyClientNeeded,version:'1.20.1',loaderType:'forge',loaderVersion:'47.3.12'};
      if(channel==='minecraft-launch')return {success:true};
      if(channel==='select-folder')return 'C:/fixture/new-client';
      if(channel==='read-client-config')return {success:false};
      if(channel==='get-client-installed-mod-info')return [];
      return {success:true,acknowledged:[],mods:[],shaders:[],resourcepacks:[],accounts:[]};
    }};
  },{status,authenticated,options});
  await page.addScriptTag({content:bundle});
}
const forbidden=['minecraft-check-mods','minecraft-check-client','minecraft-download-client','minecraft-download-mods','minecraft-download-assets','minecraft-clear-client','minecraft-clear-client-full','load-expected-mod-state','get-client-installed-mod-info'];
test('session recovery: public probes omit tokens and protected readers pair broker origin/token with blocked redirects',async({page})=>{
  await start(page,'unmanaged');
  await expect.poll(()=>page.evaluate(()=>window.fetches.some(item=>item.pathname==='/api/mods/list'))).toBe(true);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(()=>page.evaluate(()=>window.fetches.some(item=>item.pathname==='/api/server/status'))).toBe(true);
  const requests=await page.evaluate(()=>window.fetches);
  expect(requests.filter(item=>item.pathname==='/api/test').every(item=>!item.headers['X-Session-Token'])).toBe(true);
  const protectedReads=requests.filter(item=>item.pathname!=='/api/test');
  expect(protectedReads.length).toBeGreaterThan(3);
  expect(protectedReads.every(item=>item.headers['X-Session-Token']==='memory-4'&&item.redirect==='error'&&new URL(item.url).origin==='https://server.test:8080')).toBe(true);
  expect(await page.evaluate(()=>window.fixture.currentInstance().sessionToken)).toBe('fixture-only');
  expect(await page.evaluate(()=>window.calls.filter(item=>['save-client-config','save-instances'].includes(item.channel)))).toEqual([]);
});
test('session recovery: renderer one-shot content IPC carries no mounted management credentials',async({page})=>{
  await start(page,'unmanaged');
  await page.evaluate(()=>window.fixture.show('settings'));
  await page.evaluate(()=>window.fixture.downloadMod());
  const dispatches=await page.evaluate(()=>window.calls.filter(item=>item.channel==='minecraft-download-mods'));
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0].args[0]).not.toHaveProperty('serverInfo');
});
test('session recovery: protected immediate status recovers after idle and renders running without sidebar reconnect',async({page})=>{
  await start(page,'unpaired');
  await expect(page.getByText('A Minecraft Server',{exact:true})).toBeVisible();
  await page.evaluate(()=>{window.fetches=[];window.running=true;window.rejectOnce.add('/api/server/status');document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>page.evaluate(()=>window.fixture.status())).toBe('running');
  const status=await page.evaluate(()=>window.fetches.filter(item=>item.pathname==='/api/server/status'));
  expect(status.length).toBeGreaterThanOrEqual(2);
  expect(status[0].headers['X-Session-Token']).toBe('memory-4');
  expect(status[1].headers['X-Session-Token']).toBe('memory-5');
  const recovery=await page.evaluate(()=>window.calls.filter(item=>item.channel==='management-session:acquire'&&item.args[0].reason==='authorization-rejected'));
  expect(recovery).toHaveLength(1);
  expect(recovery[0].args[0]).toEqual({clientInstanceId:'registered-a',reason:'authorization-rejected',observedBindingGeneration:'binding-registered-a',observedRevision:4});
  expect(await page.evaluate(list=>window.calls.filter(item=>list.includes(item.channel)),forbidden)).toEqual([]);
});
test('session recovery: optional mod and both asset lists independently recover without content dispatch',async({page})=>{
  await start(page,'unmanaged',true,{rejectOnce:['/api/mods/list','/api/assets/list/shaderpacks','/api/assets/list/resourcepacks']});
  for(const pathname of ['/api/mods/list','/api/assets/list/shaderpacks','/api/assets/list/resourcepacks']){
    await expect.poll(()=>page.evaluate(pathname=>window.fetches.filter(item=>item.pathname===pathname).length,pathname)).toBeGreaterThanOrEqual(2);
  }
  expect(await page.evaluate(()=>window.calls.filter(item=>['minecraft-download-mods','minecraft-download-assets'].includes(item.channel)))).toEqual([]);
  expect(await page.evaluate(()=>window.fetches.filter(item=>item.pathname!=='/api/test').every(item=>item.redirect==='error'))).toBe(true);
});
test('session recovery: selection change discards delayed acquire before dispatch',async({page})=>{
  await start(page,'unpaired');
  await expect(page.getByText('A Minecraft Server',{exact:true})).toBeVisible();
  await page.evaluate(()=>{window.deferSessions=true;document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>page.evaluate(()=>window.pendingSessions.length)).toBeGreaterThan(0);
  await page.evaluate(()=>{window.deferSessions=false;window.fixture.switchInstance('registered-b');});
  await expect.poll(()=>page.evaluate(()=>window.calls.some(item=>item.channel==='management-session:acquire'&&item.args[0].clientInstanceId==='registered-b'))).toBe(true);
  await page.evaluate(()=>{for(const pending of window.pendingSessions)pending.resolve({...pending.result,value:{...pending.result.value,sessionToken:'retired-a'}});});
  await page.waitForTimeout(100);
  expect(await page.evaluate(()=>window.fetches.some(item=>['fixture-only','retired-a'].includes(item.headers['X-Session-Token'])))).toBe(false);
  expect(await page.evaluate(()=>window.calls.filter(item=>item.channel==='save-client-config'))).toEqual([]);
  expect(await page.evaluate(()=>window.fixture.currentInstance().id)).toBe('registered-b');
});
test('session recovery: mounted Mods manager reads use the current broker session and block redirects',async({page})=>{
  await start(page,'unmanaged');
  await expect.poll(()=>page.evaluate(()=>window.calls.some(item=>item.channel==='minecraft-check-client'))).toBe(true);
  await page.evaluate(()=>window.fetches=[]);
  await page.getByRole('button',{name:'🧩 Mods',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.fetches.some(item=>item.pathname==='/api/mods/list'))).toBe(true);
  const requests=await page.evaluate(()=>window.fetches);
  expect(requests.filter(item=>item.pathname==='/api/test').every(item=>!item.headers['X-Session-Token'])).toBe(true);
  expect(requests.filter(item=>item.pathname!=='/api/test').every(item=>item.headers['X-Session-Token']==='memory-4'&&item.redirect==='error')).toBe(true);
});
test('session recovery: destroyed Mods manager cannot paint delayed server lists into another client',async({page})=>{
  await start(page,'unmanaged');
  await expect.poll(()=>page.evaluate(()=>window.calls.some(item=>item.channel==='minecraft-check-client'))).toBe(true);
  await page.getByRole('button',{name:'🧩 Mods',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.fetches.filter(item=>item.pathname==='/api/mods/list').length)).toBeGreaterThan(1);
  await page.evaluate(()=>{
    const original=window.fetch;window.pendingInfo=[];
    window.fetch=async(...args)=>new URL(args[0]).pathname==='/api/server/info'?window.deferredInfo():original(...args);
  });
  await page.getByRole('button',{name:'🔄 Refresh',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.pendingInfo.length)).toBe(1);
  await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await page.evaluate(()=>window.pendingInfo[0]({success:true,minecraftVersion:'1.19.2',requiredMods:[{fileName:'obsolete-a.jar'}],allClientMods:[]}));
  await page.waitForTimeout(100);
  expect(await page.evaluate(()=>window.fixture.requiredNames())).not.toContain('obsolete-a.jar');
});
for(const mode of ['delayed-completion','retired-timer','same-client'])test(`session recovery: Manager download ${mode} owns its continuations`,async({page})=>{
  await start(page,'unmanaged');
  await page.evaluate(()=>{
    const fetch=window.fetch;window.fetch=async(...args)=>{
      const response=await fetch(...args);
      if(new URL(args[0]).pathname!=='/api/server/info')return response;
      return new Response(JSON.stringify({...await response.json(),requiredMods:[{fileName:'fixture.jar',name:'Fixture mod',required:true,downloadUrl:'/api/mods/download/fixture.jar'}]}));
    };
    window.fixture.seedDownload();window.fixture.show('manager');
  });
  await expect.poll(()=>page.evaluate(()=>window.fetches.filter(item=>item.pathname==='/api/mods/list').length)).toBeGreaterThan(1);
  await page.evaluate(()=>{
    window.downloadTimers=[];window.finishDownload=null;
    const originalTimer=window.setTimeout;window.setTimeout=(fn,delay,...args)=>delay===1500?(window.downloadTimers.push(fn),0):originalTimer(fn,delay,...args);
    const invoke=window.electron.invoke;window.electron.invoke=async(channel,...args)=>{
      if(channel==='minecraft-download-mods'){window.calls.push({channel,args});return new Promise(resolve=>{window.finishDownload=()=>resolve({success:true,downloaded:1,removedMods:['obsolete-a.jar']});});}
      return invoke(channel,...args);
    };
    window.fixture.seedDownload();
  });
  await page.getByRole('button',{name:'📥 Download',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>!!window.finishDownload)).toBe(true);
  if(mode==='delayed-completion')await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await page.evaluate(()=>window.finishDownload());
  if(mode!=='delayed-completion')await expect.poll(()=>page.evaluate(()=>window.downloadTimers.length)).toBe(1);
  if(mode==='retired-timer')await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await page.waitForTimeout(100);
  await page.evaluate(()=>{window.calls=[];window.downloadTimers.forEach(fn=>fn());});
  if(mode==='same-client')await expect.poll(()=>page.evaluate(()=>window.calls.some(item=>item.channel==='get-client-installed-mod-info'))).toBe(true);
  else {await page.waitForTimeout(100);expect(await page.evaluate(()=>window.calls.filter(item=>['get-client-installed-mod-info','minecraft-check-mods'].includes(item.channel)))).toEqual([]);}
});
for(const status of ['unpaired','future-state'])test(`${status} blocks actual automatic legacy checks and Mods content`,async({page})=>{
  await start(page,status);
  await expect.poll(()=>page.evaluate(()=>window.calls.filter(x=>x.channel==='client-packs:get-state').length)).toBeGreaterThan(0);
  await page.evaluate(()=>{window.dispatchEvent(new Event('assets-changed'));document.dispatchEvent(new Event('visibilitychange'));});
  await page.getByRole('button',{name:'🧩 Mods',exact:true}).click();
  await expect(page.getByText('Managed pack content is reviewed in Matching client pack.')).toBeVisible();
  await page.getByRole('button',{name:'⚙️ Settings',exact:true}).click();
  await expect(page.getByRole('button',{name:/Repair Client|Clear All.*Re-download/})).toHaveCount(0);
  await page.waitForTimeout(1400);
  expect(await page.evaluate(list=>window.calls.filter(x=>list.includes(x.channel)),forbidden)).toEqual([]);
});
test('managed client keeps normal Microsoft sign-in available',async({page})=>{
  await start(page,'unpaired',false);
  await expect(page.getByRole('button',{name:/Login with Microsoft/})).toBeVisible();
  await expect(page.getByText('No matching client pack paired')).toBeVisible();
  await expect(page.getByRole('button',{name:/Launch Minecraft/})).toHaveCount(0);
});
test('unmanaged client keeps legacy checks after classification',async({page})=>{
  await start(page,'unmanaged');
  await expect.poll(()=>page.evaluate(()=>window.calls.some(x=>x.channel==='minecraft-check-client'))).toBe(true);
  const calls=await page.evaluate(()=>window.calls.map(x=>x.channel));
  expect(calls.indexOf('client-packs:get-state')).toBeLessThan(calls.indexOf('minecraft-check-client'));
});
test('loading managed classification cannot run legacy checks',async({page})=>{
  await start(page,'unpaired');
  await page.evaluate(()=>{window.calls=[];window.deferState=true;window.fixture.switchInstance('registered-b');});
  await expect.poll(()=>page.evaluate(()=>window.pendingStates.length)).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  expect(await page.evaluate(list=>window.calls.filter(x=>list.includes(x.channel)),forbidden)).toEqual([]);
});
test('managed ready uses the normal launch action without renderer runtime authority',async({page})=>{
  await start(page,'ready');
  await page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.calls.some(x=>x.channel==='minecraft-launch'))).toBe(true);
  const request=await page.evaluate(()=>window.calls.find(x=>x.channel==='minecraft-launch').args[0]);
  expect(request.clientPath).toBe('C:/fixture/client-a');
  expect(request).not.toHaveProperty('minecraftVersion');
  expect(request).not.toHaveProperty('serverInfo');
  expect(await page.evaluate(list=>window.calls.filter(x=>list.includes(x.channel)),forbidden)).toEqual([]);
});
test('connection setup shows truthful setup status without subscribing to game install progress',async({page})=>{
  await start(page,'unpaired');
  await page.evaluate(()=>window.fixture.show('setup'));
  expect(await page.evaluate(()=>['minecraft-client-progress','fabric-install-progress','loader-install-progress','install-log'].filter(channel=>window.listeners.get(channel)?.size))).toEqual([]);
  await page.getByRole('button',{name:/Choose Folder/}).click();
  await page.getByLabel('Invite Link').fill('https://server.test:8080/#secret=fixture-only');
  await page.getByRole('button',{name:'Test Connection',exact:true}).click();
  await page.getByRole('button',{name:'Save & Continue',exact:true}).click();
  await expect(page.getByText(/Connection saved.*matching client pack/i)).toBeVisible();
  expect(await page.evaluate(()=>window.calls.some(x=>x.channel==='save-client-config'))).toBe(true);
});
test('late Microsoft result from client A cannot save or paint authentication into B',async({page})=>{
  await start(page,'unpaired',false);
  await page.evaluate(()=>window.deferAuth=true);
  await page.getByRole('button',{name:/Login with Microsoft/}).click();
  await expect.poll(()=>page.evaluate(()=>window.pendingAuth.length)).toBe(1);
  await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await expect(page.getByRole('button',{name:/Login with Microsoft/})).toBeVisible();
  await page.evaluate(()=>window.pendingAuth[0]({success:true,username:'Obsolete A',uuid:'fixture-only'}));
  await page.waitForTimeout(100);
  expect(await page.evaluate(()=>window.calls.filter(x=>x.channel==='minecraft-save-auth'))).toEqual([]);
  await expect(page.getByText('Obsolete A',{exact:true})).toHaveCount(0);
});
test('delayed server-info JSON from A cannot overwrite current B metadata',async({page})=>{
  await start(page,'unpaired');
  await expect(page.getByText('A Minecraft Server',{exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const oldFetch=window.fetch;window.pendingInfo=[];let defer=true;
    window.fetch=async(...args)=>{
      if(new URL(args[0]).pathname==='/api/server/info'){
        if(defer){defer=false;return window.deferredInfo();}
        return new Response(JSON.stringify({success:true,instanceId:'server-b',minecraftVersion:'1.20.1',serverInfo:{name:'Current B'},minecraftServerStatus:'stopped'}),{status:200});
      }
      return oldFetch(...args);
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(()=>page.evaluate(()=>window.pendingInfo.length)).toBe(1);
  await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await expect(page.getByText('Current B',{exact:true})).toBeVisible();
  await page.evaluate(()=>window.pendingInfo[0]({success:true,serverInfo:{name:'Obsolete A'},minecraftVersion:'1.19.2'}));
  await page.waitForTimeout(100);
  await expect(page.getByText('Obsolete A',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Current B',{exact:true})).toBeVisible();
});
test('global launcher authentication events cannot paint an unrelated selected instance',async({page})=>{
  await start(page,'unpaired',false);
  await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await expect(page.getByRole('button',{name:/Login with Microsoft/})).toBeVisible();
  await page.evaluate(()=>{for(const fn of window.listeners.get('launcher-auth-success')||[])fn({username:'Unscoped old login',uuid:'fixture-only'});});
  await expect(page.getByText('Unscoped old login',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Login with Microsoft/})).toBeVisible();
});
test('switching clients clears owned launch state and ignores old launch progress',async({page})=>{
  await start(page,'ready');
  await page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.calls.some(x=>x.channel==='minecraft-launch'))).toBe(true);
  await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await expect(page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true})).toBeVisible();
  await page.evaluate(()=>{for(const fn of window.listeners.get('launcher-launch-start')||[])fn();for(const fn of window.listeners.get('launcher-launch-progress')||[])fn({type:'obsolete',task:'Old launch A'});});
  await expect(page.getByText(/Old launch A/)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true})).toBeVisible();
});
test('actual managed server overview exposes pairing and removes it when unmanaged',async({page})=>{
  await start(page,'unpaired');
  await page.evaluate(()=>window.fixture.show('server'));
  await expect(page.getByText('Fixture server pack',{exact:true})).toBeVisible();
  await expect(page.getByLabel('fixture-0.13.4.mrpack')).toBeVisible();
  await page.evaluate(()=>{window.serverManaged=false;for(const fn of window.listeners.get('modpacks:state-changed')||[])fn({serverId:'server-fixture'});});
  await expect(page.getByText('No managed modpack is attached',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Matching client pack',exact:true})).toHaveCount(0);
});
test('actual local managed overview keeps server install status and explains companion limit',async({page})=>{
  await start(page,'unpaired');
  await page.evaluate(()=>{window.serverProvider='local';window.fixture.show('server');});
  await expect(page.getByText('Fixture server pack',{exact:true})).toBeVisible();
  await expect(page.getByText(/Local server archives remain supported/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Inspect selected pack'})).toHaveCount(0);
});
test('same-client server-info requests keep the newest response',async({page})=>{
  await start(page,'unpaired');
  await expect(page.getByText('A Minecraft Server',{exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const oldFetch=window.fetch;window.pendingInfo=[];
    window.fetch=async(...args)=>new URL(args[0]).pathname==='/api/server/info'?window.deferredInfo():oldFetch(...args);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(()=>page.evaluate(()=>window.pendingInfo.length)).toBe(1);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(()=>page.evaluate(()=>window.pendingInfo.length)).toBe(2);
  await page.evaluate(()=>window.pendingInfo[1]({success:true,serverInfo:{name:'Newest response'},minecraftVersion:'1.20.1'}));
  await expect(page.getByText('Newest response',{exact:true})).toBeVisible();
  await page.evaluate(()=>window.pendingInfo[0]({success:true,serverInfo:{name:'Old same-client response'},minecraftVersion:'1.19.2'}));
  await expect(page.getByText('Old same-client response',{exact:true})).toHaveCount(0);
});
test('overlapping same-client sign-ins retain only the newest operation result',async({page})=>{
  await start(page,'unpaired',false);
  await page.evaluate(()=>window.deferAuth=true);
  await page.getByRole('button',{name:/Login with Microsoft/}).click();
  await page.getByRole('button',{name:'⚙️ Settings',exact:true}).click();
  await page.getByRole('button',{name:'🔑 Login with Microsoft',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.pendingAuth.length)).toBe(2);
  await page.evaluate(()=>window.pendingAuth[1]({success:true,username:'Newest login',uuid:'fixture-new'}));
  await expect(page.getByText('Newest login',{exact:true})).toBeVisible();
  await page.evaluate(()=>window.pendingAuth[0]({success:true,username:'Obsolete same-client login',uuid:'fixture-old'}));
  await expect(page.getByText('Obsolete same-client login',{exact:true})).toHaveCount(0);
});
for(const phase of ['auth','invoke'])test(`old client launch events cannot settle B during its ${phase} request`,async({page})=>{
  await start(page,'ready');
  await page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true}).click();
  await expect(page.getByRole('button',{name:'⏹️ Stop Minecraft',exact:true})).toBeVisible();
  await page.evaluate(()=>window.fixture.switchInstance('registered-b'));
  await expect(page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true})).toBeVisible();
  await page.evaluate(phase=>{const original=window.electron.invoke;window.pendingLaunch=[];window.electron.invoke=(channel,...args)=>channel===(phase==='auth'?'minecraft-check-refresh-auth':'minecraft-launch')?new Promise(resolve=>window.pendingLaunch.push(resolve)):original(channel,...args);},phase);
  await page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.pendingLaunch.length)).toBe(1);
  for(const channel of ['launcher-launch-error','launcher-minecraft-closed','launcher-launch-success','launcher-launch-progress']){
    await page.evaluate(channel=>{for(const fn of window.listeners.get(channel)||[])fn(channel.endsWith('error')?'Old A error':{type:'Obsolete A',task:'stale progress',total:10,current:10});},channel);
    await expect(page.getByRole('heading',{name:'🚀 Launching Minecraft...',exact:true})).toBeVisible();
    await expect(page.getByText(/Obsolete A|stale progress/)).toHaveCount(0);
  }
  await page.evaluate(()=>window.pendingLaunch[0]({success:true}));
  await expect(page.getByRole('button',{name:'⏹️ Stop Minecraft',exact:true})).toBeVisible();
});
test('same-client cancelled launch results and old close hints cannot settle its replacement',async({page})=>{
  await start(page,'ready');
  await page.evaluate(()=>{const original=window.electron.invoke;window.pendingLaunch=[];window.electron.invoke=(channel,...args)=>channel==='minecraft-launch'?new Promise(resolve=>window.pendingLaunch.push(resolve)):original(channel,...args);});
  await page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.pendingLaunch.length)).toBe(1);
  await page.getByRole('button',{name:'⏹️ Cancel Launch',exact:true}).click();
  await page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.pendingLaunch.length)).toBe(2);
  await page.evaluate(()=>{window.pendingLaunch[0]({success:false,error:'Old same-client failure'});for(const fn of window.listeners.get('launcher-minecraft-closed')||[])fn({});});
  await expect(page.getByRole('heading',{name:'🚀 Launching Minecraft...',exact:true})).toBeVisible();
  await page.evaluate(()=>window.pendingLaunch[1]({success:true}));
  await expect(page.getByRole('button',{name:'⏹️ Stop Minecraft',exact:true})).toBeVisible();
});
test('current close hints use matching authoritative stopped status without trusting unrelated paths',async({page})=>{
  await start(page,'ready');
  await page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true}).click();
  await expect(page.getByRole('button',{name:'⏹️ Stop Minecraft',exact:true})).toBeVisible();
  await page.evaluate(()=>{const original=window.electron.invoke;window.statusPath='C:/fixture/other';window.electron.invoke=(channel,...args)=>channel==='minecraft-get-status'?Promise.resolve({isRunning:false,isLaunching:false,clientPath:window.statusPath}):original(channel,...args);for(const fn of window.listeners.get('launcher-minecraft-closed')||[])fn({});});
  await expect(page.getByRole('button',{name:'⏹️ Stop Minecraft',exact:true})).toBeVisible();
  await page.evaluate(()=>{window.statusPath='C:/fixture/client-a';for(const fn of window.listeners.get('launcher-minecraft-stopped')||[])fn();});
  await expect(page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true})).toBeVisible();
});
test('unproven legacy download events cannot finish work but its scoped invoke still completes',async({page})=>{
  await start(page,'unmanaged',true,{legacyClientNeeded:true});
  await page.getByRole('button',{name:/Download Minecraft Client/}).waitFor();
  await page.evaluate(()=>{const original=window.electron.invoke;window.pendingDownload=[];window.electron.invoke=(channel,...args)=>channel==='minecraft-download-client'?new Promise(resolve=>window.pendingDownload.push(resolve)):original(channel,...args);});
  await page.getByRole('button',{name:/Download Minecraft Client/}).click();
  await expect.poll(()=>page.evaluate(()=>window.pendingDownload.length)).toBe(1);
  await page.evaluate(()=>{for(const fn of window.listeners.get('launcher-client-download-complete')||[])fn({success:true});for(const fn of window.listeners.get('launcher-client-download-progress')||[])fn({type:'Obsolete',task:'wrong client',total:100,current:99});for(const fn of window.listeners.get('client-mod-compatibility-report')||[])fn({hasIncompatible:true,incompatible:[{fileName:'obsolete.jar'}]});});
  await expect(page.getByRole('heading',{name:'Downloading Minecraft Client',exact:true})).toBeVisible();
  await expect(page.getByText(/Downloading Client \(\d+%\)/)).toHaveCount(0);
  await expect(page.getByRole('progressbar',{name:'Client download in progress; total unknown'})).not.toHaveAttribute('value');
  await expect(page.getByText(/wrong client|Minecraft Version Change Detected/)).toHaveCount(0);
  await page.evaluate(()=>{window.legacyClientNeeded=false;window.pendingDownload[0]({success:true,version:'1.20.1'});});
  await expect(page.getByRole('heading',{name:'Downloading Minecraft Client',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'🎮 PLAY MINECRAFT',exact:true})).toBeVisible();
});
