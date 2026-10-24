import { pythonFlags, testPython } from './python-fixture';
import {test,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('the worker gives llama-server a short grace after the group signal before it sends its own terminate (no second interrupt), and still ends a server that ignores it',()=>{
 // A stdlib unittest against a fake llama-server; it runs with the suite so the close ordering is guarded, not just once proved.
 expect(()=>execFileSync(testPython,[...pythonFlags,fileURLToPath(new URL('./semantic-worker-close.test.py',import.meta.url))],{encoding:'utf8',stdio:'pipe'})).not.toThrow();
});
