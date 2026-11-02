import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { FakeCodex } from '../../../../../tests/helpers/fake-codex.js';
import { FakeDesktop } from '../../../../../tests/helpers/fake-desktop.js';
import { createAgentSettings } from './settings.js';
import { openCodexProcess } from './codex.js';
import { runCodexQueue } from './desktop.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

it('keeps an explicitly cleared Codex path unset after restart and does not fall back to the environment', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-clear-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const settings = await createAgentSettings(dataDir);
  await settings.save({ ...settings.get(), codexCommand: '' });
  vi.stubEnv('CONGRUENCE_CODEX_COMMAND', 'automatically-found-codex');
  const restarted = await createAgentSettings(dataDir);
  expect(restarted.get().codexCommand).toBe('');
  await expect(openCodexProcess(['--version'], restarted.get().codexCommand)).rejects.toThrow(
    'Codex is not configured',
  );
  await expect(
    runCodexQueue('unused-session', 'unused-message', restarted.get().codexCommand),
  ).rejects.toThrow('Codex is not configured');
  const proposal = await restarted.propose({
    id: randomUUID(),
    workspaceId: 'test',
    host: 'codex-desktop',
    evidence: 'Desktop session context.',
    reason: 'Configure the executable after reset.',
    changes: { codexCommand: 'C:/Codex/codex.exe' },
  });
  expect(proposal.status).toBe('pending');
  expect(restarted.get().codexCommand).toBe('');
});

it('saves frontend settings, reconnects and preserves them across backend restarts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const codex = new FakeCodex();
  const desktop = new FakeDesktop();
  const closeCodex = vi.spyOn(codex, 'close');
  const closeDesktop = vi.spyOn(desktop, 'close');
  const app = await buildApp({ dataDir, mcp: false, codexAdapter: codex, desktopAdapter: desktop });
  cleanups.push(() => app.close());
  const payload = {
    codexCommand: 'C:/Program Files/Codex/codex.exe',
    codexUrl: 'ws://127.0.0.1:4567',
    codexSocket: '',
  };
  const response = await app.inject({ method: 'PUT', url: '/api/agent-settings', payload });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(payload);
  expect(closeCodex).toHaveBeenCalledOnce();
  expect(closeDesktop).toHaveBeenCalledOnce();
  expect((await app.inject('/api/agent-settings')).json()).toEqual(payload);
  await app.close();
  vi.stubEnv('CONGRUENCE_CODEX_COMMAND', 'a-different-environment-default');
  const restarted = await buildApp({
    dataDir,
    mcp: false,
    codexAdapter: new FakeCodex(),
    desktopAdapter: false,
  });
  cleanups.push(() => restarted.close());
  expect((await restarted.inject('/api/agent-settings')).json()).toEqual(payload);
});

it('keeps proposals inert across restarts, applies only approved fields, and preserves decisions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const legacy = { codexCommand: 'old-codex', codexUrl: 'ws://localhost:4500', codexSocket: '' };
  await writeFile(join(dataDir, 'agent-settings.json'), JSON.stringify(legacy));
  const settings = await createAgentSettings(dataDir);
  const input = {
    id: randomUUID(),
    workspaceId: 'test',
    host: 'codex-desktop' as const,
    evidence: 'The session identifies itself as Codex Desktop.',
    reason: 'Located the executable.',
    changes: { codexCommand: 'C:/Codex/codex.exe' },
  };
  const pending = await settings.propose(input);
  expect(pending.status).toBe('pending');
  expect(settings.get()).toEqual(legacy);
  expect(await settings.propose(input)).toEqual(pending);
  await expect(
    settings.propose({ ...input, changes: { codexCommand: 'different' } }),
  ).rejects.toThrow('already used');
  const restarted = await createAgentSettings(dataDir);
  expect(restarted.review().requests).toEqual([pending]);
  expect(restarted.get().codexCommand).toBe('old-codex');
  await restarted.save({ ...restarted.get(), codexUrl: 'ws://localhost:4567' });
  const approved = await restarted.decide(input.id, 'approve');
  expect(approved.status).toBe('approved');
  expect(restarted.get()).toMatchObject({
    codexCommand: input.changes.codexCommand,
    codexUrl: 'ws://localhost:4567',
  });
  expect(await restarted.decide(input.id, 'approve')).toEqual(approved);
  await expect(restarted.decide(input.id, 'reject')).rejects.toThrow('already been reviewed');
  const disk = JSON.parse(await readFile(join(dataDir, 'agent-settings.json'), 'utf8'));
  expect(disk.codexCommand).toBe(input.changes.codexCommand);
  expect(disk.requests[0]).toEqual(approved);
  const again = await createAgentSettings(dataDir);
  expect(again.review()).toEqual(restarted.review());
});

it('drops the removed Claude Code setting and its requests from a saved file', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-claude-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const current = { codexCommand: 'old-codex', codexUrl: 'ws://localhost:4500', codexSocket: '' };
  const saved = { ...current, claudeCommand: 'claude' };
  const request = (host: string, changes: Record<string, string>) => ({
    id: randomUUID(),
    workspaceId: 'test',
    host,
    evidence: 'Verified local path.',
    reason: 'Use the executable.',
    changes,
    baseSettings: saved,
    status: 'rejected',
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  });
  const codex = request('codex-desktop', { codexCommand: 'C:/Codex/codex.exe' });
  await writeFile(
    join(dataDir, 'agent-settings.json'),
    JSON.stringify({
      ...saved,
      requests: [
        codex,
        request('claude-code-desktop', { claudeCommand: 'C:/Claude/claude.exe' }),
        request('claude-code-cli', { claudeCommand: 'claude' }),
      ],
    }),
  );
  const settings = await createAgentSettings(dataDir);
  expect(settings.review()).toEqual({
    settings: current,
    requests: [{ ...codex, baseSettings: current }],
  });
});

it('rejects outdated approvals and serializes conflicting changes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const settings = await createAgentSettings(dataDir);
  const input = {
    id: randomUUID(),
    workspaceId: 'test',
    host: 'codex-cli' as const,
    evidence: 'CLI session context.',
    reason: 'Configure command.',
    changes: { codexCommand: 'first-codex' },
  };
  const first = await settings.propose(input);
  const second = await settings.propose({
    ...input,
    id: randomUUID(),
    changes: { codexCommand: 'second-codex' },
  });
  const results = await Promise.allSettled([
    settings.decide(first.id, 'approve'),
    settings.decide(second.id, 'approve'),
  ]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(settings.get().codexCommand).toBe('first-codex');
  expect(settings.review().requests[1].status).toBe('pending');
  await settings.decide(second.id, 'reject');
  expect(settings.get().codexCommand).toBe('first-codex');
  expect(
    (await settings.propose({ ...input, id: second.id, changes: { codexCommand: 'second-codex' } }))
      .status,
  ).toBe('rejected');
  for (const changes of [
    {},
    { codexUrl: 'ws://remote.example:4500' },
    { unexpected: 'value' },
    { codexCommand: '   ' },
    { claudeCommand: 'claude' },
  ]) {
    await expect(settings.propose({ ...input, id: randomUUID(), changes })).rejects.toThrow();
  }
});

it('rejects invalid settings and cross-origin changes without replacing saved configuration', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const app = await buildApp({
    dataDir,
    mcp: false,
    codexAdapter: new FakeCodex(),
    desktopAdapter: false,
  });
  cleanups.push(() => app.close());
  const original = (await app.inject('/api/agent-settings')).json();
  for (const values of [
    { codexUrl: 'ws://remote.example:4500' },
    { codexUrl: 'ws://user:pass@localhost:4500' },
    { codexCommand: ' ' },
    { unexpected: true },
  ]) {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/agent-settings',
      payload: { ...original, ...values },
    });
    expect(response.statusCode).toBe(400);
  }
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/agent-settings',
        headers: { host: 'localhost:4310', origin: 'http://localhost:5173' },
        payload: original,
      })
    ).statusCode,
  ).toBe(403);
  expect((await app.inject('/api/agent-settings')).json()).toEqual(original);
});

it.each(['approve', 'reject'] as const)(
  'reapplies a past %s decision without changing its history or unrelated settings',
  async (decision) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-history-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const settings = await createAgentSettings(dataDir);
    const proposal = await settings.propose({
      id: randomUUID(),
      workspaceId: 'test',
      host: 'codex-desktop',
      reason: 'Use the saved executable.',
      evidence: 'Verified local path.',
      changes: { codexCommand: 'saved-codex' },
    });
    const original = await settings.decide(proposal.id, decision);
    await settings.save({ ...settings.get(), codexCommand: 'current-codex' });
    const input = { id: randomUUID(), expectedSettings: settings.get() };
    // A concurrent edit to an unrelated field must survive reapplication and its retries.
    await settings.save({ ...settings.get(), codexUrl: 'ws://localhost:4567' });
    const before = settings.get();
    const notifications: boolean[] = [];
    settings.subscribe((changed) => notifications.push(changed));
    const receipt = await settings.reapply(original.id, input);
    expect(receipt).toMatchObject({
      id: input.id,
      reappliedFrom: original.id,
      status: 'approved',
      baseSettings: before,
      changes: original.changes,
    });
    expect(receipt.decidedAt).toBe(receipt.createdAt);
    expect(settings.get()).toEqual({ ...before, codexCommand: 'saved-codex' });
    expect(settings.review().requests).toEqual([original, receipt]);
    expect(await settings.reapply(original.id, input)).toEqual(receipt);
    expect(notifications).toEqual([true]);
    await expect(
      settings.reapply(original.id, { ...input, expectedSettings: settings.get() }),
    ).rejects.toThrow('already used');
    await settings.removeRequest(original.id);
    expect(settings.review().requests).toEqual([receipt]);
    expect(notifications).toEqual([true, false]);
    expect(await settings.removeRequest(original.id)).toEqual({ ok: true });
    expect(await settings.reapply(original.id, input)).toEqual(receipt);
    const restarted = await createAgentSettings(dataDir);
    expect(restarted.review()).toEqual(settings.review());
    await restarted.removeRequest(receipt.id);
    expect(restarted.review().requests).toEqual([]);
    expect(restarted.get()).toEqual({ ...before, codexCommand: 'saved-codex' });
    expect((await createAgentSettings(dataDir)).review()).toEqual(restarted.review());
  },
);

it('rejects reapplication of stale settings and prevents history actions on pending requests', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-history-conflict-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const settings = await createAgentSettings(dataDir);
  const proposal = await settings.propose({
    id: randomUUID(),
    workspaceId: 'test',
    host: 'codex-cli',
    reason: 'Use the saved executable.',
    evidence: 'Verified local path.',
    changes: { codexCommand: 'saved-codex' },
  });
  const input = { id: randomUUID(), expectedSettings: settings.get() };
  await expect(settings.reapply(proposal.id, input)).rejects.toThrow('pending request');
  await expect(settings.removeRequest(proposal.id)).rejects.toThrow('pending request');
  await settings.decide(proposal.id, 'reject');
  await settings.save({ ...settings.get(), codexCommand: 'newer-codex' });
  const before = settings.review();
  await expect(settings.reapply(proposal.id, input)).rejects.toThrow('Settings changed');
  await expect(settings.reapply(randomUUID(), input)).rejects.toThrow('not found');
  expect(settings.review()).toEqual(before);
  await settings.save({ ...settings.get(), codexCommand: 'saved-codex' });
  await expect(
    settings.reapply(proposal.id, { ...input, expectedSettings: settings.get() }),
  ).rejects.toThrow('already in use');
  expect(settings.review().requests).toHaveLength(1);
});

it('restricts history actions to the frontend and reconnects only when reapplication changes settings', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-history-api-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const seed = await createAgentSettings(dataDir);
  const proposal = await seed.propose({
    id: randomUUID(),
    workspaceId: 'test',
    host: 'codex-cli',
    reason: 'Use the saved executable.',
    evidence: 'Verified local path.',
    changes: { codexCommand: 'saved-codex' },
  });
  await seed.decide(proposal.id, 'reject');
  const desktop = new FakeDesktop();
  const reset = vi.spyOn(desktop, 'close');
  const app = await buildApp({
    dataDir,
    mcp: false,
    codexAdapter: new FakeCodex(),
    desktopAdapter: desktop,
  });
  cleanups.push(() => app.close());
  const before = (await app.inject('/api/agent-settings')).json();
  const payload = { id: randomUUID(), expectedSettings: before };
  const path = '/api/agent-settings/requests/' + proposal.id;
  for (const headers of [
    { host: 'localhost:4310' },
    { host: 'localhost:4310', origin: 'http://localhost:5173' },
  ]) {
    expect(
      (await app.inject({ method: 'POST', url: path + '/reapply', headers, payload })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: path, headers })).statusCode).toBe(403);
  }
  expect((await app.inject('/api/agent-settings')).json()).toEqual(before);
  const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
  const applied = await app.inject({ method: 'POST', url: path + '/reapply', headers, payload });
  expect(applied.statusCode).toBe(200);
  expect(applied.json()).toMatchObject({
    id: payload.id,
    reappliedFrom: proposal.id,
    status: 'approved',
  });
  expect(reset).toHaveBeenCalledOnce();
  expect(
    (await app.inject({ method: 'POST', url: path + '/reapply', headers, payload })).json(),
  ).toEqual(applied.json());
  expect((await app.inject({ method: 'DELETE', url: path, headers })).json()).toEqual({ ok: true });
  expect((await app.inject('/api/agent-settings')).json()).toEqual({
    ...before,
    codexCommand: 'saved-codex',
  });
  expect((await app.inject('/api/agent-settings/requests')).json().requests).toEqual([
    applied.json(),
  ]);
  expect(reset).toHaveBeenCalledOnce();
});
