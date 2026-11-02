import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { FakeCodex } from '../../../../../tests/helpers/fake-codex.js';
import { FakeDesktop } from '../../../../../tests/helpers/fake-desktop.js';
import { DeliveryError } from './codex.js';

const cleanups: Array<() => Promise<unknown>> = [];
async function fixture(desktop: FakeDesktop | false = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-agents-'));
  const codex = new FakeCodex();
  const app = await buildApp({
    dataDir,
    serveWeb: false,
    mcp: false,
    codexAdapter: codex,
    desktopAdapter: desktop,
  });
  cleanups.push(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const workspace = await app.store.createWorkspace({
    name: 'Test',
    description: '',
    repositories: [],
  });
  const report = {
    workspaceId: workspace.id,
    source: 'codex',
    title: 'Integration',
    summary: '',
    status: 'in_progress' as const,
  };
  const item = await app.store.publishActivity(report);
  const path = `/api/workspaces/${workspace.id}/activity/${item.id}/messages`;
  return { dataDir, app, codex, workspace, report, item, path };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('agent messaging API', () => {
  it('lists Desktop chats, queues once, and reconciles replies without changing work status', async () => {
    const desktop = new FakeDesktop();
    const { app, codex, path, workspace, item, report } = await fixture(desktop);
    const directory = (
      await app.inject(`/api/workspaces/${workspace.shortId}/agent-sessions`)
    ).json();
    expect(directory.sessions.map((session: any) => session.provider)).toEqual([
      'codex-desktop',
      'codex',
    ]);
    const payload = {
      id: randomUUID(),
      target: { provider: 'codex-desktop', sessionId: 'desktop-chat' },
      text: 'Continue in this chat.\nKeep the "offline" option enabled.',
    };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: path.replace(workspace.id, workspace.shortId), payload }),
      app.inject({ method: 'POST', url: path, payload }),
    ]);
    expect(responses[0].json()).toMatchObject({ status: 'queued', target: payload.target });
    const shortId = responses[0].json().shortId;
    expect(shortId).toMatch(/^[a-z0-9]{8}$/);
    expect(responses[1].json().shortId).toBe(shortId);
    expect(desktop.sent).toHaveLength(1);
    expect(codex.sent).toHaveLength(0);
    expect(desktop.sent[0].text).toBe(`[Congruence message ${shortId}]
---
Continue in this chat.
Keep the "offline" option enabled.

---
Activity: ${item.title}
Work ID: ${item.workId}
Workspace ID: ${workspace.shortId}`);
    expect(desktop.sent[0].text).not.toMatch(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
    expect((await app.store.getActivity(workspace.id, item.id)).status).toBe('in_progress');
    desktop.receipts.set(payload.id, {
      status: 'accepted',
      turnId: 'desktop-turn',
      detail: 'Received',
    });
    expect((await app.inject(path)).json().messages[0].status).toBe('accepted');
    desktop.receipts.set(payload.id, {
      status: 'replied',
      turnId: 'desktop-turn',
      reply: 'Completed',
      detail: 'Reply received',
    });
    const receipt = (await app.inject(path)).json().messages[0];
    expect(receipt).toMatchObject({ status: 'replied', reply: 'Completed' });
    const checks = desktop.checks;
    expect((await app.inject(path)).json().messages[0]).toEqual(receipt);
    expect(desktop.checks).toBe(checks);
    const progress = await app.store.publishActivity({
      ...report,
      workKey: item.workKey,
      status: 'done',
    });
    expect(progress).toMatchObject({ id: item.id, agentTarget: payload.target });
  });

  it('recovers an uncertain Desktop receipt after restart without replaying the send', async () => {
    const desktop = new FakeDesktop();
    desktop.failure = new DeliveryError('Queue acknowledgment lost', true);
    const { app, path, dataDir } = await fixture(desktop);
    const payload = {
      id: randomUUID(),
      target: { provider: 'codex-desktop', sessionId: 'desktop-chat' },
      text: 'Continue',
    };
    expect((await app.inject({ method: 'POST', url: path, payload })).json().status).toBe(
      'unknown',
    );
    expect(desktop.sent).toHaveLength(1);
    await app.close();
    const recovered = new FakeDesktop();
    recovered.receipts.set(payload.id, {
      status: 'replied',
      turnId: 'desktop-turn',
      reply: 'Recovered reply',
      detail: 'Replied',
    });
    const reopened = await buildApp({
      dataDir,
      serveWeb: false,
      mcp: false,
      codexAdapter: new FakeCodex(),
      desktopAdapter: recovered,
    });
    try {
      expect((await reopened.inject(path)).json().messages[0]).toMatchObject({
        status: 'replied',
        reply: 'Recovered reply',
      });
      expect((await reopened.inject({ method: 'POST', url: path, payload })).json().status).toBe(
        'replied',
      );
      expect(recovered.sent).toHaveLength(0);
    } finally {
      await reopened.close();
    }
  });

  it('keeps Desktop discovery available if the optional shared server is unavailable', async () => {
    const desktop = new FakeDesktop();
    const { app, codex, workspace } = await fixture(desktop);
    vi.spyOn(codex, 'listSessions').mockRejectedValueOnce(new Error('Not connected'));
    const directory = (await app.inject(`/api/workspaces/${workspace.id}/agent-sessions`)).json();
    expect(directory.sessions).toEqual(desktop.sessions);
    expect(directory.codexError).toContain('Not connected');
    codex.sessions.push({ ...desktop.sessions[0], provider: 'codex', state: 'idle' });
    const shared = (await app.inject(`/api/workspaces/${workspace.id}/agent-sessions`)).json();
    expect(
      shared.sessions.filter((session: any) => session.sessionId === 'desktop-chat'),
    ).toHaveLength(1);
    expect(
      shared.sessions.find((session: any) => session.sessionId === 'desktop-chat').provider,
    ).toBe('codex');
  });

  it('sends once across concurrent retries, retains session binding through progress, and records replies', async () => {
    const { app, codex, path, report, workspace, item } = await fixture();
    const payload = {
      id: randomUUID(),
      target: { provider: 'codex', sessionId: 'test-codex' },
      text: 'Please continue',
    };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: path, payload }),
      app.inject({ method: 'POST', url: path, payload }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(codex.sent).toHaveLength(1);
    expect(codex.sent[0].text).toContain('Please continue');
    const updated = await app.store.publishActivity({
      ...report,
      workKey: item.workKey,
      summary: 'Working',
      status: 'done',
    });
    expect(updated.agentTarget).toEqual(payload.target);
    expect(updated.id).toBe(item.id);
    codex.onNotification('item/completed', {
      threadId: 'test-codex',
      turnId: 'test-turn',
      item: { type: 'agentMessage', phase: 'final_answer', text: 'Finished the requested work.' },
    });
    await vi.waitFor(async () =>
      expect((await app.inject(path)).json().messages[0].reply).toBe(
        'Finished the requested work.',
      ),
    );
    expect(
      (await app.inject({ method: 'POST', url: path, payload: { ...payload, text: 'Changed' } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject(path.replace(workspace.id, 'other-workspace'))).statusCode).toBe(404);
  });
  it('does not auto-approve Codex requests and scopes approval responses to the activity session', async () => {
    const { app, codex, path } = await fixture();
    codex.onRequest(1, 'item/commandExecution/requestApproval', {
      threadId: 'another-chat',
      command: 'pnpm test',
    });
    expect(codex.answered).toEqual([]);
    await app.inject({
      method: 'POST',
      url: path,
      payload: {
        id: randomUUID(),
        target: { provider: 'codex', sessionId: 'test-codex' },
        text: 'Run tests',
      },
    });
    codex.onRequest(42, 'item/commandExecution/requestApproval', {
      threadId: 'test-codex',
      command: 'pnpm test',
    });
    expect(codex.answered).toEqual([]);
    const request = (await app.inject(path)).json().requests[0];
    expect(request.detail).toBe('pnpm test');
    const result = await app.inject({
      method: 'POST',
      url: path.replace('/messages', `/agent-requests/${request.id}`),
      payload: { approve: true },
    });
    expect(result.statusCode).toBe(200);
    expect(codex.answered).toEqual([{ id: 42, result: { decision: 'accept' } }]);
    expect((await app.inject(path)).json().requests).toEqual([]);
  });
  it('rejects the removed Claude channel and cross-origin sends', async () => {
    const { app, path, workspace, codex } = await fixture();
    const sessionId = randomUUID();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents/claude/register',
          payload: { sessionId, workspaceId: workspace.id, name: 'Claude', cwd: 'D:/test' },
        })
      ).statusCode,
    ).toBe(404);
    const payload = { id: randomUUID(), target: { provider: 'claude', sessionId }, text: 'Hello' };
    expect((await app.inject({ method: 'POST', url: path, payload })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { origin: 'http://localhost:9999' },
          payload: { ...payload, target: { provider: 'codex', sessionId: 'test-codex' } },
        })
      ).statusCode,
    ).toBe(403);
    expect(codex.sent).toHaveLength(0);
  });
  it('restores receipts without resending and marks unconfirmed sends after a restart', async () => {
    const { app, dataDir, workspace, item } = await fixture();
    const payload = {
      id: randomUUID(),
      target: { provider: 'codex' as const, sessionId: 'test-codex' },
      text: 'Continue',
    };
    await app.store.createAgentMessage(workspace.id, item.id, payload);
    await app.close();
    const codex = new FakeCodex();
    const reopened = await buildApp({
      dataDir,
      serveWeb: false,
      mcp: false,
      codexAdapter: codex,
      desktopAdapter: false,
    });
    try {
      const response = await reopened.inject({
        method: 'POST',
        url: `/api/workspaces/${workspace.id}/activity/${item.id}/messages`,
        payload,
      });
      expect(response.json().status).toBe('unknown');
      expect(codex.sent).toHaveLength(0);
    } finally {
      await reopened.close();
    }
  });
});
