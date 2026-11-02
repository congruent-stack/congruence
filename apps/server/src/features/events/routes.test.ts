import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardChange } from '@congruence/contracts';
import { buildApp } from '../../app.js';

describe('dashboard event stream', () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'congruence-events-'));
    app = await buildApp({ dataDir, serveWeb: false });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function subscribe() {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const changes: DashboardChange[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const finished = (async () => {
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.startsWith('event: change\n'))
              changes.push(JSON.parse(frame.slice('event: change\ndata: '.length)));
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        reader.releaseLock();
      }
    })();
    return { changes, finished, close: () => controller.abort() };
  }

  it('broadcasts saved REST and MCP changes to connected dashboards, without duplicate retry events', async () => {
    const first = await subscribe();
    const second = await subscribe();
    const workspace = (
      await app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { name: 'Live', description: '', repositories: [] },
      })
    ).json();
    await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${workspace.id}`,
      payload: { name: 'Renamed', description: '', repositories: [] },
    });

    const client = new Client({ name: 'sse-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl)));
    try {
      const report = {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        title: 'Published by an agent',
        summary: '',
        status: 'done',
        source: 'Codex',
      };
      const result = await client.callTool({ name: 'publish_activity', arguments: report });
      expect(result.isError).not.toBe(true);
      const { activity: item } = result.structuredContent as { activity: { workKey: string } };
      await client.callTool({ name: 'publish_activity', arguments: report });
      const expected = [
        { resource: 'workspaces', workspaceId: workspace.id },
        { resource: 'workspaces', workspaceId: workspace.id },
        { resource: 'activity', workspaceId: workspace.id },
      ];
      await vi.waitFor(() => {
        expect(first.changes).toEqual(expected);
        expect(second.changes).toEqual(expected);
      });
      expect(
        await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/activity`)).json(),
      ).toMatchObject([{ title: report.title }]);

      first.close();
      await first.finished;
      await app.store.publishActivity({
        ...report,
        requestId: undefined,
        workKey: item.workKey,
        status: 'in_progress',
      });
      await vi.waitFor(() => expect(second.changes).toHaveLength(4));
      expect(first.changes).toHaveLength(3);
    } finally {
      await client.close();
    }
    await app.close();
    await second.finished;
    expect(second.changes).toHaveLength(4);
  });

  it('ends open streams during shutdown without waiting for the browser to disconnect', async () => {
    const stream = await subscribe();
    await app.close();
    await stream.finished;
    expect(app.server.listening).toBe(false);
  }, 5000);

  it('applies the same origin and host checks as the data API', async () => {
    for (const headers of [{ host: 'evil.example:4310' }, { origin: 'https://evil.example' }]) {
      expect((await app.inject({ url: '/api/events', headers })).statusCode).toBe(403);
    }
  });
});
