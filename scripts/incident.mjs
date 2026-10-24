import { readFile, writeFile, stat } from 'node:fs/promises';
import { inspectIncident, readableIncident } from '../dist/src/diagnostic-replay.js';
const [command, input, output] = process.argv.slice(2);
if (!['export','replay'].includes(command) || !input || !output) throw new Error('Usage: node scripts/incident.mjs export|replay incident.jsonl output');
if ((await stat(input)).size > 10000000) throw new Error('Incident exceeds offline input bound');
const raw = await readFile(input, 'utf8');
if (Buffer.byteLength(raw) > 10000000) throw new Error('Incident exceeds offline input bound');
const records = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
await writeFile(output, command === 'export' ? readableIncident(records) : JSON.stringify(inspectIncident(records), null, 2), { mode: 0o600, flag: 'wx' });
