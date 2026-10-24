import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
export const root = dirname(fileURLToPath(import.meta.url));
export const candidateRoot = resolve(root,'..');
export const modules = ['search-entries','recall-operation','content','keyword-query','tool-args'];
export const originalModules = Object.fromEntries(modules.map(n=>[n,`src/pi-tuck/core/${n}.ts`]));
export const config = () => json(process.env.BENCHMARK_CONFIG);
export const referenceRoot = () => config().referenceRoot;
export const evidenceRoot = () => config().evidenceRoot;
export const scratchRoot = () => config().scratchRoot;
export const hash = b => createHash('sha256').update(b).digest('hex');
export const json = p => JSON.parse(readFileSync(p,'utf8'));
export const save = (p,v) => writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
export function noLinks(path) {
  if (path !== resolve(path)) throw Error('Absolute normalized path required');
  for (let p=path;;p=dirname(p)) {
    if (lstatSync(p).isSymbolicLink()) throw Error(`Source/path symlink: ${p}`);
    if (p===dirname(p)) return path;
  }
}
export function validPath(p) {
  if (typeof p!=='string' || !p || !/^[A-Za-z0-9_.\/-]+$/.test(p) || p!==posix.normalize(p) || p.startsWith('/') || p.split('/').some(s=>!s || s==='.' || s==='..' || s==='.git')) throw Error(`Invalid relative path: ${p}`);
  return p;
}
export function manifest(dir) {
  noLinks(dir); const files=[];
  function walk(rel) {
    const p=rel?join(dir,rel):dir, s=lstatSync(p);
    if (s.isSymbolicLink()) throw Error(`Source symlink: ${p}`);
    if (s.isDirectory()) for (const n of readdirSync(p).sort()) {
      // Repository metadata, installed dependencies and build output are not source inputs.
      if (!rel && ['.git','node_modules','dist'].includes(n)) continue;
      walk(rel?rel+'/'+n:n);
    }
    else if (s.isFile()) { validPath(rel); const b=readFileSync(p); files.push({path:rel,bytes:b.length,sha256:hash(b)}); }
    else throw Error(`Non-regular source file: ${p}`);
  }
  walk(''); return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
const keys=(v,k)=>v && typeof v==='object' && !Array.isArray(v) && equal(Object.keys(v).sort(),k.slice().sort());
const stamp=f=>({bytes:f.bytes,sha256:f.sha256});
const validStamp=v=>keys(v,['bytes','sha256']) && Number.isSafeInteger(v.bytes) && v.bytes>=0 && /^[a-f0-9]{64}$/.test(v.sha256);
export function validateManifest(files) {
  if (!Array.isArray(files) || !files.length) throw Error('Empty/invalid manifest');
  for (let i=0;i<files.length;i++) {
    const f=files[i];
    if (!keys(f,['path','bytes','sha256']) || !validStamp(stamp(f))) throw Error('Invalid manifest record');
    validPath(f.path);
    if (i && files[i-1].path.localeCompare(f.path,'en')>=0) throw Error('Unsorted/duplicate manifest');
  }
}
export function checkPins() {
  const scoring=s=>s.slice(s.indexOf('const corpusText ='),s.indexOf('const result ='));
  const comparison=s=>s.slice(s.indexOf('export function compare('),s.indexOf('if (process.argv[1]'));
  for (const [name,extract,block] of [['gate-run.mjs',scoring,'scoring-block.txt'],['gate-compare.mjs',comparison,'compare-block.txt']]) {
    if (extract(readFileSync(join(root,name),'utf8'))!==readFileSync(join(root,block),'utf8')) throw Error('Scoring/comparison block changed');
  }
  for (const f of json(join(root,'pins.json'))) {
    const b=readFileSync(join(root,f.path));
    if (b.length!==f.bytes || hash(b)!==f.sha256) throw Error('Harness/fixture pin mismatch: '+f.path);
  }
}
export function verifiedBase() {
  checkPins();
  const base=config().baseManifest;
  validateManifest(base);
  if (!equal(manifest(referenceRoot()),base)) throw Error('Full reference manifest mismatch');
  return base;
}
export function verifyCandidate(candidate, declarationPath) {
  noLinks(candidate); noLinks(declarationPath);
  const base=verifiedBase(), declaration=json(declarationPath);
  if (!keys(declaration,['version','referenceManifestSha256','changes','modules']) || declaration.version!==1 || declaration.referenceManifestSha256!==hash(JSON.stringify(base)) || !Array.isArray(declaration.changes)) throw Error('Invalid declaration/reference digest');
  const before=new Map(base.map(f=>[f.path,f])), expected=new Map(before), sources=new Set(), targets=new Set();
  for (const c of declaration.changes) {
    if (!keys(c,['kind','from','to','before','after']) || !['add','delete','modify','move'].includes(c.kind)) throw Error('Invalid change shape');
    const hasBefore=c.kind!=='add', hasAfter=c.kind!=='delete';
    if (hasBefore) {
      validPath(c.from);
      if (sources.has(c.from) || !before.has(c.from) || !validStamp(c.before) || !equal(c.before,stamp(before.get(c.from)))) throw Error('Duplicate/stale/wrong before');
      sources.add(c.from);
    } else if (c.from!==null || c.before!==null) throw Error('Invalid addition');
    if (hasAfter) {
      validPath(c.to);
      if (targets.has(c.to) || !validStamp(c.after)) throw Error('Duplicate/invalid after');
      targets.add(c.to);
    } else if (c.to!==null || c.after!==null) throw Error('Invalid deletion');
    if (c.kind==='modify' && (c.from!==c.to || equal(c.before,c.after))) throw Error('Invalid/no-op modification');
    if (c.kind==='move' && c.from===c.to) throw Error('No-op/misdeclared move');
  }
  for (const c of declaration.changes) {
    if (c.kind==='add' && before.has(c.to)) throw Error('Addition uses an existing path');
    if (c.kind==='move' && before.has(c.to) && !sources.has(c.to)) throw Error('Move overwrites undeclared file');
    if (c.kind==='delete' && declaration.changes.some(a=>a.kind==='add' && equal(a.after,c.before))) throw Error('Pure move misdeclared as delete/add');
    if (c.from!==null) expected.delete(c.from);
  }
  for (const c of declaration.changes) if (c.to!==null) expected.set(c.to,{path:c.to,...c.after});
  if (!keys(declaration.modules,modules)) throw Error('Exactly five module mappings required');
  const mapped=new Set();
  for (const name of modules) {
    const p=validPath(declaration.modules[name]), original=originalModules[name];
    const operation=declaration.changes.find(c=>c.from===original);
    const intended=operation ? operation.to : original;
    if (!p.endsWith('.ts') || p!==intended || !expected.has(p) || mapped.has(p)) throw Error(`Stale/misdeclared module move: ${name}`);
    mapped.add(p);
  }
  const files=manifest(candidate), wanted=[...expected.values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if (!equal(files,wanted)) throw Error('Undeclared source change or declared delta mismatch');
  return {referenceIdentity:'synthetic-source-reference-v1',baseManifest:base,baseManifestSha256:hash(JSON.stringify(base)),candidateManifest:files,candidateManifestSha256:hash(JSON.stringify(files)),declaration,moduleMapping:declaration.modules};
}
export function fresh(path,parent) {
  if (path!==resolve(path)) throw Error('Output must be absolute normalized');
  const rel=relative(parent,path);
  if (!rel || rel.startsWith('../') || rel==='..') throw Error('Output outside authorized area');
  noLinks(dirname(path)); mkdirSync(path); return path;
}
