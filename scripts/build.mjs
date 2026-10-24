import ts from 'typescript';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = createHash('sha256');
const fingerprint = dir => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) { const path = resolve(dir,e.name); if(e.isDirectory()) fingerprint(path); else if(e.name !== 'build-id.ts') { hash.update(relative(root, path).split(sep).join('/')); hash.update(readFileSync(path)); } } };
fingerprint(resolve(root,'src'));
writeFileSync(resolve(root,'src/build-id.ts'), `export const BUILD_ID = ${JSON.stringify(hash.digest('hex'))};\n`);
const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, {
 noEmit: false, declaration: true, outDir: resolve(root, 'dist'), rootDir: root,
});
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
 getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
}));
// Emitted JS and declaration module specifiers use Node ESM extensions.
const esmImports = text => text.replace(/(\bfrom\s*["']|\bimport\s*["']|\bimport\s*\(\s*["'])(\.[^"']+)(["'])/g,
 (_, prefix, path, quote) => prefix + (extname(path) ? path : path + '.js') + quote);
rmSync(resolve(root, 'dist'), { recursive: true, force: true });
const emitted = program.emit(undefined, (file, text) => {
 mkdirSync(dirname(file), { recursive: true });
 writeFileSync(file, esmImports(text));
});
if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error('TypeScript distribution emit failed');
