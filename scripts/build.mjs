import { build } from 'esbuild';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const result = await build({
  entryPoints: ['src/main.ts'], outfile: 'dist/jevkeep.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  legalComments: 'inline', metafile: true, logLevel: 'info',
  banner: { js: '/* jevkeep — MIT. Includes fast-jev-compaction at e3f262a7f4d42bd8dd32ced30d26176f7cb545b0. See THIRD_PARTY_LICENSES.txt. */' },
});
// A packaged hook must not depend on node_modules at runtime.
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.path.startsWith('node:') && !require('node:module').isBuiltin(dependency.path)) {
      throw new Error(`Unbundled dependency: ${dependency.path}`);
    }
  }
}
const notices = ['fast-jev-compaction (e3f262a7f4d42bd8dd32ced30d26176f7cb545b0)\n\n' +
  await readFile('vendor/fast-jev-compaction/LICENSE', 'utf8')];
for (const name of ['proper-lockfile', 'graceful-fs', 'retry', 'signal-exit']) {
  const root = dirname(require.resolve(`${name}/package.json`));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const license = name === 'signal-exit' ? 'LICENSE.txt' : 'LICENSE';
  notices.push(`${name} ${pkg.version}\n\n${await readFile(join(root, license), 'utf8')}`);
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', notices.join('\n\n----------------------------------------\n\n'));
await chmod('dist/jevkeep.cjs', 0o755);
