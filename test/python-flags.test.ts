import {expect,test} from 'vitest';
import {pythonFlags} from './python-fixture';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
// The managed Python tree is verified file by file, and one stray .pyc refuses the runtime. A test that runs the interpreter itself without -B writes bytecode into
// that tree (-I ignores PYTHONDONTWRITEBYTECODE, so only an explicit -B stops it). Every direct launch passes -B or the shared `pythonFlags` first.
const directory=fileURLToPath(new URL('./',import.meta.url));
const launch=/\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*(?:testPython|process\.env\.AB1_[A-Z_]*PYTHON[^,]*)\s*,\s*\[/g;
export function launchesWithoutBytecodeFlag(text:string):string[]{
 return [...text.matchAll(launch)].filter(match=>!/^\s*(?:\.\.\.pythonFlags|['"]-B['"]|['"]-I['"]\s*,\s*['"]-B['"])/.test(text.slice(match.index+match[0].length,match.index+match[0].length+80))).map(match=>text.slice(match.index,match.index+90).split('\n')[0]!);
}
test('every test that runs Python itself passes -B (or the shared pythonFlags) first',()=>{
 const found:string[]=[];
 for(const name of readdirSync(directory).filter(file=>file.endsWith('.ts')&&file!=='python-flags.test.ts'))for(const call of launchesWithoutBytecodeFlag(readFileSync(join(directory,name),'utf8')))found.push(name+': '+call);
 expect(found).toEqual([]);
});
test('the shared flags themselves keep bytecode off and isolate the interpreter',()=>{expect(pythonFlags).toContain('-B');expect(pythonFlags).toContain('-I');});
test('the check itself recognises the unsafe and the safe forms',()=>{
 expect(launchesWithoutBytecodeFlag("execFileSync(testPython,['-I','-c',`x`])")).toHaveLength(1);
 expect(launchesWithoutBytecodeFlag("spawnSync(testPython, ['-c', 'x'])")).toHaveLength(1);
 expect(launchesWithoutBytecodeFlag("spawn(testPython,[script])")).toHaveLength(1);
 expect(launchesWithoutBytecodeFlag("execFileSync(testPython,[...pythonFlags,'-c','x'])")).toEqual([]);
 expect(launchesWithoutBytecodeFlag("execFileSync(testPython, ['-I', '-B', path])")).toEqual([]);
 expect(launchesWithoutBytecodeFlag("spawnSync(testPython,['-B',script])")).toEqual([]);
 expect(launchesWithoutBytecodeFlag("execFileSync(process.env.AB1_TEST_PYTHON ?? 'python3', ['-c','x'])")).toHaveLength(1);
});
