import { modules, validateManifest, hash } from './gate-source.mjs';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual as equal } from 'node:util';
import { pathToFileURL } from 'node:url';
export function validateIdentity(result) {
  for (const key of ['corpusSha256','scorerSha256','lexicalSourceSha256']) if (!/^[a-f0-9]{64}$/.test(result[key])) throw Error(`Invalid ${key}`);
  if ('originSha' in result || 'sourceCommit' in result || result.referenceIdentity!=='synthetic-source-reference-v1') throw Error('Invalid candidate identity');
  validateManifest(result.candidateManifest);
  if (hash(JSON.stringify(result.candidateManifest))!==result.candidateManifestSha256) throw Error('Invalid manifest digest');
  if (!result.moduleMapping || !equal(Object.keys(result.moduleMapping).sort(),modules.slice().sort())) throw Error('Invalid mapping');
  if (!Array.isArray(result.lexicalSourceFiles) || result.lexicalSourceFiles.length!==modules.length ||
      result.lexicalSourceFiles.some((p,i)=>!Array.isArray(p) || p.length!==2 || p[0]!==modules[i] || !/^[a-f0-9]{64}$/.test(p[1]) || result.candidateManifest.find(f=>f.path===result.moduleMapping[p[0]])?.sha256!==p[1]) ||
      hash(JSON.stringify(result.lexicalSourceFiles))!==result.lexicalSourceSha256) throw Error('Lexical/full manifest mismatch');
}
export function compare(baseline, candidate) {
  const validate = result => {
    validateIdentity(result);
    if (typeof result.corpusId !== 'string' || !result.corpusId || !result.budgets || typeof result.budgets !== 'object' || Array.isArray(result.budgets) || !Object.keys(result.budgets).length) throw Error('Missing fixture/budgets');
    if (!Array.isArray(result.cases) || !result.cases.length) throw Error('Missing cases');
    let numerator = 0, denominator = 0;
    const ids = new Set();
    for (const c of result.cases) {
      if (typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.query !== 'string') throw Error('Invalid/duplicate case');
      ids.add(c.id);
      if (!Array.isArray(c.facts) || !c.facts.length || c.facts.some(f => typeof f.delivered !== 'boolean' || typeof f.source !== 'string' || !f.source || typeof f.text !== 'string' || !f.text)) throw Error('Invalid facts');
      if (c.denominator !== c.facts.length || c.numerator !== c.facts.filter(f => f.delivered).length) throw Error('Invalid case score');
      numerator += c.numerator; denominator += c.denominator;
    }
    if (numerator !== result.aggregate?.numerator || denominator !== result.aggregate?.denominator) throw Error('Invalid aggregate');
  };
  validate(baseline); validate(candidate);
  // Source identities are validated and retained, but deliberately not equality gates.
  for (const key of ['corpusId','corpusSha256','scorerSha256','budgets']) {
    if (!equal(baseline[key],candidate[key])) throw Error(`Incomparable ${key}`);
  }
  if (baseline.cases.length !== candidate.cases.length) throw Error('Changed cases');
  for (let i = 0; i < baseline.cases.length; i++) {
    const b = baseline.cases[i], c = candidate.cases[i];
    if (b.id !== c.id || b.query !== c.query || !equal(b.facts.map(({source,text})=>({source,text})), c.facts.map(({source,text})=>({source,text})))) throw Error('Changed expected facts/query');
    if (c.numerator < b.numerator) throw Error(`Regression ${c.id}: ${c.numerator}/${c.denominator} < ${b.numerator}/${b.denominator}`);
  }
  if (candidate.aggregate.numerator < baseline.aggregate.numerator) throw Error('Aggregate regression');
  return 'PASS: no lower score on this fixed synthetic lexical fixture (not release evidence)';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(compare(...process.argv.slice(2,4).map(p => JSON.parse(readFileSync(p,'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
