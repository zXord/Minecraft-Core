const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {copyServerDirectoryContents}=require('../electron/services/modpack-lifecycle/server-directory-identity.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mc-copy-progress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'source'),destination=path.join(root,'candidate');fs.mkdirSync(source);fs.mkdirSync(destination);fs.writeFileSync(path.join(source,'a.txt'),'abc');fs.writeFileSync(path.join(source,'b.txt'),'defgh');return{source,destination};}
const deps={reparseInspector:{async isReparsePoint(){return false;}},durableFs:{async flushDirectoriesAsync(){}}};
test('real candidate copy reports measured completed files and bytes before separate flush and verification phases',async t=>{
  const f=fixture(t),events=[];await copyServerDirectoryContents(f.source,f.destination,{...deps,onCopyProgress:event=>events.push(event)});
  const copies=events.filter(e=>e.activity==='copying-live-files');
  assert.deepEqual(copies[0],{activity:'copying-live-files',completedItems:'0',totalItems:'2',completedBytes:'0',totalBytes:'8'});
  assert.deepEqual(copies.at(-1),{activity:'copying-live-files',completedItems:'2',totalItems:'2',completedBytes:'8',totalBytes:'8'});
  assert.ok(copies.some(e=>e.completedItems==='1'&&e.completedBytes==='3'));
  assert.deepEqual(events.slice(-2),[{activity:'flushing-candidate-directories'},{activity:'verifying-candidate-copy'}]);
  assert.equal(events.some(e=>JSON.stringify(e).includes(f.source)),false);
  assert.equal(fs.readFileSync(path.join(f.destination,'b.txt'),'utf8'),'defgh');
});
test('progress observer failure does not change a verified copy outcome',async t=>{
  const f=fixture(t);const result=await copyServerDirectoryContents(f.source,f.destination,{...deps,onCopyProgress:async()=>{throw new Error('observer-only');}});
  assert.equal(result.copiedBytes,'8');assert.equal(result.copiedFiles,2);
});
test('copy byte totals include mutable files even when the integrity fingerprint excludes their content',async t=>{
  const f=fixture(t),events=[];
  await copyServerDirectoryContents(f.source,f.destination,{...deps,mutableRelativePaths:['a.txt'],onCopyProgress:event=>events.push(event)});
  const copies=events.filter(e=>e.activity==='copying-live-files');
  assert.equal(copies[0].totalBytes,'8');
  assert.equal(copies.at(-1).completedBytes,'8');assert.equal(copies.at(-1).totalBytes,'8');
});
