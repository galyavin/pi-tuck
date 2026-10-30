import { pythonFlags, testPython, testNativeOwner } from './python-fixture';
import {expect,test} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createSemanticRecall,semanticEligibleSources} from '../src/semantic-recall';
test('SQLite key filtering and status projection preserve existing rowid order for tied vectors within batches',()=>{
 const root=mkdtempSync(join(tmpdir(),'semantic-sqlite-')),runtime=join(root,'runtime');mkdirSync(runtime);
 for(const name of ['pins.json','assets.sha256.json','requirements.lock'])writeFileSync(join(runtime,name),'{}');
 try {
  const output=execFileSync(testPython,[...pythonFlags,'-c',`
import os,sys,pathlib,sqlite3,json
os.environ['PI_SEMANTIC_RUNTIME_ROOT']=sys.argv[1]
source=pathlib.Path(sys.argv[2]).read_text()
ns={'__file__':sys.argv[2]}
exec(compile(source.split('\\ntry:\\n while True:')[0],sys.argv[2],'exec'),ns)
path=str(pathlib.Path(sys.argv[1]).resolve().parent/'cache.sqlite')
def call(action,**extra):return ns['index']({'path':path,'projectDirectory':str(pathlib.Path(sys.argv[1]).parent/'project'),'identity':'same','action':action,**extra})
assert call('status',keys=['missing'])=={'coveredKeys':[]}
assert call('score',keys=['missing'],query=[1.0]+[0.0]*767)=={'ranked':[],'observed':0}
vector=[1.0]+[0.0]*767
rows=[{'key':key,'entryId':key,'start':0,'end':1,'inputSha':key,'vector':vector} for key in ['z','a','unrequested','wrong']]
call('upsert',rows=rows)
db=sqlite3.connect(path);db.execute("UPDATE records SET vector=? WHERE key='unrequested'",(b'bad',));db.execute("UPDATE records SET identity='other' WHERE key='wrong'");db.commit();db.close()
queries=[];connect=sqlite3.connect
def traced(*args,**kwargs):
 db=connect(*args,**kwargs);db.set_trace_callback(queries.append);return db
sqlite3.connect=traced
scored=call('score',keys=['a','z','wrong','missing','z'],query=vector)
status=call('status',keys=['unrequested','z','wrong'])
empty=call('score',keys=[],query=vector)
print(json.dumps({'ranked':scored['ranked'],'observed':scored['observed'],'status':status,'empty':empty,'queries':queries}))
`,runtime,fileURLToPath(new URL('../scripts/semantic-worker.py',import.meta.url))],{encoding:'utf8'});
  const result=JSON.parse(output) as {ranked:{key:string;score:number}[];observed:number;status:{coveredKeys:string[]};empty:{ranked:unknown[];observed:number};queries:string[]};
  expect(result.ranked.map(r=>r.key)).toEqual(['z','a']);expect(result.ranked[0]!.score).toBe(1);expect(result.ranked[1]!.score).toBe(1);expect(result.observed).toBe(2);expect(result.status).toEqual({coveredKeys:['z','unrequested']});expect(result.empty).toEqual({ranked:[],observed:0});
  const selects=result.queries.filter(q=>q.startsWith('SELECT'));expect(selects).toHaveLength(2);expect(selects.every(q=>q.includes('key IN (')&&q.endsWith('ORDER BY rowid'))).toBe(true);expect(selects[1]).toMatch(/^SELECT key FROM/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

// The worker scores the window's vectors and returns the stable top 24; node merges chunks of 1024 keys. The reference is the path this replaced: every vector
// read in 128-key batches in rowid order, scored with a JS reduce over float64 values, stable-sorted and cut to 24 after each batch. The fixture has exact-duplicate vectors
// inside one batch, across the 128 boundary and across the 1024-key chunk boundary, and more top-scoring duplicates than the 24 that are kept, so the cut falls inside a tie group.
test('worker scoring in chunks gives the same top 24, scores included, as a full listing scored with a JS reduce, ties and all',async()=>{
// The worker refuses an index path through a symlink, and macOS's temporary folder sits under one (/var → /private/var).
 const root=mkdtempSync(join(realpathSync(tmpdir()),'semantic-score-')),runtime=join(root,'runtime'),project=join(root,'project'),database=join(root,'cache.sqlite');mkdirSync(runtime);mkdirSync(project);
 for(const name of ['pins.json','assets.sha256.json','requirements.lock'])writeFileSync(join(runtime,name),'{}');
 const worker=fileURLToPath(new URL('../scripts/semantic-worker.py',import.meta.url));
 // Each argument is a list of index requests; the results come back as a list.
 const script=`
import os,sys,pathlib,json
os.environ['PI_SEMANTIC_RUNTIME_ROOT']=sys.argv[1]
source=pathlib.Path(sys.argv[2]).read_text()
ns={'__file__':sys.argv[2]}
exec(compile(source.split('\\ntry:\\n while True:')[0],sys.argv[2],'exec'),ns)
print(json.dumps([ns['index'](r) for r in json.load(sys.stdin)]))
`;
 const index=(requests:object[])=>JSON.parse(execFileSync(testPython,[...pythonFlags,'-c',script,runtime,worker],{input:JSON.stringify(requests),encoding:'utf8',maxBuffer:1<<26})) as any[];
 const request=(action:string,extra:object)=>({path:database,projectDirectory:project,identity:'same',action,...extra});
 try{
  let seed=7;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;},make=()=>Array.from({length:768},()=>random()*2-1);
  const query=make(),top=[3,4,5,40,41,42,43,60,61,127,128,129,200,300,511,512,600,601,700,800,900,901,902,1000,1023,1024,1025,1100,1150,1151,1152,1199],second=[10,11,500,1030],pool=[query,query.map(x=>x/2),...Array.from({length:58},make)];
  const N=1200,vectorOf=(i:number)=>(top.includes(i)?pool[0]!:second.includes(i)?pool[1]!:pool[2+i%58]!).map(Math.fround); // stored as float32
  const keys=Array.from({length:N},(_,i)=>'k'+i);
  // Stored newest key first, so rowid order inside a 128-key batch is the reverse of key order: the old path ranked ties in rowid order within each batch.
  const stored=keys.map((_,i)=>N-1-i);
  index(Array.from({length:N/8},(_,b)=>request('upsert',{rows:stored.slice(b*8,b*8+8).map(i=>({key:keys[i]!,entryId:keys[i]!,start:0,end:1,inputSha:keys[i]!,vector:(top.includes(i)?pool[0]!:second.includes(i)?pool[1]!:pool[2+i%58]!)}))})));
  // The old path.
  const dot=(v:number[])=>v.reduce((sum,x,i)=>sum+x*query[i]!,0);
  let reference:{key:string;score:number}[]=[];
  for(let offset=0;offset<N;offset+=128){reference.push(...keys.slice(offset,offset+128).map((key,j)=>({key,score:dot(vectorOf(offset+j))})).reverse()); /* rowid order */reference.sort((a,b)=>b.score-a.score);reference=reference.slice(0,24);}
  expect(reference).toHaveLength(24);expect(top.filter(i=>i<1024).length).toBeGreaterThan(24); // the first chunk alone holds more ties than the cut keeps, so the cut falls inside a tie group
  expect(new Set(reference.map(r=>r.score)).size).toBe(1);
  // The new path: the node merge of chunks as searchOwned sends them, with the real worker action.
  const cm=SessionManager.inMemory(project);for(let i=0;i<N;i++)cm.appendMessage({role:'user',content:'source '+i,timestamp:1});
  const provider=()=>semanticEligibleSources({cwd:project,sessionManager:cm},{},()=>{}),initial=provider();
  const semantic=createSemanticRecall({pythonPath:'/unused',runtimeRoot:runtime,indexDirectory:join(root,'index')}) as any;
  semantic.enabled=true;semantic.current=initial;initial.complete=true;semantic.worker={close:async()=>{}}; // no cut here, so a running worker is what lets the search rank
  initial.units=initial.sources.map((source:any,i:number)=>({source,key:keys[i]!,entryId:source.entry.id,start:0,end:source.sourceText.length,encoded:source.sourceText,inputSha:source.sha}));initial.indexed=new Set(initial.units.map((u:any)=>u.key));
  initial.window={order:initial.sources,counts:initial.sources.map(()=>1),searchUnits:0,windowCharacters:0,eligibleCharacters:0,conversationOutOfView:0,toolOutOfView:0};
  const chunks:{keys:number;ranked:{key:string;score:number}[];observed:number}[]=[];
  semantic.runtime=async()=>({call:async(op:string,input:any)=>{
   if(op==='embed')return{vectors:[query]};
   expect(op).toBe('index');expect(input.action).toBe('score');expect(input.query).toEqual(query);
   const [result]=index([request('score',{keys:input.keys,query:input.query})]);chunks.push({keys:input.keys.length,ranked:result.ranked,observed:result.observed});return result;
  }});
  let ranked:string[]|undefined;const assemble=semantic.assemble.bind(semantic);semantic.assemble=(units:any[],...rest:unknown[])=>{ranked=units.map(u=>u.key);return assemble(units,...rest);};
  const page=await semantic.search('query',provider);
  expect(page.status).toBe('ok');
  expect(chunks.map(c=>c.keys)).toEqual([1024,176]);expect(chunks.map(c=>c.observed)).toEqual([1024,176]);
  expect(ranked).toEqual(reference.map(r=>r.key));
  for(const chunk of chunks)for(const row of chunk.ranked)expect(row.score).toBe(dot(vectorOf(Number(row.key.slice(1))))); // bit-identical, not merely close
  await semantic.close();
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
