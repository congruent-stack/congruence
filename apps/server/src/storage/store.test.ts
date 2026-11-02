import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardChange, PublishActivity } from '@congruence/contracts';
import { createStore } from './store.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-store-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local JSON storage', () => {
  it.each([
    ['indented code', '    const a = 1;\n    const b = 2;\n'],
    ['leading and nested whitespace', '\n\n- Checks\n  - First check.  \n  - Second check.\n\n'],
    ['trailing hard-break spaces', 'First line.  \r\nNext line.  '],
  ])(
    'preserves Markdown %s exactly through retries, history and restarts',
    async (_name, summary) => {
      const dataDir = await temporaryDirectory();
      const store = await createStore(dataDir);
      const workspace = await store.createWorkspace({
        name: 'Markdown',
        description: '',
        repositories: [],
      });
      const create: PublishActivity = {
        workspaceId: workspace.shortId,
        requestId: randomUUID(),
        title: '  Markdown notes  ',
        subtitle: '  Current checks  ',
        summary,
        source: 'codex',
        status: 'in_progress',
      };
      const initial = await store.publishActivity(create);
      expect(initial).toMatchObject({
        title: 'Markdown notes',
        subtitle: 'Current checks',
        summary,
        revision: 1,
      });
      const update = { ...create, requestId: undefined, workId: initial.workId };
      expect(await store.publishActivity(create)).toEqual(initial);
      expect(await store.publishActivity(update)).toEqual(initial);
      expect(await store.listActivityVersions(workspace.id, initial.id)).toEqual([initial]);
      const disk = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
      expect(disk.activity[0].summary).toBe(summary);
      expect(disk.activityVersions[0].summary).toBe(summary);
      expect(disk.activityRequests[0].input.summary).toBe(summary);
      // An intentional whitespace-only edit is real content and must not disappear as a no-op.
      const changed = await store.publishActivity({ ...update, summary: summary.trim() });
      expect(changed).toMatchObject({ summary: summary.trim(), revision: 2 });
      expect(await store.publishActivity({ ...update, summary: summary.trim() })).toEqual(changed);
      const restarted = await createStore(dataDir);
      expect(await restarted.listActivityVersions(workspace.shortId, initial.id)).toEqual([
        initial,
        changed,
      ]);
      expect(await restarted.publishActivity(create)).toEqual(changed);
      expect(await restarted.publishActivity({ ...update, summary: summary.trim() })).toEqual(
        changed,
      );
    },
  );

  it('allocates stable short workspace and message aliases despite collisions', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    vi.mocked(randomInt)
      .mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => 2);
    const a = await store.createWorkspace({ name: 'A', description: '', repositories: [] });
    const b = await store.createWorkspace({ name: 'B', description: '', repositories: [] });
    expect([a.shortId, b.shortId]).toEqual(['00000001', '00000002']);
    expect(await store.getWorkspace(a.shortId)).toEqual(a);
    const renamed = await store.updateWorkspace(a.shortId, {
      name: 'Renamed',
      description: '',
      repositories: [],
    });
    expect(renamed).toMatchObject({ id: a.id, shortId: a.shortId, name: 'Renamed' });
    const item = await store.publishActivity({
      workspaceId: a.shortId,
      title: 'Task',
      summary: '',
      source: 'codex',
      status: 'in_progress',
    });
    const input = {
      id: randomUUID(),
      target: { provider: 'claude-desktop' as const, sessionId: 'local_session' },
      text: 'Continue',
    };
    vi.mocked(randomInt)
      .mockImplementationOnce(() => 3)
      .mockImplementationOnce(() => 3)
      .mockImplementationOnce(() => 4);
    const first = await store.createAgentMessage(a.shortId, item.id, input);
    const duplicate = await store.createAgentMessage(a.id, item.id, input);
    const second = await store.createAgentMessage(a.id, item.id, { ...input, id: randomUUID() });
    expect(first.message).toMatchObject({ workspaceId: a.id, shortId: '00000003' });
    expect(duplicate).toEqual({ message: first.message, created: false });
    expect(second.message.shortId).toBe('00000004');
    expect(await store.findAgentMessage(first.message.shortId)).toEqual(first.message);
    expect(await store.findAgentMessage(first.message.id)).toEqual(first.message);
    expect(await store.listAgentMessages(a.shortId, item.id)).toEqual([
      first.message,
      second.message,
    ]);
    await expect(store.createAgentMessage(b.shortId, item.id, input)).rejects.toMatchObject({
      statusCode: 404,
    });
    const restarted = await createStore(dataDir);
    expect(await restarted.getWorkspace(a.shortId)).toEqual(renamed);
    expect(await restarted.findAgentMessage(first.message.shortId)).toEqual(first.message);
    expect(await restarted.listAgentMessages(a.shortId, item.id)).toEqual([
      first.message,
      second.message,
    ]);
  });

  it('normalizes workspace aliases for reports, retry receipts, reads and notifications', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const a = await store.createWorkspace({ name: 'A', description: '', repositories: [] });
    const b = await store.createWorkspace({ name: 'B', description: '', repositories: [] });
    const changes: DashboardChange[] = [];
    store.subscribe((change) => changes.push(change));
    const input: PublishActivity = {
      workspaceId: a.shortId,
      requestId: randomUUID(),
      title: 'Task',
      summary: 'Starting',
      source: 'codex',
      status: 'in_progress',
    };
    const first = await store.publishActivity(input);
    expect(first.workspaceId).toBe(a.id);
    expect(await store.publishActivity({ ...input, workspaceId: a.id })).toEqual(first);
    expect(await store.findActivityForReport(input)).toEqual(first);
    const current = await store.publishActivity({
      ...input,
      requestId: undefined,
      workId: first.workId,
      summary: 'Finished',
      status: 'done',
    });
    expect(await store.publishActivity(input)).toEqual(current);
    expect(await store.listActivity(a.shortId)).toEqual([current]);
    expect(await store.getActivity(a.shortId, first.id)).toEqual(current);
    expect(await store.listActivityVersions(a.shortId, first.id)).toEqual([first, current]);
    expect(await store.listActivity(b.shortId)).toEqual([]);
    for (const result of [
      store.getActivity(b.shortId, first.id),
      store.listActivityVersions(b.shortId, first.id),
      store.listAgentMessages(b.shortId, first.id),
      store.publishActivity({ ...input, workspaceId: b.shortId }),
    ]) {
      await expect(result).rejects.toMatchObject({ statusCode: expect.any(Number) });
    }
    store.notifyAgents(a.shortId);
    expect(changes).toEqual([
      { resource: 'activity', workspaceId: a.id },
      { resource: 'activity', workspaceId: a.id },
      { resource: 'agents', workspaceId: a.id },
    ]);
    const disk = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    expect(disk.activityRequests[0].input.workspaceId).toBe(a.id);
    const restarted = await createStore(dataDir);
    expect(await restarted.publishActivity(input)).toEqual(current);
    expect(await restarted.findActivityForReport({ ...input, workspaceId: a.id })).toEqual(current);
  });

  it('backfills v2 aliases once without changing history, canonical references or retry receipts', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const a = await store.createWorkspace({ name: 'A', description: '', repositories: [] });
    const b = await store.createWorkspace({ name: 'B', description: '', repositories: [] });
    const input: PublishActivity = {
      workspaceId: a.id,
      requestId: randomUUID(),
      title: 'Task',
      summary: '',
      source: 'codex',
      status: 'in_progress',
    };
    const item = await store.publishActivity(input);
    const target = { provider: 'claude-desktop' as const, sessionId: 'local_session' };
    const first = await store.createAgentMessage(a.id, item.id, {
      id: randomUUID(),
      target,
      text: 'First',
    });
    const second = await store.createAgentMessage(a.id, item.id, {
      id: randomUUID(),
      target,
      text: 'Second',
    });
    const file = join(dataDir, 'state.json');
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    legacy.version = 2;
    for (const workspace of legacy.workspaces) delete workspace.shortId;
    for (const message of legacy.agentMessages) delete message.shortId;
    const original = JSON.stringify(legacy);
    await writeFile(file, original);
    vi.mocked(randomInt)
      .mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => 2)
      .mockImplementationOnce(() => 3)
      .mockImplementationOnce(() => 3)
      .mockImplementationOnce(() => 4);
    const migrated = await createStore(dataDir);
    expect(await migrated.getWorkspace('00000001')).toMatchObject({ id: a.id });
    expect(await migrated.getWorkspace('00000002')).toMatchObject({ id: b.id });
    expect(await migrated.findAgentMessage('00000003')).toMatchObject({ id: first.message.id });
    expect(await migrated.findAgentMessage('00000004')).toMatchObject({ id: second.message.id });
    expect(await migrated.listActivity(a.id)).toEqual(legacy.activity);
    expect(await migrated.listActivityVersions(a.id, item.id)).toEqual(legacy.activityVersions);
    expect(await migrated.publishActivity({ ...input, workspaceId: '00000001' })).toEqual(
      legacy.activity[0],
    );
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.version).toBe(3);
    expect(saved.activityRequests).toEqual(legacy.activityRequests);
    const backups = (await readdir(dataDir)).filter((name) => name.endsWith('.backup.json'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^state\.v2-/);
    expect(await readFile(join(dataDir, backups[0]), 'utf8')).toBe(original);
    const restarted = await createStore(dataDir);
    expect(await restarted.listWorkspaces()).toEqual(await migrated.listWorkspaces());
    expect(await restarted.listAgentMessages(a.id, item.id)).toEqual(
      await migrated.listAgentMessages(a.id, item.id),
    );
    expect((await readdir(dataDir)).filter((name) => name.endsWith('.backup.json'))).toEqual(
      backups,
    );
    for (const field of ['workspaces', 'agentMessages']) {
      const invalid = structuredClone(saved);
      invalid[field][1].shortId = invalid[field][0].shortId;
      const corrupt = JSON.stringify(invalid);
      await writeFile(file, corrupt);
      await expect(createStore(dataDir)).rejects.toThrow('Original file has been preserved');
      expect(await readFile(file, 'utf8')).toBe(corrupt);
    }
  });

  it('generates globally unique identities and records current snapshots without revising no-op reports', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const a = await store.createWorkspace({ name: 'A', description: '', repositories: [] });
    const b = await store.createWorkspace({ name: 'B', description: '', repositories: [] });
    const report: PublishActivity = {
      workspaceId: a.id,
      title: 'Build feature',
      subtitle: 'Investigating',
      summary: 'Reading the code.',
      source: 'codex',
      status: 'in_progress',
    };
    const initial = await store.publishActivity(report);
    expect(initial.workId).toMatch(/^[a-z0-9]{8}$/);
    expect(initial.workKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const others = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        store.publishActivity({ ...report, workspaceId: i % 2 ? a.id : b.id }),
      ),
    );
    expect(new Set([initial, ...others].map((item) => item.workId)).size).toBe(41);
    expect(new Set([initial, ...others].map((item) => item.workKey)).size).toBe(41);
    const update: PublishActivity = {
      workspaceId: a.id,
      workKey: initial.workKey,
      subtitle: 'Ready',
      summary: 'The feature is working; checks passed.',
      source: 'codex',
      status: 'done',
    };
    const complete = await store.publishActivity(update);
    expect(complete).toMatchObject({
      id: initial.id,
      workId: initial.workId,
      workKey: initial.workKey,
      title: initial.title,
      subtitle: 'Ready',
      revision: 2,
    });
    expect(await store.publishActivity(update)).toEqual(complete);
    expect(await store.listActivityVersions(a.id, initial.id)).toEqual([initial, complete]);
    const snapshots = await store.listActivityVersions(a.id, initial.id);
    snapshots[0].summary = 'Mutated client copy';
    expect((await store.listActivityVersions(a.id, initial.id))[0]).toEqual(initial);
    expect(await (await createStore(dataDir)).listActivityVersions(a.id, initial.id)).toEqual([
      initial,
      complete,
    ]);
    await expect(store.listActivityVersions(b.id, initial.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('rejects title changes, invented identifiers, mixed identities and cross-workspace updates', async () => {
    const store = await createStore(await temporaryDirectory());
    const a = await store.createWorkspace({ name: 'A', description: '', repositories: [] });
    const b = await store.createWorkspace({ name: 'B', description: '', repositories: [] });
    const report: PublishActivity = {
      workspaceId: a.id,
      title: 'Original title',
      summary: '',
      source: 'codex',
      status: 'in_progress',
    };
    const initial = await store.publishActivity(report);
    const other = await store.publishActivity(report);
    await expect(
      store.publishActivity({ ...report, title: 'Renamed', workKey: initial.workKey }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.publishActivity({ ...report, workId: 'invented' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(store.publishActivity({ ...report, workKey: randomUUID() })).rejects.toMatchObject(
      { statusCode: 404 },
    );
    await expect(
      store.publishActivity({ ...report, workKey: initial.workKey, workspaceId: b.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      store.publishActivity({ ...report, workKey: initial.workKey, workId: other.workId }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.publishActivity({ ...report, title: undefined })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await store.listActivityVersions(a.id, initial.id)).toEqual([initial]);
    const changedSource = await store.publishActivity({
      ...report,
      title: undefined,
      workId: initial.workId,
      source: 'claude',
      subtitle: 'New producer',
    });
    expect(changedSource).toMatchObject({
      id: initial.id,
      title: initial.title,
      source: 'claude',
      revision: 2,
    });
  });

  it('deduplicates concurrent and delayed create retries without reverting current content', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const workspace = await store.createWorkspace({
      name: 'Retries',
      description: '',
      repositories: [],
    });
    const report: PublishActivity = {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      title: 'Retries',
      summary: 'Starting',
      source: 'codex',
      status: 'in_progress',
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.publishActivity(report)),
    );
    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    const item = results[0];
    const current = await store.publishActivity({
      ...report,
      requestId: undefined,
      workKey: item.workKey,
      status: 'done',
      summary: 'Finished',
    });
    const restarted = await createStore(dataDir);
    expect(await restarted.publishActivity(report)).toEqual(current);
    expect(await restarted.findActivityForReport(report)).toEqual(current);
    await expect(
      restarted.publishActivity({ ...report, summary: 'Different create' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      restarted.publishActivity({ ...report, workKey: item.workKey }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await restarted.listActivityVersions(workspace.id, item.id)).toEqual([item, current]);
  });

  it('migrates old cards once, preserves messages and old lookup aliases, and backs up original data', async () => {
    const dataDir = await temporaryDirectory();
    const now = '2026-10-30T12:00:00.000Z';
    const workspace = {
      id: 'workspace',
      name: 'Legacy',
      description: '',
      repositories: [],
      createdAt: now,
      updatedAt: now,
    };
    const legacyItem = {
      id: 'activity',
      workspaceId: workspace.id,
      workId: '00000001',
      title: 'Original title',
      summary: 'Original report',
      status: 'in_progress',
      source: 'codex',
      createdAt: now,
      updatedAt: now,
    };
    const message = {
      id: randomUUID(),
      workspaceId: workspace.id,
      activityId: legacyItem.id,
      target: { provider: 'codex', sessionId: 'session' },
      text: 'Continue',
      status: 'accepted',
      detail: 'Delivered',
      createdAt: now,
      updatedAt: now,
    };
    const original = JSON.stringify({
      version: 1,
      workspaces: [workspace],
      activity: [legacyItem],
      agentMessages: [message],
    });
    await writeFile(join(dataDir, 'state.json'), original);
    vi.mocked(randomInt)
      .mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => 2);
    const store = await createStore(dataDir);
    const item = await store.getActivity(workspace.id, legacyItem.id);
    expect(item).toMatchObject({
      id: legacyItem.id,
      title: legacyItem.title,
      summary: legacyItem.summary,
      subtitle: '',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(item.workId).not.toBe(legacyItem.workId);
    expect(item.workId).toBe('00000002');
    const migratedMessages = await store.listAgentMessages(workspace.id, item.id);
    expect(migratedMessages).toMatchObject([message]);
    expect(migratedMessages[0].shortId).toMatch(/^[a-z0-9]{8}$/);
    expect((await store.getWorkspace(workspace.id)).shortId).toMatch(/^[a-z0-9]{8}$/);
    const backups = (await readdir(dataDir)).filter((name) => name.endsWith('.backup.json'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dataDir, backups[0]), 'utf8')).toBe(original);
    expect(await (await createStore(dataDir)).getActivity(workspace.id, item.id)).toEqual(item);
    const update: PublishActivity = {
      workspaceId: workspace.id,
      workId: legacyItem.workId,
      source: 'codex',
      status: 'done',
      summary: 'Done now',
    };
    expect(await store.findActivityForReport(update)).toEqual(item);
    const current = await store.publishActivity(update);
    expect(current).toMatchObject({
      workKey: item.workKey,
      workId: item.workId,
      title: item.title,
      status: 'done',
      revision: 2,
    });
    expect(await store.listActivityVersions(workspace.id, item.id)).toEqual([item, current]);
    vi.mocked(randomInt)
      .mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => 2)
      .mockImplementationOnce(() => 3);
    const next = await store.publishActivity({
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Next task',
      summary: '',
      status: 'in_progress',
    });
    expect(next.workId).toBe('00000003');
    expect(await store.findActivityForReport(update)).toEqual(current);
  });

  it('preserves invalid history data rather than loading a mismatched current version', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const workspace = await store.createWorkspace({
      name: 'History',
      description: '',
      repositories: [],
    });
    await store.publishActivity({
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Task',
      summary: 'Current',
      status: 'done',
    });
    const file = join(dataDir, 'state.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.activityVersions[0].summary = 'Different';
    const corrupt = JSON.stringify(data);
    await writeFile(file, corrupt);
    await expect(createStore(dataDir)).rejects.toThrow('Original file has been preserved');
    expect(await readFile(file, 'utf8')).toBe(corrupt);
  });

  it('adds and retains a native desktop reference without confusing it with a messaging target or a new destination', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const workspace = await store.createWorkspace({
      name: 'Desktop',
      description: '',
      repositories: [],
    });
    const report: PublishActivity = {
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Desktop work',
      summary: '',
      status: 'in_progress',
      agentTarget: { provider: 'codex', sessionId: 'shared-server-chat' },
    };
    const original = await store.publishActivity(report);
    report.workKey = original.workKey;
    const desktopSession = { provider: 'codex-desktop' as const, sessionId: 'native-desktop-id' };
    const changes: DashboardChange[] = [];
    store.subscribe((change) => changes.push(change));
    const linked = await store.publishActivity({ ...report, desktopSession });
    expect(linked).toMatchObject({
      id: original.id,
      desktopSession,
      agentTarget: report.agentTarget,
    });
    expect(await store.publishActivity({ ...report, desktopSession })).toEqual(linked);
    expect(await store.publishActivity(report)).toEqual(linked);
    expect(changes).toHaveLength(1);
    expect(
      (await (await createStore(dataDir)).getActivity(workspace.id, linked.id)).desktopSession,
    ).toEqual(desktopSession);
    await store.createAgentMessage(workspace.id, linked.id, {
      id: randomUUID(),
      text: 'Same session',
      target: report.agentTarget!,
    });
    expect((await store.getActivity(workspace.id, linked.id)).desktopSession).toEqual(
      desktopSession,
    );
    const target = { provider: 'codex' as const, sessionId: 'different-chat' };
    await store.createAgentMessage(workspace.id, linked.id, {
      id: randomUUID(),
      text: 'Use the other session',
      target,
    });
    expect((await store.getActivity(workspace.id, linked.id)).desktopSession).toBeUndefined();
    const updated = await store.publishActivity({ ...report, desktopSession, status: 'done' });
    expect(updated.desktopSession).toBeUndefined();
    expect(updated.agentTarget).toEqual(target);
    const versions = await store.listActivityVersions(workspace.id, linked.id);
    expect(versions.map((item) => item.revision)).toEqual([1, 2, 3, 4]);
    expect(versions[1]).toMatchObject({ desktopSession, agentTarget: report.agentTarget });
    expect(versions[2].desktopSession).toBeUndefined();
    expect(versions[2].agentTarget).toEqual(target);
    expect(
      (await (await createStore(dataDir)).getActivity(workspace.id, linked.id)).desktopSession,
    ).toBeUndefined();
  });

  it('links a reported session once and preserves a user-selected destination through later reports', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const workspace = await store.createWorkspace({
      name: 'Linked work',
      description: '',
      repositories: [],
    });
    const report: PublishActivity = {
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Linked task',
      summary: '',
      status: 'in_progress',
    };
    const original = await store.publishActivity(report);
    report.workKey = original.workKey;
    const target = { provider: 'codex-desktop' as const, sessionId: 'actual-chat' };
    const changes: DashboardChange[] = [];
    store.subscribe((change) => changes.push(change));
    const linked = await store.publishActivity({ ...report, agentTarget: target });
    expect(linked).toMatchObject({ id: original.id, agentTarget: target });
    expect(await store.publishActivity({ ...report, agentTarget: target })).toEqual(linked);
    expect(await store.publishActivity(report)).toEqual(linked);
    expect(changes).toHaveLength(1);
    const selected = { provider: 'codex-desktop' as const, sessionId: 'chosen-by-user' };
    await store.createAgentMessage(workspace.id, linked.id, {
      id: randomUUID(),
      text: 'Continue here',
      target: selected,
    });
    const updated = await store.publishActivity({ ...report, status: 'done', agentTarget: target });
    expect(updated.agentTarget).toEqual(selected);
    expect(
      (await (await createStore(dataDir)).getActivity(workspace.id, original.id)).agentTarget,
    ).toEqual(selected);
  });

  it('notifies subscribers only for committed changes and supports unsubscribe', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const changes: DashboardChange[] = [];
    store.subscribe(() => {
      throw new Error('Disconnected subscriber');
    });
    const unsubscribe = store.subscribe((change) => changes.push(change));
    const workspace = await store.createWorkspace({
      name: 'Live',
      description: '',
      repositories: [],
    });
    const report: PublishActivity = {
      workspaceId: workspace.id,
      title: 'Live update',
      summary: '',
      status: 'in_progress',
      source: 'Codex',
    };
    report.workKey = (await store.publishActivity(report)).workKey;
    await store.publishActivity(report);
    await expect(store.publishActivity({ ...report, workspaceId: 'missing' })).rejects.toThrow();
    expect(changes).toEqual([
      { resource: 'workspaces', workspaceId: workspace.id },
      { resource: 'activity', workspaceId: workspace.id },
    ]);
    expect(JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).activity).toHaveLength(
      1,
    );
    unsubscribe();
    await store.publishActivity({ ...report, status: 'done' });
    expect(changes).toHaveLength(2);
  });

  it('persists a zero-repository workspace and last reported state across restarts', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const workspace = await store.createWorkspace({
      name: 'Research',
      description: '',
      repositories: [],
    });
    const payload: PublishActivity = {
      workspaceId: workspace.id,
      title: 'Compare libraries',
      summary: 'Reading the documentation.',
      status: 'in_progress',
      source: 'Codex',
    };
    const activity = await store.publishActivity(payload);
    const reopened = await createStore(dataDir);
    expect(await reopened.listWorkspaces()).toEqual([workspace]);
    expect(await reopened.listActivity(workspace.id)).toEqual([activity]);
    expect((await reopened.listActivity(workspace.id))[0].status).toBe('in_progress');
  });

  it('upserts repeated work without changing IDs or duplicating events, isolated by workspace and source', async () => {
    const store = await createStore(await temporaryDirectory());
    const a = await store.createWorkspace({ name: 'A', description: '', repositories: [] });
    const b = await store.createWorkspace({
      name: 'B',
      description: '',
      repositories: ['D:/dev/project'],
    });
    const payload: PublishActivity = {
      workspaceId: a.id,
      title: 'Build feature',
      summary: '',
      status: 'in_progress',
      source: 'Codex',
    };
    const initial = await store.publishActivity(payload);
    payload.workKey = initial.workKey;
    expect(await store.publishActivity(payload)).toEqual(initial);
    const complete = await store.publishActivity({
      ...payload,
      status: 'done',
      summary: 'Tests passed.',
    });
    expect(complete.id).toBe(initial.id);
    expect(complete.createdAt).toBe(initial.createdAt);
    expect(await store.listActivity(a.id)).toEqual([complete]);
    const otherWorkspace = await store.publishActivity({
      ...payload,
      workKey: undefined,
      workspaceId: b.id,
    });
    const otherSource = await store.publishActivity({
      ...payload,
      workKey: undefined,
      source: 'Claude',
    });
    expect(otherWorkspace.id).not.toBe(initial.id);
    expect(otherSource.id).not.toBe(initial.id);
    expect(await store.listActivity(a.id)).toHaveLength(2);
    expect(await store.listActivity(b.id)).toEqual([otherWorkspace]);
  });

  it('serializes concurrent producers without lost work and keeps disk and memory consistent', async () => {
    const dataDir = await temporaryDirectory();
    const store = await createStore(dataDir);
    const workspace = await store.createWorkspace({
      name: 'Concurrent',
      description: '',
      repositories: [],
    });
    const requests = Array.from({ length: 24 }, () => randomUUID());
    const publish = (index: number) =>
      store.publishActivity({
        workspaceId: workspace.id,
        requestId: requests[index],
        title: `Task ${index}`,
        summary: '',
        status: 'in_progress',
        source: index % 2 ? 'Codex' : 'Claude',
      });
    await Promise.all(Array.from({ length: 24 }, (_, index) => publish(index)));
    await Promise.all(Array.from({ length: 24 }, (_, index) => publish(index)));
    expect(await store.listActivity(workspace.id)).toHaveLength(24);
    const reopened = await createStore(dataDir);
    expect(await reopened.listActivity(workspace.id)).toEqual(
      await store.listActivity(workspace.id),
    );
  });

  it('preserves an unreadable or unsupported data file instead of resetting it', async () => {
    const dataDir = await temporaryDirectory();
    const file = join(dataDir, 'state.json');
    for (const contents of [
      '{malformed',
      JSON.stringify({ version: 99, workspaces: [], activity: [] }),
    ]) {
      await writeFile(file, contents);
      await expect(createStore(dataDir)).rejects.toThrow('Original file has been preserved');
      expect(await readFile(file, 'utf8')).toBe(contents);
    }
  });

  it('rejects invalid input and unknown workspaces without poisoning the write queue', async () => {
    const store = await createStore(await temporaryDirectory());
    await expect(
      store.createWorkspace({ name: '  ', description: '', repositories: [] }),
    ).rejects.toThrow();
    await expect(
      store.publishActivity({
        workspaceId: 'missing',
        title: 'Unknown',
        summary: '',
        status: 'done',
        source: 'Codex',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const workspace = await store.createWorkspace({
      name: 'Valid',
      description: '',
      repositories: [],
    });
    await expect(
      store.publishActivity({
        workspaceId: workspace.id,
        title: 'Unsafe URL',
        summary: '',
        status: 'done',
        source: 'Codex',
        sourceUrl: 'javascript:alert(1)',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await store.listWorkspaces()).toEqual([workspace]);
    expect(await store.listActivity(workspace.id)).toEqual([]);
  });
});
