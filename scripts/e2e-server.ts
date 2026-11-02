import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';

const dataDir = await mkdtemp(join(tmpdir(), 'congruence-e2e-'));
const app = await buildApp({
  dataDir,
  desktopAdapter: false,
  claudeSettingsPath: join(dataDir, 'claude-settings.json'),
});
await app.listen({ port: 4321, host: '127.0.0.1' });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
