#!/usr/bin/env node
/** Export trees, overlay the same tests, share dependencies read-only, and leave .git alone. */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(join(tmpdir(), 'pi-shapes-'));
const output = resolve(process.argv[2] ?? join(root, 'test/shapes/results'));
mkdirSync(output, { recursive: true });
const builds = ['v1.0.16', 'v1.0.15', '7bcd355'];
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function archive(ref, destination) {
  mkdirSync(destination);
  const git = spawn('git', ['archive', ref], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const tar = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'inherit', 'inherit'] });
  git.stdout.pipe(tar.stdin);
  await Promise.all([git, tar].map(child => new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`archive ${ref}: exit ${code}`)));
  })));
}
try {
  const reports = [];
  for (const build of builds) {
    const tree = join(scratch, build);
    await archive(build, tree);
    // Remove old tests before overlaying, so all builds execute exactly the same test tree.
    rmSync(join(tree, 'test'), { recursive: true });
    cpSync(join(root, 'test'), join(tree, 'test'), { recursive: true, filter: path => !path.startsWith(join(root, 'test/shapes/results')) });
    symlinkSync(realpathSync(join(root, 'node_modules')), join(tree, 'node_modules'), 'dir');
    const reportPath = join(output, `${build}.json`);
    await run(process.execPath, [join(tree, 'node_modules/vitest/vitest.mjs'), 'run', 'test/shapes/session-shapes.test.ts', '--testTimeout=300000'], {
      cwd: tree, env: { ...process.env, SHAPES: '1', SHAPES_RECORD_BASELINE: '1', SHAPES_STRICT: '0', SHAPES_BUILD: build, SHAPES_REPORT: reportPath },
    });
    reports.push(JSON.parse(readFileSync(reportPath, 'utf8')));
  }
  const lines = [
    '# Session shape comparison', '',
    'Reserve 16,384; keepRecent 20,000. Default adaptive cut, real Pi and the stress suite’s scripted provider.', '',
    'P = current prompt whole; O = first/newest eight answered openings; M = counted omissions with source pointers; R = refusal only for an above-room prompt. A dash means all four checks passed.', '',
    '| Shape | Window | v1.0.16 | v1.0.15 | 7bcd355 |',
    '| --- | ---: | --- | --- | --- |',
  ];
  const codes = { 'current-prompt': 'P', openings: 'O', omissions: 'M', refusal: 'R' };
  for (const row of reports[0].rows) {
    const cells = reports.map(report => {
      const found = report.rows.find(other => other.shape === row.shape && other.window === row.window);
      if (!found) throw new Error(`Missing cell ${report.build}/${row.shape}/${row.window}`);
      return Object.entries(codes).filter(([rule]) => found.failures.some(failure => failure.rule === rule)).map(([, code]) => code).join(', ') || '—';
    });
    lines.push(`| ${row.shape} | ${row.window.toLocaleString('en-US')} | ${cells.join(' | ')} |`);
  }
  lines.push('', '| Build | Cells | Cuts | Requests | Runtime (s) |', '| --- | ---: | ---: | ---: | ---: |');
  for (const report of reports) {
    const sum = field => report.rows.reduce((n, row) => n + row[field], 0);
    lines.push(`| ${report.build} | ${report.rows.length} | ${sum('cuts')} | ${sum('requests')} | ${(sum('milliseconds') / 1000).toFixed(1)} |`);
    if (report.build !== 'v1.0.16' && !report.rows.some(row => row.failures.length)) throw new Error(`${report.build} exposed no failures`);
    if (report.rows.some(row => row.errors.length || !row.cuts)) throw new Error(`${report.build} has hollow or broken cells`);
  }
  lines.push('', 'Raw observations and first failing sources are in the adjacent per-build JSON reports.', '');
  writeFileSync(join(output, 'comparison.md'), lines.join('\n'));
  process.stderr.write(`\nComparison: ${join(output, 'comparison.md')}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
