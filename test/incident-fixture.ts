import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDirectory } from '../src/windows-private-storage';

/** Windows temp parents may grant access to sandbox groups or other unknown SIDs. */
export async function privateIncidentDirectory(prefix = 'pi-incident-'): Promise<string> {
 if (process.platform !== 'win32') return mkdtempSync(join(tmpdir(), prefix));
 const directory = join(tmpdir(), prefix + randomUUID());
 await createPrivateDirectory(directory);
 return directory;
}
