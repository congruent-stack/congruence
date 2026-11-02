import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { buildApp } from '../server/src/app.js';
import { FakeCodex } from '../../tests/helpers/fake-codex.js';
import webConfig from './vite.config.js';

it('sends agent controls through the dev proxy and uses the backend MCP port', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-dev-proxy-'));
  const codex = new FakeCodex();
  const app = await buildApp({
    dataDir,
    codexHome: join(dataDir, 'codex'),
    serveWeb: false,
    mcp: false,
    codexAdapter: codex,
    desktopAdapter: false,
  });
  let vite: ViteDevServer | undefined;
  try {
    const backendUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Dev proxy',
      description: '',
      repositories: [],
    });
    const item = await app.store.publishActivity({
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Test message',
      summary: '',
      status: 'in_progress',
    });
    // Keep the real proxy options, replacing only its destination with this isolated backend.
    const proxy = Object.fromEntries(
      Object.entries(webConfig.server!.proxy!).map(([path, options]) => [
        path,
        typeof options === 'string' ? backendUrl : { ...options, target: backendUrl },
      ]),
    );
    vite = await createServer({
      ...webConfig,
      configFile: false,
      root: resolve('apps/web'),
      server: { ...webConfig.server, strictPort: false, hmr: false, proxy },
      optimizeDeps: { noDiscovery: true, include: [] },
      logLevel: 'silent',
    });
    await vite.listen();
    const origin = new URL(vite.resolvedUrls!.local[0]).origin;
    const url = `${origin}/api/workspaces/${workspace.id}/activity/${item.id}/messages`;
    const send = (requestOrigin: string) =>
      fetch(url, {
        method: 'POST',
        headers: { origin: requestOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: randomUUID(),
          target: { provider: 'codex', sessionId: 'test-codex' },
          text: 'Through the dev server',
        }),
      });
    const response = await send(origin);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'accepted' });
    expect(codex.sent).toHaveLength(1);

    const setupUrl = `${origin}/api/agent-settings/codex-mcp`;
    const configPath = join(dataDir, 'codex', 'config.toml');
    expect(await (await fetch(setupUrl)).json()).toEqual({
      configPath,
      endpoint: `${backendUrl}/mcp`,
    });
    const configured = await fetch(setupUrl, { method: 'POST', headers: { origin } });
    expect(configured.status).toBe(200);
    await configured.body?.cancel();
    const savedConfig = await readFile(configPath, 'utf8');
    expect(savedConfig).toContain(`url = "${backendUrl}/mcp"`);
    expect(savedConfig).not.toContain(`${origin}/mcp`);

    for (const otherOrigin of ['https://untrusted.example', backendUrl, 'null']) {
      const rejected = await send(otherOrigin);
      expect(rejected.status).toBe(403);
      await rejected.body?.cancel();
      const rejectedConfig = await fetch(setupUrl, {
        method: 'DELETE',
        headers: { origin: otherOrigin },
      });
      expect(rejectedConfig.status).toBe(403);
      await rejectedConfig.body?.cancel();
    }
    expect(codex.sent).toHaveLength(1);
    expect(await readFile(configPath, 'utf8')).toBe(savedConfig);
  } finally {
    await vite?.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
