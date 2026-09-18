#!/usr/bin/env node
import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(homedir(), 'plugins', 'jevkeep');
const catalogPath = join(homedir(), '.agents', 'plugins', 'marketplace.json');
const entry = {
  name: 'jevkeep', source: { source: 'local', path: './plugins/jevkeep' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
};
let catalog;
try { catalog = JSON.parse(await readFile(catalogPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  catalog = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
}
if (!/^[A-Za-z0-9_-]+$/.test(catalog.name ?? '') || !Array.isArray(catalog.plugins)) throw new Error('Invalid personal marketplace.');
const existing = catalog.plugins.find(plugin => plugin.name === entry.name);
if (existing && (existing.source?.source !== 'local' || existing.source?.path !== entry.source.path)) {
  throw new Error('An existing jevkeep entry points elsewhere; resolve it before installation.');
}
// Do not overwrite a different project at the expected personal plugin location.
try {
  const installed = JSON.parse(await readFile(join(destination, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (installed.name !== entry.name) throw new Error('Destination contains a different plugin.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  try {
    await stat(destination);
    throw new Error('Destination exists without a jevkeep manifest.');
  } catch (inner) { if (inner.code !== 'ENOENT') throw inner; }
}
for (const path of ['dist/jevkeep.cjs', 'dist/THIRD_PARTY_LICENSES.txt', 'hooks/hooks.json', '.codex-plugin/plugin.json', 'README.md', 'LICENSE']) {
  await stat(join(root, path));
}
await mkdir(destination, { recursive: true });
if (await realpath(destination) !== await realpath(root)) {
  for (const path of ['dist', 'hooks', '.codex-plugin', 'README.md', 'LICENSE']) {
    await cp(join(root, path), join(destination, path), { recursive: true });
  }
}
// A unique package version makes Codex refresh its cached local copy on reinstall.
const manifestPath = join(destination, '.codex-plugin', 'plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = manifest.version.split('+')[0] + '+codex.' + Date.now();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
if (!existing) {
  catalog.plugins.push(entry);
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
}
console.log(`Personal marketplace ready: ${catalogPath}\nInstall with: codex plugin add jevkeep@${catalog.name}\nThen open /hooks in Codex to review and trust both hooks.`);
