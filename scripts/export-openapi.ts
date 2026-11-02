import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';

const dataDir = await mkdtemp(join(tmpdir(), 'congruence-openapi-'));
const app = await buildApp({ dataDir, serveWeb: false, logger: false, mcp: false });
try {
  await app.ready();
  await writeFile(
    new URL('../packages/api-client/openapi.json', import.meta.url),
    JSON.stringify(app.swagger(), null, 2) + '\n',
  );
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
