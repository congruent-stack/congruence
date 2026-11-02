import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { createStore } from '../../storage/store.js';
import { FakeCodex } from '../../../../../tests/helpers/fake-codex.js';

const sessionId = 'local_53ef5087-66b0-464b-bdc2-c371e7445cfe';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-claude-desktop-'));
  const codex = new FakeCodex();
  codex.sessions = [];
  const app = await buildApp({
    dataDir,
    serveWeb: false,
    mcp: false,
    codexAdapter: codex,
    desktopAdapter: false,
  });
  cleanups.push(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const workspace = await app.store.createWorkspace({
    name: 'Panda',
    description: '',
    repositories: ['D:\\panda'],
  });
  // The Vienna sequence: a Claude Desktop report from a folder outside the workspace's repositories.
  const item = await app.store.publishActivity({
    workspaceId: workspace.id,
    source: 'claude-code',
    title: 'Vienna weather report',
    summary: 'Done',
    status: 'done',
    desktopSession: { provider: 'claude', sessionId },
  });
  const messages = `/api/workspaces/${workspace.id}/activity/${item.id}/messages`;
  const mod = (path: string, token?: string, payload: object = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/agents/claude-desktop/${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  const register = async (id = sessionId, cwd = 'D:\\koala') => {
    const response = await mod('register', undefined, { sessionId: id, cwd });
    return response.statusCode === 200 ? (response.json().token as string) : response.statusCode;
  };
  const send = (text: string, target = { provider: 'claude-desktop', sessionId }) =>
    app.inject({ method: 'POST', url: messages, payload: { id: randomUUID(), target, text } });
  return { dataDir, app, workspace, item, messages, mod, register, send };
}

describe('Claude Desktop messaging through the Congruence mod', () => {
  it('delivers a message once, as a marked prompt, and records the turn and its reply', async () => {
    const { app, workspace, item, messages, mod, register, send } = await fixture();
    const token = await register();
    const directory = (await app.inject(`/api/workspaces/${workspace.id}/agent-sessions`)).json();
    expect(directory.sessions).toEqual([
      {
        provider: 'claude-desktop',
        sessionId,
        name: 'koala · 53ef5087',
        cwd: 'D:\\koala',
        state: 'connected',
      },
    ]);

    const sent = (await send('What is the weather tomorrow?')).json();
    expect(sent).toMatchObject({
      status: 'sending',
      detail: 'Waiting for the session.',
    });
    // Messaging keeps the native session that also opens the card in Claude Desktop.
    expect(await app.store.getActivity(workspace.id, item.id)).toMatchObject({
      agentTarget: { provider: 'claude-desktop', sessionId },
      desktopSession: { provider: 'claude', sessionId },
    });

    expect((await mod(`${sessionId}/poll`)).statusCode).toBe(401);
    expect((await mod(`${sessionId}/poll`, 'wrong')).statusCode).toBe(401);
    const polls = await Promise.all([
      mod(`${sessionId}/poll`, token as string),
      mod(`${sessionId}/poll`, token as string),
    ]);
    const delivered = polls.flatMap((poll) => poll.json().messages);
    expect(delivered).toHaveLength(1);
    expect(sent.shortId).toMatch(/^[a-z0-9]{8}$/);
    expect(delivered[0].id).toBe(sent.shortId);
    expect(delivered[0].text).toBe(`[Congruence message ${sent.shortId}]
---
What is the weather tomorrow?

---
Activity: ${item.title}
Work ID: ${item.workId}
Workspace ID: ${workspace.shortId}`);
    expect(delivered[0].text).not.toMatch(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
    expect((await app.inject(messages)).json().messages[0].status).toBe('queued');

    const receipt = (outcome: object) =>
      mod(`${sessionId}/receipts`, token as string, { messageId: sent.shortId, ...outcome });
    expect((await receipt({ outcome: 'started' })).json().status).toBe('accepted');
    expect((await receipt({ outcome: 'replied', reply: 'Cool and dry.' })).json()).toMatchObject({
      status: 'replied',
      reply: 'Cool and dry.',
      detail: 'Claude replied.',
    });
    // A late receipt never undoes the reply.
    expect((await receipt({ outcome: 'stopped', reason: 'aborted' })).json().status).toBe(
      'replied',
    );
    expect((await mod(`${sessionId}/poll`, token as string)).json().messages).toEqual([]);
    // Work status changes only through explicit activity reports.
    expect((await app.store.getActivity(workspace.id, item.id)).status).toBe('done');
  });

  it('reports a refused prompt and a turn that ended without a reply', async () => {
    const { mod, register, send } = await fixture();
    const token = (await register()) as string;
    const first = (await send('First')).json();
    const second = (await send('Second')).json();
    expect((await mod(`${sessionId}/poll`, token)).json().messages).toHaveLength(2);
    const dropped = await mod(`${sessionId}/receipts`, token, {
      messageId: first.id,
      outcome: 'dropped',
      reason: 'the session was stopped and nobody has sent input since',
    });
    expect(dropped.json()).toMatchObject({ status: 'failed' });
    expect(dropped.json().detail).toContain('Type in the session, then send again.');
    await mod(`${sessionId}/receipts`, token, { messageId: second.id, outcome: 'started' });
    const stopped = await mod(`${sessionId}/receipts`, token, {
      messageId: second.id,
      outcome: 'stopped',
      reason: 'aborted',
    });
    expect(stopped.json()).toMatchObject({
      status: 'accepted',
      detail: 'No reply: the turn was stopped.',
    });
  });

  it('keeps sessions apart and refuses messages for sessions outside the workspace', async () => {
    const { app, workspace, item, mod, register, send } = await fixture();
    const other = 'local_00000000-0000-0000-0000-000000000001';
    const linked = (await register()) as string;
    const unrelated = (await register(other, 'D:\\elsewhere')) as string;
    await register('local_00000000-0000-0000-0000-000000000002', 'd:\\PANDA\\');
    const directory = (await app.inject(`/api/workspaces/${workspace.id}/agent-sessions`)).json();
    expect(directory.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      sessionId,
      'local_00000000-0000-0000-0000-000000000002',
    ]);
    const refused = await send('Wrong session', { provider: 'claude-desktop', sessionId: other });
    expect(refused.statusCode).toBe(409);
    expect(await app.store.listAgentMessages(workspace.id, item.id)).toEqual([]);
    const sent = (await send('Right session')).json();
    expect((await mod(`${other}/poll`, unrelated)).json().messages).toEqual([]);
    expect(
      (await mod(`${other}/receipts`, unrelated, { messageId: sent.id, outcome: 'started' }))
        .statusCode,
    ).toBe(403);
    expect((await mod(`${sessionId}/poll`, linked)).json().messages).toHaveLength(1);
    expect(
      (await mod('register', undefined, { sessionId: 'chat-uuid', cwd: 'D:\\' })).statusCode,
    ).toBe(400);
  });

  it('lets a reloaded mod take over only after the old registration stops polling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, workspace, mod, register, send } = await fixture();
    const first = (await register()) as string;
    expect(await register()).toBe(409);
    vi.setSystemTime(Date.now() + 11000);
    const directory = (await app.inject(`/api/workspaces/${workspace.id}/agent-sessions`)).json();
    expect(directory.sessions[0].state).toBe('offline');
    // An offline session keeps its messages until it polls again.
    expect((await send('While offline')).json().detail).toBe(
      'Session offline. Waits until it reopens.',
    );
    const second = (await register()) as string;
    expect((await mod(`${sessionId}/poll`, first)).statusCode).toBe(401);
    expect((await mod(`${sessionId}/poll`, second)).json().messages).toHaveLength(1);
  });

  it('keeps an undelivered message deliverable after a server restart', async () => {
    const { app, dataDir, workspace, item, register, send } = await fixture();
    await register();
    await send('Deliver after restart');
    await app.store.flush();
    const restarted = await createStore(dataDir);
    expect((await restarted.listAgentMessages(workspace.id, item.id))[0]).toMatchObject({
      status: 'sending',
      text: 'Deliver after restart',
    });
  });
});
