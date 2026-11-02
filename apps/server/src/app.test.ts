import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const cleanup: Array<() => Promise<unknown>> = [];
async function appForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-http-'));
  const app = await buildApp({ dataDir, serveWeb: false, mcp: false });
  cleanup.push(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return app;
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe('HTTP API', () => {
  it('creates, updates, lists and scopes workspace activity', async () => {
    const app = await appForTest();
    const create = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: {
        name: 'Side projects',
        description: 'Small experiments',
        repositories: [],
      },
    });
    expect(create.statusCode).toBe(201);
    const workspace = create.json();
    expect(workspace.shortId).toMatch(/^[a-z0-9]{8}$/);
    const update = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${workspace.shortId}`,
      payload: {
        name: 'Side projects',
        description: 'Small experiments',
        repositories: ['D:/dev/one', 'https://github.com/example/two'],
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ id: workspace.id, shortId: workspace.shortId });
    expect(update.json().repositories).toHaveLength(2);
    const publish = await app.inject({
      method: 'POST',
      url: '/api/activity',
      payload: {
        workspaceId: workspace.shortId,
        title: 'Build prototype',
        summary: 'Ready to review.',
        status: 'done',
        source: 'Codex',
        sourceUrl: 'https://example.com/task/1',
      },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toMatchObject({ subtitle: '', revision: 1 });
    expect(publish.json().workId).toMatch(/^[a-z0-9]{8}$/);
    const change = await app.inject({
      method: 'POST',
      url: '/api/activity',
      payload: {
        workspaceId: workspace.id,
        workKey: publish.json().workKey,
        subtitle: 'Reviewing',
        summary: 'Review is in progress.',
        status: 'in_progress',
        source: 'Codex',
      },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json()).toMatchObject({
      title: 'Build prototype',
      subtitle: 'Reviewing',
      revision: 2,
    });
    const renamed = await app.inject({
      method: 'POST',
      url: '/api/activity',
      payload: {
        workspaceId: workspace.id,
        workKey: publish.json().workKey,
        title: 'Changed title',
        summary: '',
        status: 'done',
        source: 'Codex',
      },
    });
    expect(renamed.statusCode).toBe(409);
    const versions = await app.inject(
      `/api/workspaces/${workspace.shortId}/activity/${publish.json().id}/versions`,
    );
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toEqual([publish.json(), change.json()]);
    expect(
      (await app.inject(`/api/workspaces/missing/activity/${publish.json().id}/versions`))
        .statusCode,
    ).toBe(404);
    const activity = await app.inject(`/api/workspaces/${workspace.id}/activity`);
    expect(activity.json()).toEqual([change.json()]);
    expect((await app.inject('/api/workspaces/missing/activity')).statusCode).toBe(404);
    expect((await app.inject('/api/workspaces')).json()).toEqual([update.json()]);
  });

  it('validates shape without silently coercing values or stripping extra properties', async () => {
    const app = await appForTest();
    for (const payload of [
      { name: '  ', description: '', repositories: [] },
      { name: 123, description: '', repositories: [] },
      { name: 'Valid', description: '', repositories: [], unexpected: true },
      { name: 'Valid', description: '' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/workspaces', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty('message');
    }
    expect((await app.inject('/api/workspaces')).json()).toEqual([]);
  });

  it('rejects remote browser origins and rebinding hosts while allowing local clients', async () => {
    const app = await appForTest();
    expect(
      (await app.inject({ url: '/api/workspaces', headers: { host: 'evil.example:4310' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/workspaces', headers: { origin: 'https://evil.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/workspaces', headers: { origin: 'http://127.0.0.1:5173' } }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok' });
  });

  it('exports route schemas as an OpenAPI document for generation', async () => {
    const app = await appForTest();
    const response = await app.inject('/api/openapi.json');
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.paths['/api/workspaces'].post.operationId).toBe('createWorkspace');
    expect(document.paths['/api/activity'].post.requestBody).toBeDefined();
    expect(
      document.paths['/api/workspaces/{workspaceId}/activity/{activityId}/versions'].get
        .operationId,
    ).toBe('listActivityVersions');
  });
});
