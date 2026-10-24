import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, posix } from 'node:path';
import os from 'node:os';
import { root, hash, verifyCandidate, fresh, evidenceRoot, scratchRoot, save, modules, noLinks } from './gate-source.mjs';
const [candidate, declaration, outputArg, generatedArg] = process.argv.slice(2);
if (process.argv.length !== 6) throw Error('Usage: gate-run.mjs CANDIDATE DELTA OUTPUT GENERATED');
if (os.getPriority() !== 19) throw Error('Execution requires nice 19');
// Full base and declared candidate delta are checked before loading candidate code.
const identity = verifyCandidate(candidate, declaration);
const read = p => readFileSync(join(root,p),'utf8');
const sha = hash;
const require = createRequire(import.meta.url);
const tsPath = process.env.BENCHMARK_TYPESCRIPT || require.resolve('typescript/package.json').replace(/[/\\]package\.json$/,'');
// Read-only compiler resolution: declared development dependency or explicit local override.
const ts = createRequire(import.meta.url)(tsPath);
if (ts.version !== '5.9.3') throw Error('Requires declared TypeScript 5.9.3');
const evidence = fresh(outputArg,evidenceRoot());
const generated = fresh(generatedArg,scratchRoot());
const sourceParts = [];
for (const name of modules) {
  const sourcePath = identity.moduleMapping[name];
  noLinks(join(candidate,sourcePath));
  const source = readFileSync(join(candidate,sourcePath),'utf8');
  if (sha(source) !== identity.candidateManifest.find(f=>f.path===sourcePath)?.sha256) throw Error('Candidate changed after verification');
  sourceParts.push([name,sha(source)]);
  const emitted = ts.transpileModule(source, { compilerOptions: {target: ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},reportDiagnostics:true });
  if (emitted.diagnostics?.length) throw Error('TypeScript transpilation diagnostics');
  // ESM extension resolution only; original lexical implementation is unchanged.
  const js = emitted.outputText.replace(/(from\s+["'])([^"']+)(["'])/g, (_all,a,s,b) => {
    if (!s.startsWith('.')) throw Error('Unexpected runtime dependency: '+s);
    const target = posix.normalize(posix.join(posix.dirname(sourcePath),s.replace(/\.(js|mjs|ts)$/,'')))+'.ts';
    const mapped = modules.find(n=>identity.moduleMapping[n]===target);
    if (!mapped) throw Error('Runtime import outside five declared lexical modules: '+s);
    return a+'./'+mapped+'.mjs'+b;
  });
  // Fail closed on emitted runtime imports not handled by the static mapping.
  const parsed = ts.createSourceFile(name+'.mjs',js,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  const allowed = new Set(modules.map(n=>'./'+n+'.mjs'));
  function inspect(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && !allowed.has(node.moduleSpecifier.text)) throw Error('Unmapped runtime import');
    if (ts.isCallExpression(node) && (node.expression.kind===ts.SyntaxKind.ImportKeyword || node.expression.getText(parsed)==='require')) throw Error('Dynamic dependency not authorized');
    ts.forEachChild(node,inspect);
  }
  inspect(parsed);
  writeFileSync(join(generated,name+'.mjs'),js);
}
// Persist emitted/source identities before importing or executing candidate code.
save(join(evidence,'generated-manifest.json'), modules.map(name=>({path:name+'.mjs',sha256:sha(readFileSync(join(generated,name+'.mjs'))),sourcePath:identity.moduleMapping[name],sourceSha256:sourceParts.find(p=>p[0]===name)[1]})));
save(join(evidence,'execution-inputs.json'),{...identity,node:process.version,nodeExecutableSha256:sha(readFileSync(process.execPath)),typescript:ts.version,typescriptLibrarySha256:sha(readFileSync(join(tsPath,'lib/typescript.js'))),typescriptPackageSha256:sha(readFileSync(join(tsPath,'package.json'))),timestamp:new Date().toISOString(),command:process.argv});
const { searchEntriesDetailed } = await import(pathToFileURL(join(generated,'search-entries.mjs')));
const corpusText = read('corpus.json'), corpus = JSON.parse(corpusText);
const budgets = {semantics:false, cap:3, relativeFloor:0.2, deliveredCharacters:1200, searchDeadlineMs:3000, snippetContextLines:2};
const entries = corpus.documents.map((d,index) => ({index,role:d.role,summary:d.text,files:[]}));
const messages = corpus.documents.map(d => ({role:d.role,content:d.text,timestamp:0}));
const cases = [], raw = [];
for (const c of corpus.cases) {
  for (const f of c.expected) {
    const doc = corpus.documents.find(d=>d.id===f.source);
    if (!doc || !doc.text.includes(f.text)) throw Error(`Unbacked expectation ${c.id}`);
  }
  const original = searchEntriesDetailed(entries,messages,c.query,{cap:budgets.cap,relativeFloor:budgets.relativeFloor});
  let remaining = budgets.deliveredCharacters;
  // Score only delivered snippets, not full source, summaries, or query strings.
  const delivered = original.hits.map(hit=> {
    const text = (hit.snippet ?? '').slice(0,remaining); remaining -= text.length;
    return {source:corpus.documents[hit.index].id,text};
  });
  const facts = c.expected.map(f=>({...f,delivered:delivered.some(d=>d.source===f.source && d.text.includes(f.text))}));
  cases.push({id:c.id,query:c.query,numerator:facts.filter(f=>f.delivered).length,denominator:facts.length,facts});
  raw.push({id:c.id,query:c.query,original,delivered});
}
const result = {
  claim:'Fresh synthetic lexical evidence only; not prior-release, semantic, cross-platform or overall quality.',
  ...identity,
  corpusId:corpus.id,corpusSha256:sha(corpusText),
  scorerSha256:sha(['gate-run.mjs','gate-compare.mjs','gate-source.mjs','gate-suite.mjs','scoring-block.txt','compare-block.txt','pins.json'].map(read).join('\n')),
  lexicalSourceSha256:sha(JSON.stringify(sourceParts)), lexicalSourceFiles:sourceParts,
  budgets, dependencies:{node:process.version,typescript:ts.version,typescriptPath:tsPath,typescriptLibrarySha256:sha(readFileSync(join(tsPath,'lib/typescript.js'))),nodeExecutableSha256:sha(readFileSync(process.execPath)),typescriptPackageSha256:sha(readFileSync(join(tsPath,'package.json'))),runtimePeers:'none: type-only peer imports erased; extension host not loaded'},
  timestamp:new Date().toISOString(),command:process.argv.join(' '),cases,
  aggregate:{numerator:cases.reduce((s,c)=>s+c.numerator,0),denominator:cases.reduce((s,c)=>s+c.denominator,0)},exitStatus:0
};
writeFileSync(join(evidence,'retrieval-original.json'),JSON.stringify(raw,null,2)+'\n');
writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n');
for (const c of cases) console.log(`${c.id}: ${c.numerator}/${c.denominator}`);
console.log(JSON.stringify(result,null,2));
