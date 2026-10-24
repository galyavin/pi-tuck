import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, symlinkSync, unlinkSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { isDeepStrictEqual as equal } from 'node:util';
import { root, hash, json, save, noLinks, manifest, verifiedBase, verifyCandidate, fresh, evidenceRoot, scratchRoot, candidateRoot, originalModules, modules } from './gate-source.mjs';
// Default uses only this source tree. External reference is an explicit evidence option.
const [outputArg,scratchArg,referenceArg]=process.argv.slice(2);
if (![4,5].includes(process.argv.length)) throw Error('Usage: gate-suite.mjs FRESH_OUTPUT FRESH_SCRATCH [EXTERNAL_REFERENCE]');
if (os.getPriority()!==19) throw Error('Suite requires nice 19');
const referenceRoot=referenceArg ? resolve(referenceArg) : candidateRoot;
for (const p of [outputArg,scratchArg]) {
  if (p!==resolve(p)) throw Error('Absolute normalized destinations required');
  for (const source of [candidateRoot,referenceRoot]) if (p===source || p.startsWith(source+'/')) throw Error('Outputs must be outside source trees');
}
if (outputArg===scratchArg || outputArg.startsWith(scratchArg+'/') || scratchArg.startsWith(outputArg+'/')) throw Error('Output/scratch must be disjoint');
const base=manifest(referenceRoot), candidateFiles=manifest(candidateRoot);
const started=new Date().toISOString(), receipts=[];
const output=fresh(outputArg,dirname(outputArg)), scratch=fresh(scratchArg,dirname(scratchArg));
const configPath=join(output,'run-config.json');
save(configPath,{referenceRoot,baseManifest:base,evidenceRoot:output,scratchRoot:scratch});
process.env.BENCHMARK_CONFIG=configPath;
const stampFile=f=>f?{bytes:f.bytes,sha256:f.sha256}:null;
const oldFiles=new Map(base.map(f=>[f.path,f])), newFiles=new Map(candidateFiles.map(f=>[f.path,f]));
const candidateChanges=[];
for (const path of [...new Set([...oldFiles.keys(),...newFiles.keys()])].sort()) {
  const b=oldFiles.get(path), a=newFiles.get(path);
  if (!equal(b,a)) candidateChanges.push({kind:!b?'add':!a?'delete':'modify',from:b?path:null,to:a?path:null,before:stampFile(b),after:stampFile(a)});
}
const declarationPath=join(output,'candidate-declaration.json');
save(declarationPath,{version:1,referenceManifestSha256:hash(JSON.stringify(base)),changes:candidateChanges,modules:originalModules});
const candidateIdentity=verifyCandidate(candidateRoot,declarationPath);
const sourcePins=[...manifest(referenceRoot).map(f=>({...f,path:join(referenceRoot,f.path)})),...candidateIdentity.candidateManifest.map(f=>({...f,path:join(candidateRoot,f.path)}))];
// Snapshot direct harness files only; never traverse prior run scratch trees.
for (const name of readdirSync(root).sort()) if (lstatSync(join(root,name)).isFile()) copyFileSync(join(root,name),join(output,name));
// Declaration and run configuration were saved before execution.
save(join(output,'reference-manifest.json'),base);
save(join(output,'preservation-before.json'),sourcePins);
function cli(label,args,expected) {
  const command=[process.execPath,...args], begin=new Date().toISOString();
  const p=spawnSync(command[0],command.slice(1),{cwd:root,encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});
  writeFileSync(join(output,label+'.stdout'),p.stdout??'',{flag:'wx'});
  writeFileSync(join(output,label+'.stderr'),p.stderr??'',{flag:'wx'});
  const receipt={label,command,cwd:root,inheritedNice:os.getPriority(),started:begin,finished:new Date().toISOString(),status:p.status,signal:p.signal,error:p.error?.message,expected};
  save(join(output,label+'.command.json'),receipt); receipts.push(receipt);
  if (p.status!==expected || p.signal || p.error) throw Error(`Unexpected ${label} exit: ${p.status}`);
  return p;
}
function copy(name) {
  const dest=join(scratch,name); mkdirSync(dest);
  for (const f of base) {
    const b=readFileSync(join(referenceRoot,f.path));
    if (b.length!==f.bytes || hash(b)!==f.sha256) throw Error('Reference changed during copy');
    mkdirSync(dirname(join(dest,f.path)),{recursive:true}); writeFileSync(join(dest,f.path),b,{flag:'wx'});
  }
  return dest;
}
const stamp=b=>({bytes:b.length,sha256:hash(b)});
const baseDigest=hash(JSON.stringify(base));
const declaration=(changes=[],mapping=originalModules)=>({version:1,referenceManifestSha256:baseDigest,changes,modules:{...mapping}});
function delta(name,value) { const p=join(output,name+'-delta.json'); save(p,value); return p; }
const change=(kind,from,to,before,after)=>({kind,from,to,before,after});
const path=originalModules['search-entries'], original=readFileSync(join(referenceRoot,path));
const before=stamp(original), comment=Buffer.from(original.toString()+'\n// Harmless declared lexical control.\n');
const refDelta=delta('reference',declaration());
function reject(name,candidate,d=refDelta) {
  const out=join(output,'rejected-'+name), gen=join(scratch,'rejected-generated-'+name);
  const p=cli('reject-'+name,[join(root,'gate-run.mjs'),candidate,d,out,gen],1);
  if (existsSync(out) || existsSync(gen) || p.stdout) throw Error('Rejected source created execution output');
  // The runner validates BEFORE TypeScript loading, transpilation, imports or output allocation.
}
let failure;
try {
  const reference=copy('reference');
  // Validation negatives run before ANY retrieval. No invalid-run execution outputs allowed.
  const undeclared=copy('undeclared'); writeFileSync(join(undeclared,path),comment); reject('undeclared-modification',undeclared);
  const added=copy('undeclared-addition'); writeFileSync(join(added,'undeclared.txt'),'x'); reject('undeclared-addition',added);
  const deleted=copy('undeclared-deletion'); unlinkSync(join(deleted,'RUNTIME.md')); reject('undeclared-deletion',deleted);
  const fileLink=copy('file-symlink'); unlinkSync(join(fileLink,path)); symlinkSync(join(reference,path),join(fileLink,path)); reject('file-symlink',fileLink);
  const rootLink=join(scratch,'root-symlink'); symlinkSync(reference,rootLink); reject('root-symlink',rootLink);
  const ancestorLink=join(scratch,'ancestor-symlink'); symlinkSync(scratch,ancestorLink); reject('ancestor-symlink',join(ancestorLink,'reference'));
  const mod=change('modify',path,path,before,stamp(comment));
  const move=change('move',path,'moved-search.ts',before,before);
  const malformed={
    'wrong-before':declaration([{...mod,before:{bytes:0,sha256:'0'.repeat(64)}}]),
    'wrong-after':declaration([mod]),
    'invalid-traversal':declaration([{...mod,from:'../escape'}]),
    'invalid-normalization':declaration([{...mod,to:'src//bad.ts'}]),
    'invalid-absolute':declaration([{...mod,to:'/escape'}]),
    'invalid-backslash':declaration([{...mod,to:'src\\bad.ts'}]),
    'noop':declaration([{...mod,after:before}]),
    'duplicate':declaration([mod,mod]),
    'duplicate-move':declaration([move,move]),
    'noop-move':declaration([{...move,to:path}]),
    'stale-move':declaration([{...move,from:'missing.ts'}]),
    'unapplied-move':declaration([move],{...originalModules,'search-entries':move.to}),
    'wrong-move-after':declaration([{...move,after:{bytes:0,sha256:'0'.repeat(64)}}],{...originalModules,'search-entries':move.to}),
    'misdeclared-move':declaration([move],{...originalModules,'search-entries':'other.ts'}),
    'stale-mapping':declaration([],{...originalModules,'search-entries':'missing.ts'}),
    'stale-reference':{...declaration(),referenceManifestSha256:'0'.repeat(64)},
    'addition-existing':declaration([change('add',null,path,null,before)]),
    'deletion-missing':declaration([change('delete','missing.ts',null,before,null)]),
    'split-pure-move':declaration([change('delete',path,null,before,null),change('add',null,'moved-search.ts',null,before)])
  };
  for (const [name,d] of Object.entries(malformed)) reject(name,reference,delta(name,d));
  // Exercise a real addition, deletion, five moves (one also modified), and mapped runtime imports.
  const harmless=copy('harmless'), changes=[], mapping={};
  for (const name of modules) {
    const from=originalModules[name], to='lexical-control/'+name+'.ts', b=readFileSync(join(harmless,from)), after=name==='search-entries'?comment:b;
    mkdirSync(dirname(join(harmless,to)),{recursive:true}); writeFileSync(join(harmless,to),after,{flag:'wx'}); unlinkSync(join(harmless,from));
    changes.push(change('move',from,to,stamp(b),stamp(after))); mapping[name]=to;
  }
  const runtime=readFileSync(join(harmless,'RUNTIME.md')); unlinkSync(join(harmless,'RUNTIME.md'));
  changes.push(change('delete','RUNTIME.md',null,stamp(runtime),null));
  const note=Buffer.from('Harmless addition control.\n'); writeFileSync(join(harmless,'lexical-control-note.txt'),note,{flag:'wx'});
  changes.push(change('add',null,'lexical-control-note.txt',null,stamp(note)));
  const harmlessDelta=delta('harmless',declaration(changes,mapping));
  const loss=copy('loss'), marker='const capHits = (hits: SearchHit[], cap: number): SearchResult => {';
  if (original.toString().split(marker).length!==2) throw Error('Mutation anchor not unique');
  const lossBytes=Buffer.from(original.toString().replace(marker,marker+'\n  hits = hits.filter(hit => hit.index !== 0); // deliberate retrieval-loss control'));
  writeFileSync(join(loss,path),lossBytes);
  const lossDelta=delta('loss',declaration([change('modify',path,path,before,stamp(lossBytes))]));
  const candidates={reference:[reference,refDelta],harmless:[harmless,harmlessDelta],loss:[loss,lossDelta],candidate:[candidateRoot,declarationPath]};
  for (const [name,[dir,d]] of Object.entries(candidates)) cli('retrieve-'+name,[join(root,'gate-run.mjs'),dir,d,join(output,name),join(scratch,'generated-'+name)],0);
  copyFileSync(join(output,'reference/result.json'),join(output,'new-reference.json'));
  save(join(output,'reference-establishment.json'),{timestamp:new Date().toISOString(),reference:'new-reference.json',referenceManifestSha256:baseDigest,source:referenceRoot,reason:referenceArg?'NEW same-harness external reference; no historical score comparability inferred.':'NEW same-harness source-tree self reference; not a previous release.',command:process.argv});
  for (const name of ['reference','harmless','loss','candidate']) cli('compare-'+name,[join(root,'gate-compare.mjs'),join(output,'new-reference.json'),join(output,name,'result.json')],name==='loss'?1:0);
  if (!equal(json(join(output,'reference/retrieval-original.json')),json(join(output,'harmless/retrieval-original.json')))) throw Error('Harmless retrieval differs');
  const ref=json(join(output,'new-reference.json')), lossResult=json(join(output,'loss/result.json'));
  if (lossResult.aggregate.numerator>=ref.aggregate.numerator || !receipts.find(r=>r.label==='compare-loss') || !readFileSync(join(output,'compare-loss.stderr'),'utf8').includes('Regression c01:')) throw Error('Loss did not produce real expected regression');
  for (const name of Object.keys(candidates)) if (!equal(ref.dependencies,json(join(output,name,'result.json')).dependencies)) throw Error('Dependency identity changed');
  cli('reject-existing-output',[join(root,'gate-run.mjs'),reference,refDelta,join(output,'reference'),join(scratch,'not-created')],1);
  if (existsSync(join(scratch,'not-created'))) throw Error('Existing-output rejection created generated files');
  // Revalidate full accepted sources and candidate; do not rewrite either.
  verifiedBase(); verifyCandidate(candidateRoot,declarationPath);
  for (const f of sourcePins) { noLinks(f.path); const b=readFileSync(f.path); if (b.length!==f.bytes || hash(b)!==f.sha256) throw Error('Source preservation failure'); }
  save(join(output,'preservation-after.json'),{timestamp:new Date().toISOString(),referenceAndCandidateUnchanged:true});
} catch (e) { failure=e; }
save(join(output,'suite.json'),{started,finished:new Date().toISOString(),command:process.argv,cwd:root,nice:os.getPriority(),status:failure?1:0,error:failure?.message,receipts,limits:'Local synthetic lexical gate only. No paired-release, integration, semantic, platform or general-quality claim.'});
if (failure) throw failure;
console.log(JSON.stringify({output,scratch,status:0}));
