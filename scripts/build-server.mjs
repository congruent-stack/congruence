import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const serverRoot = new URL('../apps/server/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', serverRoot), 'utf8'));
await build({
  entryPoints: [fileURLToPath(new URL('src/main.ts', serverRoot))],
  outfile: fileURLToPath(new URL('dist/main.js', serverRoot)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: Object.entries(manifest.dependencies)
    .filter(([, version]) => !version.startsWith('workspace:'))
    .map(([name]) => name),
});
