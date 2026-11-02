import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { DashboardLocation, DashboardSummary } from '@congruence/contracts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-dashboard-http-'));
  const app = await buildApp({ dataDir, serveWeb: false, mcp: false, desktopAdapter: false });
  cleanup.push(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const workspace = await app.store.createWorkspace({
    name: 'Dashboard test',
    description: '',
    repositories: [],
  });
  const other = await app.store.createWorkspace({
    name: 'Other',
    description: '',
    repositories: [],
  });
  const base = `/api/workspaces/${workspace.id}/dashboards`;
  return { app, workspace, other, base };
}

describe('workspace dashboard HTTP integration', () => {
  it('publishes a real React build and isolates published assets from source and other workspaces', async () => {
    const { app, base, other } = await setup();
    const created = await app.inject({ method: 'POST', url: base, payload: { name: 'Metrics' } });
    expect(created.statusCode, created.body).toBe(200);
    const location = created.json<DashboardLocation>();
    expect(await readFile(location.instructionsPath, 'utf8')).toContain('publish_dashboard');
    const route = `${base}/${location.dashboard.id}`;
    const published = await app.inject({ method: 'POST', url: `${route}/publish` });
    expect(published.statusCode, published.body).toBe(200);
    const dashboard = published.json<DashboardSummary>();
    expect(dashboard.version).toBeTruthy();
    const html = await app.inject({ url: dashboard.frameUrl!, headers: { origin: 'null' } });
    expect(html.statusCode, html.body).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(html.body).toContain('<script');
    expect(
      (
        await app.inject(
          `${base}/${location.dashboard.id}/versions/${dashboard.version}/assets/backend.cjs`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject(
          `/api/workspaces/${other.id}/dashboards/${location.dashboard.id}/directory`,
        )
      ).statusCode,
    ).toBe(404);
    expect((await app.inject(`/api/workspaces/${other.id}/dashboards`)).json()).toEqual([]);

    await writeFile(join(location.directory, 'src', 'frontend.tsx'), 'this is not valid TSX !!!');
    const failed = await app.inject({ method: 'POST', url: `${route}/publish` });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    const current = (await app.inject(base)).json<DashboardSummary[]>()[0]!;
    expect(current.version).toBe(dashboard.version);
    expect((await app.inject(dashboard.frameUrl!)).statusCode).toBe(200);
  });

  it('rejects opaque and foreign browser command requests while accepting the frontend origin', async () => {
    const { app, base } = await setup();
    for (const origin of ['null', 'https://example.com', 'http://localhost:9999']) {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers: { origin },
        payload: { name: 'Forbidden' },
      });
      expect(response.statusCode).toBe(403);
    }
    const response = await app.inject({
      method: 'POST',
      url: base,
      headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
      payload: { name: 'Allowed' },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('reviews resolved backend data and executes only the saved snapshot once', async () => {
    const { app, base } = await setup();
    const created = await app.inject({ method: 'POST', url: base, payload: { name: 'Actions' } });
    const location = created.json<DashboardLocation>();
    await writeFile(
      join(location.directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'Actions',
        commands: [{ id: 'save', label: 'Save selection', type: 'backend' }],
      }),
    );
    await writeFile(
      join(location.directory, 'src', 'backend.ts'),
      `
      let count = 0;
      export function prepare(id, input) { return { input: { ...input, resolved: [42, { source: 'backend' }] }, summary: 'Save these resolved values' }; }
      export function execute(id, input) { count++; return { count, received: input }; }
    `,
    );
    const route = `${base}/${location.dashboard.id}`;
    const dashboard = (
      await app.inject({ method: 'POST', url: `${route}/publish` })
    ).json<DashboardSummary>();
    const response = await app.inject({
      method: 'POST',
      url: `${route}/previews`,
      payload: {
        version: dashboard.version,
        commandId: 'save',
        input: { selected: ['a', 'b'], options: { enabled: true } },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = response.json();
    expect(preview.input).toEqual({
      selected: ['a', 'b'],
      options: { enabled: true },
      resolved: [42, { source: 'backend' }],
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: 'POST', url: `${route}/runs`, payload: { previewId: preview.id } }),
      ),
    );
    for (const result of results) {
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().id).toBe(preview.id);
    }
    await expect
      .poll(async () => (await app.inject(`${route}/runs`)).json()[0]?.status)
      .toBe('succeeded');
    const runs = (await app.inject(`${route}/runs`)).json();
    expect(runs).toHaveLength(1);
    expect(runs[0].result).toEqual({ count: 1, received: preview.input });
  });
});
