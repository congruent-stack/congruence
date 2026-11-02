import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardDestination, DashboardSummary } from '@congruence/contracts';
import { createStore, StoreError } from '../../storage/store.js';
import { AgentService } from '../agents/service.js';
import { FakeCodex } from '../../../../../tests/helpers/fake-codex.js';
import { FakeDesktop } from '../../../../../tests/helpers/fake-desktop.js';
import type { DashboardRuntime } from './runtime.js';
import { createDashboardCommands } from './commands.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-dashboard-commands-'));
  const store = await createStore(dataDir);
  const workspace = await store.createWorkspace({
    name: 'Commands',
    description: '',
    repositories: [],
  });
  const other = await store.createWorkspace({ name: 'Other', description: '', repositories: [] });
  const codex = new FakeCodex();
  const desktop = new FakeDesktop();
  const agents = new AgentService(store, codex, () => {}, desktop);
  const dashboard: DashboardSummary = {
    id: 'metrics',
    workspaceId: workspace.id,
    name: 'Metrics',
    description: '',
    version: 'one',
    backend: true,
    status: 'ready',
    commands: [
      { id: 'refresh', label: 'Refresh measurements', type: 'backend' },
      { id: 'investigate', label: 'Investigate measurements', type: 'agent' },
    ],
  };
  const get = vi.fn(async (workspaceId: string, id: string) => {
    if (workspaceId !== workspace.id || id !== dashboard.id)
      throw new StoreError('Dashboard not found.', 404);
    return structuredClone(dashboard);
  });
  const prepare = vi.fn(
    async (
      _workspace: string,
      _id: string,
      _version: string,
      _command: string,
      input: Record<string, unknown>,
      prompt?: string,
    ) => ({
      input,
      ...(prompt === undefined ? {} : { prompt }),
      summary: 'Review the resolved measurements.',
    }),
  );
  const execute = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ updated: true }));
  const runtime = { get, prepare, execute } as unknown as DashboardRuntime;
  const commands = await createDashboardCommands(dataDir, store, agents, runtime);
  cleanups.push(async () => {
    await commands.close();
    await agents.close();
    await store.flush();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function agentPreview(
    destination?: DashboardDestination,
    prompt = 'Investigate the latest measurements.',
  ) {
    return commands.preview(workspace.id, dashboard.id, {
      version: 'one',
      commandId: 'investigate',
      input: { period: 'today' },
      prompt,
      ...(destination ? { destination } : {}),
    });
  }
  return {
    dataDir,
    store,
    workspace,
    other,
    codex,
    desktop,
    agents,
    dashboard,
    runtime,
    get,
    prepare,
    execute,
    commands,
    agentPreview,
  };
}
const newDesktop = (
  provider: 'codex-desktop' | 'claude-desktop' = 'codex-desktop',
): DashboardDestination => ({
  kind: 'desktop',
  provider,
  folder: 'D:\\projects\\Measurements & notes',
  title: 'Measurement investigation',
});

describe('dashboard command review and execution', () => {
  it('freezes resolved inputs and executes a reviewed preview only once across concurrent retries', async () => {
    const f = await fixture();
    const work = deferred<unknown>();
    f.execute.mockReturnValue(work.promise);
    const prepared = {
      input: { source: { value: 42 }, user: 'reviewed' },
      summary: 'Resolved once.',
    };
    f.prepare.mockResolvedValue(prepared);
    const preview = await f.commands.preview(f.workspace.shortId, 'metrics', {
      version: 'one',
      commandId: 'refresh',
      input: { user: 'original' },
    });
    prepared.input.source.value = 99;
    preview.input.user = 'mutated by caller';
    const [first, retry] = await Promise.all([
      f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id }),
      f.commands.execute(f.workspace.shortId, 'metrics', { previewId: preview.id }),
    ]);
    expect(first.id).toBe(retry.id);
    expect(first.input).toEqual({ source: { value: 42 }, user: 'reviewed' });
    expect(first.status).toBe('running');
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledWith(
      f.workspace.id,
      'metrics',
      'one',
      'refresh',
      first.input,
    );
    work.resolve({ count: 7 });
    await vi.waitFor(async () =>
      expect((await f.commands.list(f.workspace.id, 'metrics'))[0]).toMatchObject({
        status: 'succeeded',
        result: { count: 7 },
      }),
    );
    f.dashboard.version = 'two';
    expect(
      (await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id })).status,
    ).toBe('succeeded');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects stale previews, cross-workspace execution and unreviewed destinations', async () => {
    const f = await fixture();
    const preview = await f.agentPreview(newDesktop());
    await expect(
      f.commands.execute(f.other.id, 'metrics', { previewId: preview.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.commands.execute(f.workspace.id, 'metrics', {
        previewId: preview.id,
        destination: { ...newDesktop(), title: 'Changed' } as DashboardDestination,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    f.dashboard.version = 'two';
    await expect(
      f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.desktop.sent).toHaveLength(0);
    expect(await f.store.listActivity(f.workspace.id)).toEqual([]);
  });

  it('requires a final destination preview and freezes existing chat bindings', async () => {
    const f = await fixture();
    const initial = await f.agentPreview();
    await expect(
      f.commands.execute(f.workspace.id, 'metrics', { previewId: initial.id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const item = await f.store.publishActivity({
      workspaceId: f.workspace.id,
      source: 'Codex',
      title: 'Existing',
      summary: '',
      status: 'in_progress',
      agentTarget: { provider: 'codex-desktop', sessionId: 'desktop-chat' },
    });
    const preview = await f.agentPreview({ kind: 'activity', activityId: item.id });
    await f.store.createAgentMessage(f.workspace.id, item.id, {
      id: randomUUID(),
      text: 'Change destination',
      target: { provider: 'codex-desktop', sessionId: 'other-chat' },
    });
    await expect(
      f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.desktop.sent).toHaveLength(0);
    const foreign = await f.store.publishActivity({
      workspaceId: f.other.id,
      source: 'Codex',
      title: 'Other',
      summary: '',
      status: 'done',
      agentTarget: { provider: 'codex', sessionId: 'test-codex' },
    });
    await expect(
      f.agentPreview({ kind: 'activity', activityId: foreign.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sends the reviewed prompt once and reports queued delivery until a real reply arrives', async () => {
    const f = await fixture();
    const item = await f.store.publishActivity({
      workspaceId: f.workspace.id,
      source: 'Codex',
      title: 'Existing',
      summary: '',
      status: 'in_progress',
      agentTarget: { provider: 'codex-desktop', sessionId: 'desktop-chat' },
    });
    const preview = await f.agentPreview({ kind: 'activity', activityId: item.id });
    expect(preview.prompt).toContain('"period": "today"');
    expect(preview.prompt).not.toContain('link_dashboard_session');
    await Promise.all([
      f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id }),
      f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id }),
    ]);
    await vi.waitFor(async () =>
      expect((await f.commands.list(f.workspace.id, 'metrics'))[0].status).toBe('queued'),
    );
    expect(f.desktop.sent).toHaveLength(1);
    expect(f.desktop.sent[0].text).toContain(preview.prompt);
    f.desktop.receipts.set(preview.id, {
      status: 'replied',
      reply: 'Measurements checked.',
      detail: 'Codex replied.',
    });
    const completed = (await f.commands.list(f.workspace.id, 'metrics'))[0];
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: { deliveryStatus: 'replied', reply: 'Measurements checked.' },
    });
    expect(f.desktop.sent).toHaveLength(1);
  });

  it.each(['codex-desktop', 'claude-desktop'] as const)(
    'prepares a %s link with the exact reviewed prompt and no invented session',
    async (provider) => {
      const f = await fixture();
      const destination = newDesktop(provider);
      const preview = await f.agentPreview(destination);
      expect(preview.prompt).toContain('link_dashboard_session');
      expect(preview.prompt).toContain(preview.id);
      expect(preview.prompt).toContain(f.workspace.shortId);
      expect(preview.destination).toEqual(destination);
      const run = await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id });
      expect(run).toMatchObject({ status: 'prepared', prompt: preview.prompt, destination });
      expect(run.activityId).toBeUndefined();
      expect(await f.store.listActivity(f.workspace.id)).toEqual([]);
      expect(f.desktop.sent).toHaveLength(0);
      expect(f.codex.sent).toHaveLength(0);
      const url = new URL(run.launchUrl!);
      expect(url.protocol).toBe(provider === 'codex-desktop' ? 'codex:' : 'claude:');
      expect(url.searchParams.get(provider === 'codex-desktop' ? 'prompt' : 'q')).toBe(
        preview.prompt,
      );
      expect(url.searchParams.get(provider === 'codex-desktop' ? 'path' : 'folder')).toBe(
        (destination as { folder: string }).folder,
      );
      expect(url.searchParams.has('submit')).toBe(false);
      expect(url.searchParams.has('model')).toBe(false);
    },
  );

  it('enforces absolute folders, final prompt limits and JSON-only prepared data', async () => {
    const f = await fixture();
    for (const folder of ['relative/project', 'D:relative', 'line\nbreak'])
      await expect(
        f.agentPreview({ ...newDesktop(), folder } as DashboardDestination),
      ).rejects.toMatchObject({ statusCode: 400 });
    const blank = await f.agentPreview({ ...newDesktop(), folder: '' } as DashboardDestination);
    const run = await f.commands.execute(f.workspace.id, 'metrics', { previewId: blank.id });
    expect(new URL(run.launchUrl!).searchParams.has('path')).toBe(false);
    f.prepare.mockResolvedValue({ input: {}, prompt: 'x'.repeat(14336), summary: '' });
    await expect(f.agentPreview(newDesktop('claude-desktop'))).rejects.toMatchObject({
      statusCode: 400,
    });
    f.prepare.mockResolvedValue({ input: { invalid: Number.NaN }, summary: '' });
    await expect(
      f.commands.preview(f.workspace.id, 'metrics', {
        version: 'one',
        commandId: 'refresh',
        input: {},
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('claims a prepared run once with an actual native session and preserves its title', async () => {
    const f = await fixture();
    const preview = await f.agentPreview(newDesktop());
    const run = await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id });
    const claim = {
      workspaceId: f.workspace.shortId,
      runId: run.id,
      provider: 'codex-desktop' as const,
      sessionId: randomUUID(),
    };
    await expect(f.commands.claim({ ...claim, workspaceId: f.other.id })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      f.commands.claim({ ...claim, provider: 'claude-desktop', sessionId: 'local_actual-session' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.commands.claim({ ...claim, sessionId: 'new' })).rejects.toMatchObject({
      statusCode: 400,
    });
    const [linked, repeated] = await Promise.all([
      f.commands.claim(claim),
      f.commands.claim(claim),
    ]);
    expect(linked.activityId).toBe(repeated.activityId);
    expect(linked.status).toBe('linked');
    const activities = await f.store.listActivity(f.workspace.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      title: 'Measurement investigation',
      desktopSession: { provider: 'codex-desktop', sessionId: claim.sessionId },
      agentTarget: { provider: 'codex-desktop', sessionId: claim.sessionId },
    });
    await expect(f.commands.claim({ ...claim, sessionId: randomUUID() })).rejects.toMatchObject({
      statusCode: 409,
    });
    await f.commands.close();
    const reopened = await createDashboardCommands(f.dataDir, f.store, f.agents, f.runtime);
    cleanups.push(() => reopened.close());
    expect((await reopened.claim(claim)).activityId).toBe(linked.activityId);
    expect(await f.store.listActivity(f.workspace.id)).toHaveLength(1);
  });

  it('retains one-time claim reservation if publishing fails, allowing only that session to retry', async () => {
    const f = await fixture();
    const preview = await f.agentPreview(newDesktop('claude-desktop'));
    await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id });
    const claim = {
      workspaceId: f.workspace.id,
      runId: preview.id,
      provider: 'claude-desktop' as const,
      sessionId: 'local_actual-session',
    };
    const publish = vi
      .spyOn(f.store, 'publishActivity')
      .mockRejectedValueOnce(new Error('Disk temporarily unavailable'));
    await expect(f.commands.claim(claim)).rejects.toThrow('Disk temporarily unavailable');
    await expect(
      f.commands.claim({ ...claim, sessionId: 'local_somebody-else' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const linked = await f.commands.claim(claim);
    expect(linked.status).toBe('linked');
    expect(publish).toHaveBeenCalledTimes(2);
    expect((await f.store.listActivity(f.workspace.id))[0].desktopSession).toEqual({
      provider: 'claude',
      sessionId: 'local_actual-session',
    });
  });

  it('persists previews and marks unfinished jobs interrupted on restart without replay', async () => {
    const f = await fixture();
    const work = deferred<unknown>();
    f.execute.mockReturnValue(work.promise);
    const preview = await f.commands.preview(f.workspace.id, 'metrics', {
      version: 'one',
      commandId: 'refresh',
      input: { value: 3 },
    });
    await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id });
    await f.commands.close();
    // Simulate the durable running record left by a sudden server exit.
    const file = join(f.dataDir, 'dashboard-commands.json');
    const disk = JSON.parse(await readFile(file, 'utf8'));
    disk.runs[0].run.status = 'running';
    await writeFile(file, JSON.stringify(disk));
    const restarted = await createDashboardCommands(f.dataDir, f.store, f.agents, f.runtime);
    cleanups.push(() => restarted.close());
    expect((await restarted.list(f.workspace.shortId, 'metrics'))[0]).toMatchObject({
      status: 'interrupted',
      input: { value: 3 },
    });
    expect(
      (await restarted.execute(f.workspace.id, 'metrics', { previewId: preview.id })).status,
    ).toBe('interrupted');
    expect(f.execute).toHaveBeenCalledTimes(1);
    work.resolve({ late: true });
    await Promise.resolve();
    expect((await restarted.list(f.workspace.id, 'metrics'))[0].status).toBe('interrupted');
  });

  it('keeps invalid history untouched and records backend failures without retrying them', async () => {
    const f = await fixture();
    f.execute.mockRejectedValue(new Error('Database unavailable'));
    const preview = await f.commands.preview(f.workspace.id, 'metrics', {
      version: 'one',
      commandId: 'refresh',
      input: {},
    });
    await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id });
    await vi.waitFor(async () =>
      expect((await f.commands.list(f.workspace.id, 'metrics'))[0]).toMatchObject({
        status: 'failed',
        detail: 'Database unavailable',
      }),
    );
    await f.commands.close();
    const file = join(f.dataDir, 'dashboard-commands.json');
    await writeFile(file, '{broken');
    await expect(createDashboardCommands(f.dataDir, f.store, f.agents, f.runtime)).rejects.toThrow(
      'Original file has been preserved',
    );
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('does not report execution failure or replay a completed action when saving its result fails', async () => {
    const f = await fixture();
    const work = deferred<unknown>();
    f.execute.mockReturnValue(work.promise);
    const preview = await f.commands.preview(f.workspace.id, 'metrics', {
      version: 'one',
      commandId: 'refresh',
      input: {},
    });
    await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id });
    await f.store.flush();
    const save = vi
      .mocked(rename)
      .mockClear()
      .mockRejectedValueOnce(new Error('Storage unavailable'));
    work.resolve({ updated: true });
    await vi.waitFor(async () =>
      expect((await f.commands.list(f.workspace.id, 'metrics'))[0]).toMatchObject({
        status: 'interrupted',
        detail: expect.stringContaining(
          'The command completed, but its result could not be saved.',
        ),
      }),
    );
    expect(save).toHaveBeenCalledTimes(2);
    const retried = await f.commands.execute(f.workspace.id, 'metrics', { previewId: preview.id });
    expect(retried.status).toBe('interrupted');
    expect(f.execute).toHaveBeenCalledTimes(1);
    const disk = JSON.parse(await readFile(join(f.dataDir, 'dashboard-commands.json'), 'utf8'));
    expect(disk.runs[0].run.status).toBe('interrupted');
  });
});
