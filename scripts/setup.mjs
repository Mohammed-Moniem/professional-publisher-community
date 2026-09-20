#!/usr/bin/env node
// Run from a reviewed clone: node scripts/setup.mjs [setup|upgrade|rollback|uninstall].
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const name = 'professional-publisher-community', selector = name + '@' + name;
const args = process.argv.slice(2), command = args.find(a => !a.startsWith('-')) || 'setup';
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const yes = args.includes('--yes');
async function run(binary, argv, capture = false) {
  if (capture) return (await exec(binary, argv, { cwd: root, maxBuffer: 8_000_000, timeout: 30000 })).stdout.trim();
  await new Promise((ok, fail) => { const p = spawn(binary, argv, { cwd: root, stdio: 'inherit', shell: false }); p.on('error', fail); p.on('exit', code => code === 0 ? ok() : fail(Error(binary + ' failed (' + code + ')'))); });
}
async function available(binary) { try { await run(binary, ['--version'], true); return true; } catch { return false; } }
async function ask(prompt, fallback) {
  if (yes) return fallback;
  if (!process.stdin.isTTY) throw Error('Use --yes with --client codex|claude|desktop|config for noninteractive setup.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(prompt)).trim() || fallback; } finally { rl.close(); }
}
async function npm(argv) {
  let cli = process.env.npm_execpath;
  if (!cli || !existsSync(cli)) {
    const executable = process.platform === 'win32' ? (await exec('where.exe', ['npm'])).stdout.trim().split(/\r?\n/)[0] : (await exec('which', ['npm'])).stdout.trim();
    cli = process.platform === 'win32' ? join(dirname(executable), 'node_modules/npm/bin/npm-cli.js') : await realpath(executable);
  }
  await run(process.execPath, [cli, ...argv]);
}
async function register(client, remove = false) {
  if (client === 'config' || client === 'desktop') return;
  const markets = JSON.parse(await run(client, ['plugin','marketplace','list','--json'], true));
  const rows = client === 'codex' ? markets.marketplaces : markets;
  if (!Array.isArray(rows)) throw Error('Unsupported client marketplace output. Use --client config and follow SETUP.md.');
  const match = rows.find(m => m.name === name);
  if (match && resolve(match.root || match.path || match.installLocation || '') !== resolve(root)) throw Error('This marketplace belongs to another clone. Run maintenance from that clone; setup will not silently rebind it.');
  const plugins = JSON.parse(await run(client, client === 'codex' ? ['plugin','list','--marketplace',name,'--json'] : ['plugin','list','--json'], true));
  const installed = (client === 'codex' ? plugins.installed : plugins).find(p => (p.pluginId || p.id) === selector);
  if (remove) { if (installed) await run(client, ['plugin', client === 'codex' ? 'remove' : 'uninstall', selector]); return; }
  if (!match) await run(client, ['plugin','marketplace','add',root]);
  if (client === 'claude' && installed) await run(client, ['plugin','update',selector]);
  else await run(client, ['plugin', client === 'codex' ? 'add' : 'install', selector]);
}
async function softwareSetup(client) {
  const bundled = existsSync(join(root,'runtime',process.platform==='win32'?'node.exe':'node'));
  if (!bundled) { await npm(['ci','--ignore-scripts']); await npm(['run','build']); await run(process.execPath,[join(root,'node_modules/playwright/cli.js'),'install','chromium']); }
  await run(process.execPath,[join(root,'scripts/launch.mjs'),'doctor']);
  const manifestPath = join(root,'.mcp.json'), portable = await readFile(manifestPath);
  try { await run(process.execPath,[join(root,'scripts/install.mjs')]); await register(client); }
  finally { await writeFile(manifestPath, portable); }
}
async function main() {
  if (args.includes('--help')) { console.log('node scripts/setup.mjs setup|upgrade|rollback|uninstall [--client codex|claude|desktop|config] [--yes] [--skip-connect] [--tag vX.Y.Z]\nSetup installs dependencies and the chosen client plugin. It never enables the worker or publishes. Upgrade requires a clean source clone and explicit release tag. Rollback restores the previous source commit. Uninstall retains private data and credentials.'); return; }
  if (!['setup','upgrade','rollback','uninstall'].includes(command)) throw Error('Unknown command. Use --help.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or newer is required.');
  const detected = []; for (const client of ['codex','claude']) if (await available(client)) detected.push(client);
  let client = option('--client') || await ask('Client (codex/claude/desktop/config) [' + (detected[0] || 'config') + ']: ', detected[0] || 'config');
  if (!['codex','claude','desktop','config'].includes(client)) throw Error('Choose codex, claude, desktop or config.');
  console.log('Runtime: ' + process.version + ' · ' + process.platform + '/' + process.arch + '\nDetected clients: ' + (detected.join(', ') || 'none'));
  if (['codex','claude'].includes(client) && !detected.includes(client)) throw Error('Install the selected client first, or use --client config.');
  const statePath = join(root,'client-config','maintenance.json');
  if (command === 'upgrade' || command === 'rollback') {
    if (await run('git', ['status','--porcelain'], true)) throw Error('Commit or stash local changes before upgrading. Nothing was changed.');
    const previous = await run('git', ['rev-parse','HEAD'], true);
    let target;
    if (command === 'rollback') {
      const state = JSON.parse(await readFile(statePath,'utf8')); target = state.previousCommit;
      if (!/^[a-f0-9]{40}$/.test(target)) throw Error('No valid previous commit recorded.');
    } else {
      target = option('--tag');
      if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(target || '')) throw Error('Specify a reviewed release with --tag vX.Y.Z.');
      const remote = await run('git', ['remote','get-url','origin'], true);
      if (!/^https:\/\/github\.com\/Mohammed-Moniem\/professional-publisher-community(?:\.git)?\/?$|^git@github\.com:Mohammed-Moniem\/professional-publisher-community(?:\.git)?$/.test(remote)) throw Error('Upgrade only supports the official repository origin. Review fork updates manually.');
      await run('git', ['fetch','origin','tag',target]);
    }
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ previousCommit: previous, target, at: new Date().toISOString() }, null, 2));
    await run('git', ['switch','--detach',target]);
    // Execute the selected version's setup, rather than old maintenance code.
    if (existsSync(join(root,'scripts/setup.mjs'))) await run(process.execPath, [join(root,'scripts/setup.mjs'),'setup','--client',client,'--yes','--skip-connect']);
    else await softwareSetup(client); // v0.1 rollback predates this maintenance entry point.
    console.log('Source version switched. Start a new client session. Use rollback if validation fails.'); return;
  }
  if (command === 'uninstall') {
    await register(client, true);
    if (existsSync(join(root,'dist/src/cli.js'))) {
      const { Store } = await import('../dist/src/store.js');
      if ((await new Store().read('settings','worker'))?.installed) await run(process.execPath,[join(root,'scripts/launch.mjs'),'uninstall-worker']);
    }
    console.log('Selected client registration removed. Private data, credentials and source remain. Disconnect accounts before uninstalling if you want credentials removed. Desktop users must also remove the extension in Claude Settings.'); return;
  }
  await softwareSetup(client);
  console.log('Software setup complete. Start a NEW Codex/Claude task and ask: Read get_workflow, then check_capabilities.\nClaude Desktop: install the matching MCPB from Releases, or merge client-config/mcp.json into your configuration.\nNo account permissions, posting verification or scheduling worker were enabled by setup.');
  if (!args.includes('--skip-connect') && !yes && (await ask('Open private dashboard to connect LinkedIn? [y/N] ', 'n')).toLowerCase() === 'y') await run(process.execPath,[join(root,'scripts/launch.mjs'),'dashboard']);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
