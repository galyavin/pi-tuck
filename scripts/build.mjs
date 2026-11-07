import ts from 'typescript';
import { sourceId } from './source-id.mjs';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
writeFileSync(resolve(root,'src/build-id.ts'), `export const BUILD_ID = ${JSON.stringify(sourceId(root))};\n`);
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
