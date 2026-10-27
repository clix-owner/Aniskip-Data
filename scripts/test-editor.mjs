import assert from 'node:assert/strict';
import { range, fetchCrunchyroll } from '../api/record.js';
import recordHandler from '../api/record.js';
import editor, { mergeRecord, complete, same } from '../api/editor.js';

Object.assign(process.env, { GITHUB_TOKEN: 'test-token', GITHUB_OWNER:'test', GITHUB_REPO:'test', GITHUB_BRANCH:'main', GITHUB_DATA_PATH:'data/aniskip_data.json', ADMIN_KEY:'test-admin', GITHUB_HISTORY_PATH:'data/editor-history.json' });
let tests=0;
function check(name, fn){fn();tests++;console.log('PASS',name);}
const op={start:0,end:90}, ed={start:1200,end:1290};
check('null, empty and boolean timestamps cannot become zero',()=>{for(const start of [null,'',false,undefined])assert.throws(()=>range({start,end:90},'op'));assert.equal(range({start:null,end:90},'op',{optional:true}),null);assert.deepEqual(range(op,'op'),op);});
check('absence removes its range and preserves the counterpart',()=>{assert.deepEqual(mergeRecord({op,ed},{opAbsent:true}),{ed,opAbsent:true});assert.ok(complete({opAbsent:true,ed}));assert.deepEqual(mergeRecord({opAbsent:true,ed},{op}),{op,ed});});
check('record comparison ignores JSON property ordering',()=>assert.ok(same({op,ed},{ed,op})));

let sequence=0, head='head0', refUpdates=0;
const blobs=new Map(), trees=new Map(), commits=new Map();
function blob(value){const sha='blob'+sequence++;blobs.set(sha,{content:Buffer.from(JSON.stringify(value)).toString('base64'),encoding:'base64'});return sha;}
const initial={1:{anilistId:1,malId:1,title:'Cowboy Bebop',totalEpisodes:2,episodes:{'1':{op,ed}}}};
trees.set('tree0',[{path:'data/aniskip_data.json',type:'blob',sha:blob(initial)}]);commits.set(head,{tree:{sha:'tree0'}});
let upstream=200, failRef=0;
globalThis.fetch=async (url,options={})=>{
  if(String(url).includes('static.crunchyroll.com'))return upstream===200?new Response(JSON.stringify({intro:op,credits:ed}),{status:200}):new Response('{}',{status:upstream});
  if(String(url).includes('graphql.anilist.co'))return new Response(JSON.stringify({data:{Page:{media:[{id:2,idMal:2,episodes:12,title:{english:'New Anime'}}]},Media:{id:2,idMal:2,episodes:12,format:'TV',title:{english:'New Anime'}}}}));
  const path=new URL(url).pathname.replace('/repos/test/test',''), body=options.body?JSON.parse(options.body):null;
  let data;
  if(path==='/git/ref/heads/main')data={object:{sha:head}};
  else if(path.startsWith('/git/commits/')&&!body)data=commits.get(path.split('/').at(-1));
  else if(path.startsWith('/git/trees/')&&!body)data={tree:trees.get(path.split('/').at(-1))};
  else if(path.startsWith('/git/blobs/')&&!body)data=blobs.get(path.split('/').at(-1));
  else if(path==='/git/blobs'&&body){const sha='blob'+sequence++;blobs.set(sha,{content:body.content,encoding:body.encoding});data={sha};}
  else if(path==='/git/trees'&&body){const sha='tree'+sequence++;const prior=trees.get(body.base_tree).filter(x=>!body.tree.some(y=>x.path===y.path));trees.set(sha,[...prior,...body.tree]);data={sha};}
  else if(path==='/git/commits'&&body){const sha='head'+sequence++;commits.set(sha,{tree:{sha:body.tree},parents:body.parents});data={sha};}
  else if(path==='/git/refs/heads/main'&&body){if(failRef-->0)return new Response(JSON.stringify({message:'Branch moved'}),{status:422});assert.equal(commits.get(body.sha).parents[0],head);head=body.sha;refUpdates++;data={object:{sha:head}};}
  else throw Error('Unexpected fetch '+path);
  return new Response(JSON.stringify(data));
};
async function request(handler, mode, body=null, query={}, key='test-admin'){
  const req={method:body?'POST':'GET',headers:{'x-admin-key':key},query:{mode,...query},body:body?{mode,...body}:null};
  const res={status(code){this.code=code;return this;},setHeader(){return this;},end(text){this.body=JSON.parse(text);}};
  await handler(req,res);return res;
}
function database(){const tree=trees.get(commits.get(head).tree.sha);return JSON.parse(Buffer.from(blobs.get(tree.find(x=>x.path==='data/aniskip_data.json').sha).content,'base64'));}
function history(){const tree=trees.get(commits.get(head).tree.sha);const file=tree.find(x=>x.path==='data/editor-history.json');return file?JSON.parse(Buffer.from(blobs.get(file.sha).content,'base64')):[];}
async function pass(name, fn){await fn();tests++;console.log('PASS',name);}
await pass('429 and upstream failures retain retryable classifications',async()=>{for(const code of [429,500,403]){upstream=code;await assert.rejects(fetchCrunchyroll('ABC123'),e=>e.status===(code===429?429:502));}upstream=200;});
await pass('editor rejects unauthenticated requests',async()=>assert.equal((await request(editor,'search',null,{q:'Cowboy'},'wrong')).code,401));
await pass('title search covers local database and optional AniList',async()=>{const r=await request(editor,'search',null,{q:'Cowboy',remote:'1'});assert.equal(r.code,200);assert.equal(r.body.results.length,2);});
let preview;
await pass('preview maps supplied episode without writing',async()=>{preview=await request(editor,'prepare',{malId:1,items:[{episode:52,mediaId:'ABC123'}]});assert.equal(preview.code,200);assert.equal(preview.body.rows[0].episode,52);assert.equal(preview.body.rows[0].status,'ready');assert.equal(refUpdates,0);});
await pass('only genuine 404 is no-data; rate limits are failed',async()=>{upstream=404;let r=await request(editor,'prepare',{malId:1,items:[{episode:2,mediaId:'ABC123'}]});assert.equal(r.body.rows[0].status,'no-data');upstream=429;r=await request(editor,'prepare',{malId:1,items:[{episode:2,mediaId:'ABC123'}]});assert.equal(r.body.rows[0].status,'failed');upstream=200;});
let applied;
await pass('selected apply atomically stores data and audit; retains planned total',async()=>{applied=await request(editor,'apply',{malId:1,items:preview.body.rows});assert.equal(applied.code,200);assert.equal(applied.body.count,1);assert.deepEqual(database()[1].episodes[52],{op,ed});assert.equal(database()[1].totalEpisodes,2);assert.equal(history().length,1);assert.equal(history()[0].changes[0].mediaId,'ABC123');});
await pass('uncertain successful save can be retried without another commit',async()=>{const before=refUpdates;const r=await request(editor,'apply',{malId:1,items:preview.body.rows});assert.equal(r.code,200);assert.equal(r.body.count,0);assert.equal(refUpdates,before);});
await pass('stale preview protects newer records',async()=>{const r=await request(editor,'apply',{malId:1,items:[{episode:1,expected:null,patch:{op:{start:5,end:100}}}]});assert.equal(r.code,409);assert.deepEqual(database()[1].episodes[1],{op,ed});});
await pass('undo restores only imported records and creates an audit entry',async()=>{const r=await request(editor,'undo',{malId:1,historyId:applied.body.historyId});assert.equal(r.code,200);assert.equal(database()[1].episodes[52],undefined);assert.deepEqual(database()[1].episodes[1],{op,ed});assert.equal(history().length,2);});
await pass('double undo is rejected',async()=>assert.equal((await request(editor,'undo',{malId:1,historyId:applied.body.historyId})).code,409));
await pass('absence-only record is complete and excluded from queue',async()=>{const r=await request(editor,'apply',{malId:1,items:[{episode:2,expected:null,patch:{opAbsent:true,edAbsent:true}}]});assert.equal(r.code,200);const q=await request(recordHandler,'missing',null,{malId:1});assert.equal(q.body.count,0);});
await pass('range replaces absence and branch races retry safely',async()=>{failRef=1;const r=await request(editor,'apply',{malId:1,items:[{episode:2,expected:{opAbsent:true,edAbsent:true},patch:{op}}]});assert.equal(r.code,200);assert.deepEqual(database()[1].episodes[2],{op,edAbsent:true});});
await pass('undo cannot overwrite edits made since the original save',async()=>{const old=history().find(e=>e.changes[0].episode===2);const r=await request(editor,'undo',{malId:1,historyId:old.id});assert.equal(r.code,409);});
await pass('duplicate episode keys, invalid ranges and oversized preview are rejected',async()=>{const common={episode:3,expected:null,patch:{op}};assert.equal((await request(editor,'apply',{malId:1,items:[common,common]})).code,400);assert.equal((await request(editor,'apply',{malId:1,items:[{...common,patch:{op:{start:null,end:90}}}]})).code,400);assert.equal((await request(editor,'prepare',{malId:1,items:Array(7).fill({episode:1,mediaId:'ABC123'})})).code,400);});
await pass('history is available with timestamp, source, before and after values',async()=>{const r=await request(editor,'history',null,{malId:1});assert.equal(r.code,200);assert.ok(r.body.entries[0].at);assert.ok(r.body.entries[0].changes[0].source);assert.ok(Object.hasOwn(r.body.entries[0].changes[0],'before'));});
await pass('new MAL entries are created without overwriting another title',async()=>{const r=await request(editor,'apply',{malId:2,items:[{episode:1,expected:null,patch:{op}}]});assert.equal(r.code,200);assert.equal(database()[2].title,'New Anime');});
console.log(`OK: ${tests} editor checks passed; no live services or repository writes were used.`);
