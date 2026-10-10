import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

let bundle;
test.beforeAll(async () => {
  const root = process.cwd();
  const fixture = `<script>
    import Client from './src/components/client/ClientModpackPanel.svelte';
    import Companion from './src/components/modpacks/ClientCompanionPanel.svelte';
    let kind = 'client'; let id = 'a'; let managed=true; let local=false; let clientPanel;
    export function show(nextKind, nextId, options={}) { kind = nextKind; id = nextId; managed=options.managed??true; local=options.local??false; }
    export function refreshClient(){return clientPanel.refresh();}
  </script>
  {#if kind === 'client'}<Client bind:this={clientPanel} clientId={id} destinationLabel="Existing client folder" on:state={event => window.classified = event.detail} />
  {:else}<Companion serverId={id} {managed} localArchive={local} />{/if}`;
  const result = await build({ absWorkingDir: root,
    stdin: { resolveDir: root, contents: `import Fixture from 'client-fixture'; import { mount, flushSync } from 'svelte'; const fixture = mount(Fixture, {target: document.querySelector('#fixture')}); window.show = (kind,id,options) => flushSync(() => fixture.show(kind,id,options));window.refreshClient=()=>fixture.refreshClient();` },
    bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
    plugins: [{ name: 'real-panels', setup(builder) {
      builder.onResolve({ filter: /^client-fixture$/ }, () => ({path: 'ClientFixture.svelte', namespace: 'fixture'}));
      builder.onLoad({filter: /./, namespace: 'fixture'}, () => ({ contents: compile(fixture, {filename: path.join(root,'ClientFixture.svelte'), generate: 'client', css: 'injected'}).js.code, resolveDir: root }));
      builder.onLoad({filter: /\.svelte$/}, async ({path: filename}) => ({ contents: compile(await fs.readFile(filename,'utf8'), {filename, generate: 'client', css: 'injected'}).js.code, resolveDir: path.dirname(filename) }));
    }}]
  });
  bundle = result.outputFiles[0].text;
});

async function start(page, status = 'install-required', kind = 'client') {
  await page.route('**/*', route => route.abort());
  await page.setContent('<style>body{background:#15151c;color:#eee;font:15px Arial;padding:20px}</style><div id="fixture"></div>');
  await page.evaluate(({status}) => {
    window.calls = []; window.listeners = new Set(); window.pending = {};
    window.runtime = {minecraftVersion:'1.20.1',loaderFamily:'forge',loaderVersion:'47.3.12',javaMajor:17,architecture:'x64',os:'win32'};
    window.descriptor = {schemaVersion:1,status:'ready',serverFingerprint:'f'.repeat(64),serverVersion:'0.13.4',source:{provider:'github',repositoryId:'1',githubOwner:'team',githubRepo:'pack',releaseId:'2',assetId:'3'},runtime:window.runtime,artifactSha256:'a'.repeat(64)};
    window.currentStatus = status;
    window.preview = {clientId:'a',planId:'plan-1',descriptor:window.descriptor,optionalFiles:[{id:'optional',label:'Optional client mod',defaultSelected:true}],optionalFileIds:['optional'],downloadBytes:'2048',additions:['mods/new.jar'],removals:['mods/old.jar'],replacements:['config/common.toml'],preserved:['options.txt','servers.dat'],conflicts:[{path:'config/user.toml',action:'replace',reason:'modified-owned',replaceAllowed:true},{path:'mods/personal.jar',action:'replace',reason:'unowned',replaceAllowed:false}]};
    window.electron = {
      on: (channel, fn) => window.listeners.add(fn), removeListener: (channel, fn) => window.listeners.delete(fn),
      invoke: async (channel, input) => {
        window.calls.push({channel,input});
        if (window.pending[channel]) return new Promise(resolve => window.pending[channel].push({resolve,input}));
        if (window.fail?.[channel]) return {ok:false,error:window.fail[channel]};
        let value;
        switch(channel) {
          case 'client-packs:get-state': case 'client-packs:verify': value = {clientId:input.clientId,status:window.currentStatus,verified:window.currentStatus==='ready',descriptor:window.descriptor,...(window.recoveryReason?{recoveryReason:window.recoveryReason}:{})}; break;
          case 'client-packs:preview': value = {...window.preview,optionalFileIds:input.optionalFileIds ?? ['optional']}; break;
          case 'client-packs:install': window.currentStatus='ready'; value = {clientId:input.clientId,status:'ready',verified:true,...(window.installCleanup?{cleanup:window.installCleanup}:{})}; break;
          case 'client-packs:recover': window.currentStatus='install-required'; value = {phase:'abandoned',operationId:'private-id'}; break;
          case 'client-packs:get-companion': value = window.companionDescriptor ?? {...window.descriptor,status:'unpaired',source:null,runtime:null,artifactSha256:null}; break;
          case 'client-packs:list-companion-assets': value = {serverFingerprint:'f'.repeat(64),serverVersion:'0.13.4',assets:[{assetId:'3',fileName:'pack-0.13.4.mrpack',size:'2048'}]}; break;
          case 'client-packs:inspect-companion': value = {inspectionId:'inspection-1',...window.descriptor,name:'Pack',version:'0.13.4',optionalFiles:[],downloadBytes:'2048'}; break;
          case 'client-packs:accept-companion': value = window.descriptor; break;
          case 'client-packs:cancel': value={cancelled:true}; break;
          default: throw new Error(`Unexpected IPC ${channel}`);
        }
        return {ok:true,value};
      }
    };
  }, {status});
  await page.addScriptTag({content:bundle});
  if (kind !== 'client') await page.evaluate(kind => window.show(kind,'a'),kind);
}

test('missing required published file stays a review failure with actionable safe details', async ({page}) => {
  await start(page);
  await page.evaluate(() => {
    window.fail = {'client-packs:preview': {code:'ARTIFACT_UNAVAILABLE',message:'PRIVATE token=secret',
      details:{fileName:'midnight-ae2-30e7823.zip',httpStatus:'404',url:'https://private/?token=secret'}}};
  });
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await expect(page.getByRole('alert')).toContainText('midnight-ae2-30e7823.zip');
  await expect(page.getByRole('alert')).toContainText('HTTP 404');
  await expect(page.getByRole('alert')).toContainText('server owner');
  await expect(page.getByRole('alert')).not.toContainText(/PRIVATE|token=|https:/);
  await expect(page.getByRole('button',{name:'Review matching pack'})).toBeEnabled();
  await expect(page.getByRole('button',{name:/Install reviewed|Install matching/})).toHaveCount(0);
  expect(await page.evaluate(() => window.currentStatus)).toBe('install-required');
  expect(await page.evaluate(() => window.calls.filter(call => call.channel === 'client-packs:install'))).toEqual([]);
});

async function companionEvidence(page, label, errors) {
  if (!process.env.COMPANION_WARNING_EVIDENCE) return;
  const prefix = path.join(process.env.COMPANION_WARNING_EVIDENCE, `${process.env.COMPANION_WARNING_PHASE ?? 'fixture'}-${label}`);
  await page.screenshot({path:`${prefix}.png`,fullPage:true});
  await fs.writeFile(`${prefix}.json`,JSON.stringify({url:page.url(),...await page.evaluate(()=>({
    title:document.title,panel:document.querySelector('section[aria-label="Matching client pack"]')?.innerText,
    busy:document.querySelector('section[aria-label="Matching client pack"]')?.getAttribute('aria-busy'),
    overlays:document.querySelectorAll('vite-error-overlay, nextjs-portal, #webpack-dev-server-client-overlay').length
  })),errors},null,2));
}

test('companion first-mount saved pairing survives asset discovery PLAN_STALE and ordinary Refresh recovers', async ({page}) => {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  await start(page);
  await page.evaluate(() => {
    window.companionDescriptor=window.descriptor;
    window.fail={'client-packs:list-companion-assets':{code:'PLAN_STALE',message:'PRIVATE fixture list proof changed'}};
    window.show('companion','a');
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await companionEvidence(page,'partial-list-failure',errors);
  await expect(page.getByRole('heading',{name:'Saved pairing for this server release'})).toBeVisible();
  await expect(page.getByText('Server release 0.13.4',{exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/Asset discovery.*PLAN_STALE/);
  await expect(page.getByRole('alert')).not.toContainText('PRIVATE');
  await expect(page.getByText(/not currently verified/i)).toBeVisible();
  await expect(page.getByRole('button',{name:/Inspect selected pack|Accept matching client pack/})).toHaveCount(0);
  await page.evaluate(()=>window.fail={});
  await page.getByRole('button',{name:'Refresh companion list'}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Paired for this server release'})).toBeVisible();
  await expect(page.getByLabel('pack-0.13.4.mrpack')).toBeVisible();
  await companionEvidence(page,'ordinary-refresh-recovered',errors);
  expect(await page.evaluate(()=>window.calls.filter(call=>/inspect-companion|accept-companion/.test(call.channel)))).toEqual([]);
  expect(errors).toEqual([]);
});

test('pairing requires explicit same-release asset inspection and runtime review', async ({page}) => {
  await start(page,'install-required','companion');
  await expect(page.getByText('pack-0.13.4.mrpack')).toBeVisible();
  await expect(page.getByRole('button',{name:'Accept matching client pack'})).toHaveCount(0);
  await page.getByLabel('pack-0.13.4.mrpack').check();
  await page.getByRole('button',{name:'Inspect selected pack'}).click();
  await expect(page.getByText(/Minecraft 1.20.1.*forge.*47.3.12/)).toBeVisible();
  await page.getByRole('button',{name:'Accept matching client pack'}).click();
  await expect(page.getByText('Paired for this server release')).toBeVisible();
});
test('PLAN_STALE freshness warning clears after refreshing the unchanged companion descriptor', async ({page}) => {
  await start(page);
  await page.evaluate(() => {
    window.companionDescriptor = window.descriptor;
    window.fail = {'client-packs:get-companion':{code:'PLAN_STALE',message:'Freshness proof changed'}};
    window.show('companion','a');
  });
  await expect(page.getByRole('alert')).toContainText(/Pairing status.*PLAN_STALE.*Refresh/);

  await page.evaluate(() => {window.fail={};});
  await page.getByRole('button',{name:'Refresh companion list'}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Paired for this server release')).toBeVisible();
  const calls = await page.evaluate(() => window.calls.map(call=>call.channel));
  expect(calls.filter(channel=>channel==='client-packs:inspect-companion')).toHaveLength(0);
  expect(calls.filter(channel=>channel==='client-packs:accept-companion')).toHaveLength(0);
});

const companionPanel = page => page.getByRole('region',{name:'Matching client pack'});
const refreshCompanion = page => page.getByRole('button',{name:'Refresh companion list'});
const companionJobs = (page,channel,count) => expect.poll(()=>page.evaluate(channel=>window.pending[`client-packs:${channel}`]?.length,channel)).toBe(count);
async function settleCompanion(page,channel,index,{code,version='0.13.4',fingerprint='f'}={}) {
  await page.evaluate(({channel,index,code,version,fingerprint})=>{
    const value=channel==='list-companion-assets'
      ? {serverFingerprint:fingerprint.repeat(64),serverVersion:version,assets:[{assetId:'3',fileName:`pack-${version}.mrpack`,size:'2048'}]}
      : {...window.descriptor,serverVersion:version,serverFingerprint:fingerprint.repeat(64),...(channel==='inspect-companion'?{inspectionId:'obsolete-inspection',name:'Obsolete pack',version,downloadBytes:'2048'}:{})};
    window.pending[`client-packs:${channel}`][index].resolve(code?{ok:false,error:{code,message:'PRIVATE obsolete error'}}:{ok:true,value});
  },{channel,index,code,version,fingerprint});
}

test('companion pending discovery publishes saved status before list settles and RATE_LIMITED stays list-specific',async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.companionDescriptor=window.descriptor;window.pending['client-packs:list-companion-assets']=[];window.show('companion','a');});
  await companionJobs(page,'list-companion-assets',1);
  await expect(page.getByRole('heading',{name:'Saved pairing for this server release'})).toBeVisible();
  await expect(page.getByText('Server release 0.13.4',{exact:true})).toBeVisible();
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','true');
  await expect(page.getByRole('button',{name:/Inspect selected pack|Accept matching client pack/})).toHaveCount(0);
  await settleCompanion(page,'list-companion-assets',0,{code:'RATE_LIMITED'});
  await expect(page.getByRole('alert')).toContainText(/Asset discovery.*RATE_LIMITED/);
  await expect(page.getByRole('alert')).not.toContainText(/PRIVATE|PLAN_STALE/);
  await expect(page.getByRole('heading',{name:'Saved pairing for this server release'})).toBeVisible();
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','false');
});

for(const priorReady of [false,true])test(`companion failed status ${priorReady?'after ready':'on first mount'} is unavailable not unpaired or ready`,async({page})=>{
  await start(page);
  await page.evaluate(({priorReady})=>{window.companionDescriptor=window.descriptor;if(!priorReady)window.fail={'client-packs:get-companion':{code:'PLAN_STALE',message:'PRIVATE failed status'}};window.show('companion','a');},{priorReady});
  if(priorReady){
    await expect(page.getByRole('heading',{name:'Paired for this server release'})).toBeVisible();
    await page.getByLabel('pack-0.13.4.mrpack').check();
    await page.getByRole('button',{name:'Inspect selected pack'}).click();
    await expect(page.getByRole('button',{name:'Accept matching client pack'})).toBeVisible();
    await page.evaluate(()=>window.fail={'client-packs:get-companion':{code:'CLIENT_PACK_UNAVAILABLE',message:'PRIVATE failed status'}});
    await refreshCompanion(page).click();
  }
  await expect(page.getByRole('heading',{name:'Pairing status unavailable'})).toBeVisible();
  await expect(page.getByRole('heading',{name:/^Pair a same-release|^Paired for|^Saved pairing/})).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText(/Pairing status.*Refresh/);
  await expect(page.getByRole('alert')).not.toContainText('PRIVATE');
  await expect(page.getByText('Server release 0.13.4',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Inspect selected pack|Accept matching client pack/})).toHaveCount(0);
  expect(await page.evaluate(()=>window.calls.filter(call=>call.channel==='client-packs:list-companion-assets').length)).toBe(priorReady?1:0);
});

test('companion mismatched status/list fingerprints refuse actionable discovery without losing saved pairing',async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.companionDescriptor=window.descriptor;window.pending['client-packs:list-companion-assets']=[];window.show('companion','a');});
  await companionJobs(page,'list-companion-assets',1);
  await settleCompanion(page,'list-companion-assets',0,{fingerprint:'e'});
  await expect(page.getByRole('alert')).toContainText(/Asset discovery.*PLAN_STALE.*Refresh/);
  await expect(page.getByRole('heading',{name:'Saved pairing for this server release'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Inspect selected pack|Accept matching client pack/})).toHaveCount(0);
  await page.evaluate(()=>delete window.pending['client-packs:list-companion-assets']);
  await refreshCompanion(page).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('pack-0.13.4.mrpack')).toBeVisible();
});

for(const channel of ['inspect-companion','accept-companion'])test(`companion ${channel} freshness refusal qualifies saved pairing and invalidates inspection`,async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.companionDescriptor=window.descriptor;window.show('companion','a');});
  await page.getByLabel('pack-0.13.4.mrpack').check();
  if(channel==='accept-companion')await page.getByRole('button',{name:'Inspect selected pack'}).click();
  await page.evaluate(channel=>window.fail={[`client-packs:${channel}`]:{code:'PLAN_STALE',message:'PRIVATE stale action'}},channel);
  await page.getByRole('button',{name:channel==='inspect-companion'?'Inspect selected pack':'Accept matching client pack'}).click();
  await expect(page.getByRole('alert')).toContainText(channel==='inspect-companion'?/Pack inspection.*PLAN_STALE/:/Pairing acceptance.*PLAN_STALE/);
  await expect(page.getByRole('heading',{name:'Saved pairing for this server release'})).toBeVisible();
  await expect(page.getByText(/not currently verified/i)).toBeVisible();
  await expect(page.getByRole('button',{name:/Inspect selected pack|Accept matching client pack/})).toHaveCount(0);
  await page.evaluate(()=>window.fail={});
  await refreshCompanion(page).click();
  await expect(page.getByRole('heading',{name:'Paired for this server release'})).toBeVisible();
});

for(const code of [undefined,'PLAN_STALE'])test(`companion A-to-B-to-A rejects obsolete status ${code?'rejection':'success'} and does not start its list`,async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.pending['client-packs:get-companion']=[];window.show('companion','a');});
  await companionJobs(page,'get-companion',1);
  await page.evaluate(()=>window.show('companion','b'));
  await companionJobs(page,'get-companion',2);
  await page.evaluate(()=>window.show('companion','a'));
  await companionJobs(page,'get-companion',3);
  await settleCompanion(page,'get-companion',0,{code,version:'obsolete-A'});
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','true');
  await expect(refreshCompanion(page)).toBeDisabled();
  expect(await page.evaluate(()=>window.calls.filter(call=>call.channel==='client-packs:list-companion-assets').length)).toBe(0);
  await settleCompanion(page,'get-companion',2);
  await expect(page.getByRole('heading',{name:'Paired for this server release'})).toBeVisible();
  await settleCompanion(page,'get-companion',1,{code:'RATE_LIMITED'});
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Server release 0.13.4',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.calls.filter(call=>call.channel==='client-packs:list-companion-assets').length)).toBe(1);
});

for(const code of [undefined,'PLAN_STALE'])test(`companion A-to-B-to-A rejects obsolete list ${code?'rejection':'success'} without clearing current busy or error`,async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.companionDescriptor=window.descriptor;window.pending['client-packs:list-companion-assets']=[];window.show('companion','a');});
  await companionJobs(page,'list-companion-assets',1);
  await page.evaluate(()=>window.show('companion','b'));
  await companionJobs(page,'list-companion-assets',2);
  await page.evaluate(()=>{window.companionDescriptor={...window.descriptor,serverVersion:'current-A'};window.show('companion','a');});
  await companionJobs(page,'list-companion-assets',3);
  await settleCompanion(page,'list-companion-assets',0,{code,version:'obsolete-A'});
  await expect(page.getByText('Server release current-A',{exact:true})).toBeVisible();
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','true');
  await expect(refreshCompanion(page)).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await settleCompanion(page,'list-companion-assets',2,{code:'RATE_LIMITED'});
  await expect(page.getByRole('alert')).toContainText(/Asset discovery.*RATE_LIMITED/);
  await settleCompanion(page,'list-companion-assets',1,{code:code?'PLAN_STALE':undefined,version:'obsolete-B'});
  await expect(page.getByRole('alert')).toContainText(/Asset discovery.*RATE_LIMITED/);
  await expect(page.getByText('Server release current-A',{exact:true})).toBeVisible();
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','false');
});

for(const channel of ['get-companion','list-companion-assets'])for(const code of [undefined,'PLAN_STALE'])test(`companion unmount fences ${channel} obsolete ${code?'rejection':'success'}`,async({page})=>{
  await start(page);
  await page.evaluate(channel=>{window.companionDescriptor=window.descriptor;window.pending[`client-packs:${channel}`]=[];window.show('companion','a');},channel);
  await companionJobs(page,channel,1);
  await page.evaluate(()=>{window.show('client','a');window.companionDescriptor={...window.descriptor,serverVersion:'new-mount'};});
  await expect(companionPanel(page)).toHaveCount(0);
  await page.evaluate(()=>window.show('companion','b'));
  await companionJobs(page,channel,2);
  await settleCompanion(page,channel,0,{code,version:'unmounted'});
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','true');
  await expect(refreshCompanion(page)).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await settleCompanion(page,channel,1,{version:'new-mount'});
  await expect(page.getByText('Server release new-mount',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Paired for this server release'})).toBeVisible();
  await expect(page.getByText(/unmounted|PRIVATE/)).toHaveCount(0);
});

// Deliberately dispatch the disabled Refresh handler: forced offline concurrency, not an ordinary user action.
async function forceCompanionRefresh(page){await refreshCompanion(page).evaluate(button=>{const disabled=button.disabled;button.disabled=false;button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.disabled=disabled;});}
for(const channel of ['get-companion','list-companion-assets'])for(const code of [undefined,'PLAN_STALE'])test(`companion forced offline concurrent Refresh fences stale ${channel} ${code?'rejection':'success'}`,async({page})=>{
  await start(page);
  await page.evaluate(channel=>{window.companionDescriptor=window.descriptor;window.pending[`client-packs:${channel}`]=[];window.show('companion','a');},channel);
  await companionJobs(page,channel,1);
  await expect(refreshCompanion(page)).toBeDisabled();
  await forceCompanionRefresh(page);
  await companionJobs(page,channel,2);
  await settleCompanion(page,channel,0,{code,version:'obsolete-refresh'});
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','true');
  await expect(refreshCompanion(page)).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Server release obsolete-refresh',{exact:true})).toHaveCount(0);
  await settleCompanion(page,channel,1,{code:'RATE_LIMITED'});
  await expect(page.getByRole('alert')).toContainText(channel==='get-companion'?/Pairing status.*RATE_LIMITED/:/Asset discovery.*RATE_LIMITED/);
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','false');
});

for(const code of [undefined,'PLAN_STALE'])test(`companion forced offline Refresh supersedes inspection ${code?'rejection':'success'} and progress without enabling Accept`,async({page})=>{
  await start(page,'install-required','companion');
  await page.evaluate(()=>window.pending['client-packs:inspect-companion']=[]);
  await page.getByLabel('pack-0.13.4.mrpack').check();
  await page.getByRole('button',{name:'Inspect selected pack'}).click();
  await companionJobs(page,'inspect-companion',1);
  await page.evaluate(()=>window.pending['client-packs:get-companion']=[]);
  await forceCompanionRefresh(page);
  await companionJobs(page,'get-companion',1);
  await page.evaluate(()=>{const input=window.pending['client-packs:inspect-companion'][0].input;for(const listener of window.listeners)listener({...input,phase:'obsolete-inspection-progress'});});
  await settleCompanion(page,'inspect-companion',0,{code});
  await expect(companionPanel(page)).toHaveAttribute('aria-busy','true');
  await expect(refreshCompanion(page)).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('obsolete-inspection-progress')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Accept matching client pack'})).toHaveCount(0);
  await settleCompanion(page,'get-companion',0);
  await expect(page.getByRole('heading',{name:'Paired for this server release'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Accept matching client pack'})).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>window.listeners.size)).toBe(0);
});

test('companion cancellation keeps inspection unaccepted and exact fingerprint survives stopped-server retry',async({page})=>{
  await start(page,'install-required','companion');
  await page.evaluate(()=>window.pending['client-packs:inspect-companion']=[]);
  await page.getByLabel('pack-0.13.4.mrpack').check();
  await page.getByRole('button',{name:'Inspect selected pack'}).click();
  await companionJobs(page,'inspect-companion',1);
  await page.getByRole('button',{name:'Cancel request'}).click();
  await settleCompanion(page,'inspect-companion',0,{code:'CANCELLED'});
  await expect(page.getByRole('alert')).toContainText(/Pack inspection.*CANCELLED/);
  await expect(page.getByRole('button',{name:'Accept matching client pack'})).toHaveCount(0);
  await page.evaluate(()=>delete window.pending['client-packs:inspect-companion']);
  await page.getByRole('button',{name:'Inspect selected pack'}).click();
  await page.evaluate(()=>window.fail={'client-packs:accept-companion':{code:'SERVER_RUNNING',message:'PRIVATE running'}});
  await page.getByRole('button',{name:'Accept matching client pack'}).click();
  await expect(page.getByRole('alert')).toContainText(/Pairing acceptance.*SERVER_RUNNING.*Stop the server/);
  await expect(page.getByRole('heading',{name:'Paired for this server release'})).toHaveCount(0);
  await page.evaluate(()=>window.fail={});
  await page.getByRole('button',{name:'Accept matching client pack'}).click();
  await expect(page.getByRole('heading',{name:'Paired for this server release'})).toBeVisible();
  const calls=await page.evaluate(()=>window.calls.filter(call=>/inspect-companion|accept-companion|cancel$/.test(call.channel)));
  expect(calls.filter(call=>call.channel==='client-packs:cancel')).toHaveLength(1);
  for(const call of calls.filter(call=>/inspect-companion|accept-companion/.test(call.channel)))expect(call.input.expectedServerFingerprint).toBe('f'.repeat(64));
  expect(calls.filter(call=>call.channel==='client-packs:accept-companion').map(call=>call.input.inspectionId)).toEqual(['inspection-1','inspection-1']);
});
test('preview preserves settings and requires every conflict choice before installation', async ({page}) => {
  await start(page);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await expect(page.getByText('Existing client folder')).toBeVisible();
  await page.locator('summary',{hasText:'Preserved files (2)'}).click();
  await expect(page.getByText('options.txt', {exact:true})).toBeVisible();
  await expect(page.getByText('2,048 bytes')).toBeVisible();
  await expect(page.getByRole('button',{name:'Install reviewed pack'})).toBeDisabled();
  await page.getByLabel('Replace config/user.toml').check();
  await expect(page.getByLabel('Replace mods/personal.jar')).toBeDisabled();
  await page.getByLabel('Preserve mods/personal.jar').check();
  await page.getByRole('button',{name:'Install reviewed pack'}).click();
  await expect(page.getByText('Matching pack ready')).toBeVisible();
  const call = await page.evaluate(() => window.calls.find(x => x.channel==='client-packs:install'));
  expect(call.input.conflictChoices).toEqual({'config/user.toml':'replace','mods/personal.jar':'preserve'});
});
test('optional file changes obtain a new reviewed plan', async ({page}) => {
  await start(page);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await page.getByLabel('Optional client mod').uncheck();
  await expect.poll(() => page.evaluate(() => window.calls.filter(x=>x.channel==='client-packs:preview').at(-1).input.optionalFileIds)).toEqual([]);
});
test('large file plans keep install accessible with counted expandable bounded lists', async ({page}) => {
  await start(page);
  await page.evaluate(() => {window.preview={...window.preview,optionalFiles:[],optionalFileIds:[],conflicts:[],additions:Array.from({length:4000},(_,i)=>`mods/file-${i}.jar`),removals:[],replacements:[],preserved:[]};});
  await page.getByRole('button',{name:'Review matching pack'}).click();
  const files=page.locator('details').filter({has:page.locator('summary',{hasText:'Additions (4000)'})});
  await expect(files).not.toHaveAttribute('open');
  await expect(page.getByRole('button',{name:'Install reviewed pack'})).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollHeight)).toBeLessThan(1100);
  await files.locator('summary').click();
  await expect(files.locator('li')).toHaveCount(4000);
  expect(await files.getByRole('region').evaluate(element=>element.clientHeight)).toBeLessThanOrEqual(260);
  await files.getByRole('region').evaluate(element=>element.scrollTop=element.scrollHeight);
  await expect(page.getByText('mods/file-3999.jar',{exact:true})).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollHeight)).toBeLessThan(1100);
});
test('client file-list markup compiles without accessibility warnings',async()=>{
  const filename=path.join(process.cwd(),'src/components/client/ClientModpackPanel.svelte');
  const result=compile(await fs.readFile(filename,'utf8'),{filename,generate:'client',css:'injected'});
  expect(result.warnings.filter(warning=>warning.code.startsWith('a11y_'))).toEqual([]);
});
test('large file lists remain semantic and keyboard-scrollable in a labelled region',async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.preview={...window.preview,optionalFiles:[],optionalFileIds:[],conflicts:[],additions:Array.from({length:4000},(_,i)=>`mods/file-${i}.jar`),removals:[],replacements:[],preserved:[]};});
  await page.getByRole('button',{name:'Review matching pack'}).click();
  const summary=page.locator('summary',{hasText:'Additions (4000)'});
  await summary.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const region=page.getByRole('region',{name:'Additions file list',exact:true});
  await expect(region).toBeFocused();
  await expect(region.getByRole('list')).toHaveCount(1);
  await expect(region.getByRole('listitem')).toHaveCount(4000);
  expect(await region.evaluate(element=>element.clientHeight)).toBeLessThanOrEqual(260);
  await page.keyboard.press('End');
  await expect.poll(()=>region.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByText('mods/file-3999.jar',{exact:true})).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollHeight)).toBeLessThan(1100);
});
test('short file lists do not add an unnecessary tab stop',async({page})=>{
  await start(page);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await page.locator('summary',{hasText:'Additions (1)'}).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.locator('summary',{hasText:'Removals (1)'})).toBeFocused();
  await expect(page.getByRole('region',{name:'Additions file list',exact:true})).not.toBeFocused();
});
for(const status of ['complete','retained','pending'])test(`successful install reports ${status} cleanup without revoking readiness`,async({page})=>{
  await start(page);
  await page.evaluate(status=>{window.preview={...window.preview,conflicts:[]};window.installCleanup={status,completed:[],retained:status==='retained'?['private-cleanup-id']:[],pending:status==='pending'?['private-pending-id']:[],forgetPending:[]};},status);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await page.getByRole('button',{name:'Install reviewed pack'}).click();
  await expect(page.getByText('Matching pack ready',{exact:true})).toBeVisible();
  const notice=page.getByRole('status',{name:'Installation cleanup'});
  if(status==='complete'){await expect(notice).toHaveCount(0);return;}
  await expect(notice).toContainText(status);
  await expect(notice).toContainText(/ready.*launch/i);
  await expect(notice).not.toContainText(/private-|seven|7.day/i);
  await expect(notice.getByRole('button')).toHaveCount(0);
  await page.getByRole('button',{name:'Refresh requirement'}).click();
  await expect(page.getByText('Matching pack ready',{exact:true})).toBeVisible();
  await expect(notice).toBeVisible();
  expect(await page.evaluate(()=>window.classified.verified)).toBe(true);
  await page.evaluate(()=>window.show('client','b'));
  await expect(notice).toHaveCount(0);
});
test('pending ownership-forget cleanup is visible without exposing operation identifiers',async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.preview={...window.preview,conflicts:[]};window.installCleanup={status:'retained',completed:['private-completed-id'],retained:[],pending:[],forgetPending:['private-forget-id']};});
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await page.getByRole('button',{name:'Install reviewed pack'}).click();
  await expect(page.getByRole('status',{name:'Installation cleanup'})).toContainText(/cleanup.*retained/i);
  await expect(page.getByRole('status',{name:'Installation cleanup'})).not.toContainText('private-forget-id');
  await expect(page.getByText('Matching pack ready',{exact:true})).toBeVisible();
});
test('measured progress is honest and rejects other request or instance events', async ({page}) => {
  await start(page);
  await page.evaluate(() => window.pending['client-packs:preview']=[]);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('value');
  await page.evaluate(() => {
    const input=window.pending['client-packs:preview'][0].input;
    for (const fn of window.listeners) {fn({...input,clientId:'b',phase:'wrong-instance'});fn({...input,requestId:'other',phase:'wrong-request'});fn({...input,phase:'downloading',completedBytes:'1024',totalBytes:'2048',completedItems:'1',totalItems:'2'});}
  });
  await expect(page.getByText('1,024 / 2,048 bytes')).toBeVisible();
  await expect(page.getByText('1 / 2 files')).toBeVisible();
  await expect(page.getByText('wrong-instance')).toHaveCount(0);
  await page.getByRole('button',{name:'Cancel request'}).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(x=>x.channel==='client-packs:cancel'))).toBe(true);
});
test('stale requirements discard the reviewed plan and demand a new review', async ({page}) => {
  await start(page);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await page.getByLabel('Preserve config/user.toml').check();
  await page.getByLabel('Preserve mods/personal.jar').check();
  await page.evaluate(() => {window.descriptor={...window.descriptor,serverVersion:'0.13.5'};window.currentStatus='update-required';window.fail={'client-packs:install':{code:'PLAN_STALE',message:'Requirement changed'}};});
  await page.getByRole('button',{name:'Install reviewed pack'}).click();
  await expect(page.getByRole('alert')).toContainText('Review a fresh plan');
  await expect(page.getByRole('button',{name:'Install reviewed pack'})).toHaveCount(0);
  await expect(page.getByText('Matching pack ready')).toHaveCount(0);
  await expect(page.getByText('Server release 0.13.5',{exact:true})).toBeVisible();
});
test('recovery remains explicit and never reports ready after recovery failure', async ({page}) => {
  await start(page,'recovery-required');
  await page.evaluate(() => window.fail={'client-packs:recover':{code:'RECOVERY_REQUIRED',message:'Writer still active'}});
  await page.getByRole('button',{name:'Retry recovery'}).click();
  await expect(page.getByRole('alert')).toContainText('Writer still active');
  await expect(page.getByText('Matching pack ready')).toHaveCount(0);
});
test('instance switch ignores delayed classification from the previous instance', async ({page}) => {
  await start(page);
  await page.evaluate(() => window.pending['client-packs:get-state']=[]);
  await page.evaluate(() => window.show('client','b'));
  await page.evaluate(() => window.show('client','c'));
  await expect.poll(() => page.evaluate(() => window.pending['client-packs:get-state'].length)).toBe(2);
  await page.evaluate(() => {
    const jobs=window.pending['client-packs:get-state'];
    jobs[1].resolve({ok:true,value:{clientId:'c',status:'unpaired',descriptor:null}});
    jobs[0].resolve({ok:true,value:{clientId:'b',status:'ready',verified:true,descriptor:window.descriptor}});
  });
  await expect(page.getByText('No matching client pack paired')).toBeVisible();
  await expect(page.getByText('Matching pack ready')).toHaveCount(0);
});
test('unknown classification fails closed while unmanaged classification is explicit', async ({page}) => {
  await start(page,'future-state');
  await expect(page.getByText('Matching pack unavailable')).toBeVisible();
  await expect(page.getByRole('button',{name:'Review matching pack'})).toHaveCount(0);
  await page.evaluate(() => {window.currentStatus='unmanaged';window.show('client','b');});
  await expect.poll(() => page.evaluate(() => window.classified?.status)).toBe('unmanaged');
});
test('unpaired does not advertise installation or launch', async ({page}) => {
  await start(page,'unpaired');
  await expect(page.getByText('No matching client pack paired')).toBeVisible();
  await expect(page.getByText(/Ask the server owner/)).toBeVisible();
  await expect(page.getByRole('button',{name:/Install|Review matching pack|Launch/})).toHaveCount(0);
});
test('old instance progress and completion cannot paint the next instance', async ({page}) => {
  await start(page);
  await page.evaluate(() => window.pending['client-packs:preview']=[]);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await page.evaluate(() => {window.currentStatus='unpaired';window.show('client','b');});
  await expect(page.getByText('No matching client pack paired')).toBeVisible();
  await page.evaluate(() => {
    const old=window.pending['client-packs:preview'][0];
    for(const fn of window.listeners)fn({...old.input,phase:'obsolete-download',completedBytes:'999'});
    old.resolve({ok:true,value:window.preview});
  });
  await expect(page.getByText('obsolete-download')).toHaveCount(0);
  await expect(page.getByText('Review installation')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.listeners.size)).toBe(0);
  const cancellation=await page.evaluate(()=>window.calls.find(x=>x.channel==='client-packs:cancel'));
  expect(Object.keys(cancellation.input)).toEqual(['requestId']);
});
test('partial counts keep unknown totals indeterminate', async ({page}) => {
  await start(page);
  await page.evaluate(() => window.pending['client-packs:preview']=[]);
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await page.evaluate(() => {const input=window.pending['client-packs:preview'][0].input;for(const fn of window.listeners)fn({...input,phase:'downloading',completedBytes:'128',totalBytes:'NaN',completedItems:'2'});});
  await expect(page.getByText('128 bytes')).toBeVisible();
  await expect(page.getByText('2 files')).toBeVisible();
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('value');
  await expect(page.getByText(/NaN|%|ETA/)).toHaveCount(0);
});
test('pairing acceptance explains stopped-server requirement without false success', async ({page}) => {
  await start(page,'install-required','companion');
  await page.getByLabel('pack-0.13.4.mrpack').check();
  await page.getByRole('button',{name:'Inspect selected pack'}).click();
  await page.evaluate(()=>window.fail={'client-packs:accept-companion':{code:'SERVER_RUNNING',message:'Running'}});
  await page.getByRole('button',{name:'Accept matching client pack'}).click();
  await expect(page.getByRole('alert')).toContainText('Stop the server');
  await expect(page.getByText('Paired for this server release')).toHaveCount(0);
});
test('failed classification advertises unavailable not a perpetual loading state',async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.fail={'client-packs:get-state':{code:'CLIENT_PACK_UNAVAILABLE',message:'Management unavailable'}};window.show('client','b');});
  await expect(page.getByText('Matching pack unavailable')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Management unavailable');
  await expect.poll(()=>page.evaluate(()=>window.classified?.status)).toBe('unavailable');
});
test('local imports explain companion limitation without invalidating server install',async({page})=>{
  await start(page);
  await page.evaluate(()=>window.show('companion','a',{local:true}));
  await expect(page.getByText(/Local server archives remain supported/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Inspect selected pack'})).toHaveCount(0);
});
test('same server becomes managed after metadata arrives and loads pairing assets',async({page})=>{
  await start(page);
  await page.evaluate(()=>window.show('companion','a',{managed:false}));
  await page.evaluate(()=>window.show('companion','a',{managed:true}));
  await expect(page.getByLabel('pack-0.13.4.mrpack')).toBeVisible();
});
test('same instance refreshes block legacy immediately and reject older operation results',async({page})=>{
  await start(page,'unmanaged');
  await expect.poll(()=>page.evaluate(()=>window.classified?.status)).toBe('unmanaged');
  await page.evaluate(()=>{window.pending['client-packs:get-state']=[];void window.refreshClient();void window.refreshClient();});
  await expect.poll(()=>page.evaluate(()=>window.classified?.status)).toBe('loading');
  await page.evaluate(()=>{const jobs=window.pending['client-packs:get-state'];jobs[1].resolve({ok:true,value:{clientId:'a',status:'unpaired',descriptor:null}});jobs[0].resolve({ok:true,value:{clientId:'a',status:'unmanaged',descriptor:null}});});
  await expect(page.getByText('No matching client pack paired')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.classified?.status)).toBe('unpaired');
});
test('recovery failure refreshes authoritative restart guidance without restarting Windows',async({page})=>{
  await start(page,'recovery-required');
  await page.evaluate(()=>{window.recoveryReason='restart-required';window.fail={'client-packs:recover':{code:'RECOVERY_REQUIRED',message:'Recovery blocked'}};});
  await page.getByRole('button',{name:'Retry recovery'}).click();
  await expect(page.getByText(/Save your work.*restart Windows.*reopen.*retry/i)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Recovery blocked');
  expect(await page.evaluate(()=>window.calls.some(x=>/restart|reboot|shutdown/.test(x.channel)))).toBe(false);
});
test('a preparation recovery error refreshes state and shows exact restart guidance',async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.currentStatus='recovery-required';window.recoveryReason='restart-required';window.fail={'client-packs:preview':{code:'RECOVERY_REQUIRED',message:'Runtime recovery required'}};});
  await page.getByRole('button',{name:'Review matching pack'}).click();
  await expect(page.getByText('Matching pack recovery required',{exact:true})).toBeVisible();
  await expect(page.getByText(/Save your work.*restart Windows/i)).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry recovery'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Review matching pack'})).toHaveCount(0);
});
test('a recovery follow-up cannot paint its old error into a newer same-client refresh',async({page})=>{
  await start(page,'recovery-required');
  await page.evaluate(()=>{window.pending['client-packs:get-state']=[];window.fail={'client-packs:recover':{code:'CLIENT_RUNNING',message:'Old recovery error'}};});
  await page.getByRole('button',{name:'Retry recovery'}).click();
  await expect.poll(()=>page.evaluate(()=>window.pending['client-packs:get-state'].length)).toBe(1);
  await page.evaluate(()=>void window.refreshClient());
  await expect.poll(()=>page.evaluate(()=>window.pending['client-packs:get-state'].length)).toBe(2);
  await page.evaluate(()=>{const jobs=window.pending['client-packs:get-state'];jobs[1].resolve({ok:true,value:{clientId:'a',status:'unpaired',descriptor:null}});jobs[0].resolve({ok:true,value:{clientId:'a',status:'recovery-required',descriptor:null}});});
  await expect(page.getByText('No matching client pack paired',{exact:true})).toBeVisible();
  await expect(page.getByText('Old recovery error',{exact:true})).toHaveCount(0);
});
