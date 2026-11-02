import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublishActivitySchema, type Activity, type PublishActivity } from '@congruence/contracts';
import { buildApp } from '../app.js';

describe('MCP over the real HTTP endpoint', () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let client: Client;
  const clients: Client[] = [];

  async function connect(name: string, modern = false, userAgent?: string): Promise<Client> {
    const next = new Client(
      { name, version: '1.0.0' },
      modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
    );
    clients.push(next);
    await next.connect(
      new StreamableHTTPClientTransport(
        new URL('/mcp', baseUrl),
        userAgent ? { requestInit: { headers: { 'User-Agent': userAgent } } } : undefined,
      ),
    );
    return next;
  }

  function update(overrides: Partial<PublishActivity> = {}): PublishActivity {
    return {
      workspaceId,

      title: 'Check the dashboard integration',
      summary: 'Working on a bounded test.',
      status: 'in_progress',
      source: 'codex',
      ...overrides,
    };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'congruence-mcp-'));
    app = await buildApp({
      dataDir,
      serveWeb: false,
      claudeSettingsPath: join(dataDir, 'claude-settings.json'),
    });
    workspaceId = (
      await app.store.createWorkspace({ name: 'Project', description: '', repositories: [] })
    ).id;
    otherWorkspaceId = (
      await app.store.createWorkspace({ name: 'Other project', description: '', repositories: [] })
    ).id;
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    client = await connect('integration-test');
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((entry) => entry.close()));
    if (app) await app.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('discovers TypeBox-backed tools and the available workspaces', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'create_dashboard',
      'get_agent_settings',
      'get_dashboard_directory',
      'link_dashboard_session',
      'list_activity',
      'list_dashboards',
      'list_workspaces',
      'propose_agent_settings',
      'publish_activity',
      'publish_dashboard',
    ]);
    const instructions = client.getInstructions()!;
    for (const host of [
      'codex-desktop',
      'codex-cli',
      'Claude Code in the desktop app',
      'Claude Code CLI',
    ])
      expect(instructions).toContain(host);
    expect(instructions).not.toMatch(/channel|claudeCommand|get_congruence_session/);
    expect(instructions.slice(0, 512)).toContain('CGR:ACT');
    expect(instructions).toContain('Activity reporting is opt-in');
    expect(instructions).toContain('human explicitly switches activity or stops reporting');
    expect(instructions).toContain('A done status does not disable reporting');
    expect(instructions).not.toMatch(/At connection start|At task start|before substantive work/);
    expect(instructions).toContain('never guess');
    expect(instructions).toContain('Never approve your own request');
    expect(instructions).toContain('CLAUDE_CODE_HOST_SESSION_ID');
    expect(instructions).toContain('claudeDesktop.nextStep');
    for (const guidance of [
      'create the current activity with status in_progress if it does not exist',
      'do not wait until completion to create it',
      'For every new task or follow-up, publish in_progress on that same activity before starting',
      'If anything prevents finishing the current task, publish blocked',
      'When the blocker is resolved, publish in_progress before resuming',
      'Publish done only when the current task is complete',
      'These status transitions are meaningful updates',
      'choose a short, generic title for the kind of work',
      'Leave exact places, dates, versions, quantities, and current outcomes to subtitle and summary',
      'Keep existing titles unchanged',
      'Edit subtitle and summary surgically',
      'Preserve unchanged wording, order, indentation, and line breaks',
      'current reality takes priority over a small diff',
      'Add new bullets or sub-bullets when there are new facts',
      'Write the summary in Markdown',
      'do not repeat their information unless adding relevant new information',
      'group related facts under a short "- Topic" parent bullet',
      'two-space-indented "  - Fact" sub-bullets and one fact per line',
      'Do not flatten related details into top-level bullets',
      'preserve existing groups and edit or add facts within the relevant group',
      'Do not manually wrap lines or reformat unchanged text for style alone',
      'Prefer ASD-STE100 Simplified Technical English',
    ]) {
      expect(instructions).toContain(guidance);
      expect(tools.tools.find((tool) => tool.name === 'publish_activity')?.description).toContain(
        guidance,
      );
    }
    expect(tools.tools.find((tool) => tool.name === 'publish_activity')?.inputSchema).toEqual(
      PublishActivitySchema,
    );
    const properties = tools.tools.find((tool) => tool.name === 'publish_activity')?.inputSchema
      .properties as Record<string, { description: string }>;
    expect(properties.title.description).toContain('generic plain-text title');
    expect(properties.title.description).toContain('immutable afterwards');
    expect(properties.status.description).toContain('create the activity with in_progress');
    expect(properties.status.description).toContain('For every new task or follow-up');
    expect(properties.status.description).toContain('blocked whenever anything prevents finishing');
    expect(properties.subtitle.description).toContain(
      'specifics here instead of in the fixed title',
    );
    const summaryInput = properties.summary;
    expect(summaryInput.description).toContain('Current state in Markdown');
    expect(summaryInput.description).toContain(
      'do not repeat their information unless adding relevant new information',
    );
    expect(summaryInput.description).toContain('Group related facts');
    expect(summaryInput.description).toContain('two leading spaces');
    expect(summaryInput.description).toContain(
      '- Forecast\n  - Sunday: Cloudy.\n  - Monday: Rain.\n- Advice: Bring an umbrella.',
    );
    expect(await app.store.listActivity(workspaceId)).toEqual([]);
    const result = await client.callTool({ name: 'list_workspaces', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      workspaces: [
        { id: workspaceId, name: 'Project', repositories: [] },
        { id: otherWorkspaceId, name: 'Other project' },
      ],
    });
  });

  it('creates and locates workspace dashboard source through MCP without enabling activity reporting', async () => {
    const result = await client.callTool({
      name: 'create_dashboard',
      arguments: { workspaceId, name: 'Metrics' },
    });
    expect(result.isError).not.toBe(true);
    const location = result.structuredContent as {
      dashboard: { id: string };
      directory: string;
      instructionsPath: string;
    };
    expect(location.directory).toContain(dataDir);
    expect(await readFile(location.instructionsPath, 'utf8')).toContain('publish_dashboard');
    const found = await client.callTool({
      name: 'get_dashboard_directory',
      arguments: { workspaceId, dashboardId: location.dashboard.id },
    });
    expect(found.structuredContent).toEqual(location);
    const other = await client.callTool({
      name: 'get_dashboard_directory',
      arguments: { workspaceId: otherWorkspaceId, dashboardId: location.dashboard.id },
    });
    expect(other.isError).toBe(true);
    expect(await app.store.listActivity(workspaceId)).toEqual([]);
    expect(client.getInstructions()).toContain(
      'Building a dashboard does not enable activity reporting',
    );
  });

  it('publishes a dashboard and links only a submitted native session to its prepared request', async () => {
    const created = await client.callTool({
      name: 'create_dashboard',
      arguments: { workspaceId, name: 'Analysis' },
    });
    const location = created.structuredContent as { dashboard: { id: string }; directory: string };
    await writeFile(
      join(location.directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'Analysis',
        commands: [{ id: 'analyse', label: 'Analyse readings', type: 'agent' }],
      }),
    );
    const published = await client.callTool({
      name: 'publish_dashboard',
      arguments: { workspaceId, dashboardId: location.dashboard.id },
    });
    expect(published.isError).not.toBe(true);
    const { dashboard } = published.structuredContent as {
      dashboard: { id: string; version: string };
    };
    const route = `/api/workspaces/${workspaceId}/dashboards/${dashboard.id}`;
    const preview = (
      await app.inject({
        method: 'POST',
        url: `${route}/previews`,
        payload: {
          version: dashboard.version,
          commandId: 'analyse',
          input: { reading: { value: 18 } },
          prompt: 'Analyse this reading.',
          destination: {
            kind: 'desktop',
            provider: 'claude-desktop',
            folder: 'D:\\project',
            title: 'Station analysis',
          },
        },
      })
    ).json();
    expect(preview.prompt).toContain('link_dashboard_session');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${route}/runs`,
          payload: { previewId: preview.id },
        })
      ).json().status,
    ).toBe('prepared');
    expect(await app.store.listActivity(workspaceId)).toEqual([]);
    const claim = {
      workspaceId,
      runId: preview.id,
      provider: 'claude-desktop',
      sessionId: 'local_dashboard-test',
    };
    const linked = await client.callTool({ name: 'link_dashboard_session', arguments: claim });
    expect(linked.isError).not.toBe(true);
    expect(linked.structuredContent).toMatchObject({
      run: { status: 'linked', input: { reading: { value: 18 } } },
    });
    const retried = await client.callTool({ name: 'link_dashboard_session', arguments: claim });
    expect(retried.structuredContent).toEqual(linked.structuredContent);
    const activities = await app.store.listActivity(workspaceId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      title: 'Station analysis',
      desktopSession: { provider: 'claude', sessionId: 'local_dashboard-test' },
    });
  });

  it('reports a native Claude desktop session and rejects non-session destinations', async () => {
    const desktopSession = { provider: 'claude' as const, sessionId: 'local_native-chat' };
    const report = update({ source: 'claude', desktopSession });
    const published = await client.callTool({ name: 'publish_activity', arguments: report });
    expect(published.isError).not.toBe(true);
    expect(published.structuredContent).toMatchObject({ activity: { desktopSession } });
    const listed = await app.inject(`/api/workspaces/${workspaceId}/activity`);
    expect(listed.json()[0].desktopSession).toEqual(desktopSession);
    for (const sessionId of ['plain-uuid', 'last', 'local_chat&prompt=hello', 'local_../new']) {
      const invalid = await client.callTool({
        name: 'publish_activity',
        arguments: { ...report, desktopSession: { provider: 'claude', sessionId } },
      });
      expect(invalid.isError).toBe(true);
    }
    expect((await app.store.listActivity(workspaceId))[0].desktopSession).toEqual(desktopSession);
  });

  it('tells the human when a Claude Desktop session reports work without the mod', async () => {
    const desktop = await connect(
      'claude-desktop',
      true,
      'claude-code/2.1.309 (claude-desktop, agent-sdk/0.3.309)',
    );
    const sessionId = 'local_without-mod';
    const report = update({
      source: 'claude-code',
      desktopSession: { provider: 'claude', sessionId },
    });
    const notices = async () =>
      (await app.inject('/api/agent-settings/requests')).json().claudeDesktopNotices;
    const first = await desktop.callTool({ name: 'publish_activity', arguments: report });
    expect(first.isError).not.toBe(true);
    report.workKey = (first.structuredContent as { activity: Activity }).activity.workKey;
    expect(first.structuredContent).toMatchObject({
      activity: {
        workId: expect.stringMatching(/^[a-zA-Z0-9_-]{8}$/),
        workKey: expect.any(String),
      },
      claudeDesktop: { status: 'mod_not_connected' },
    });
    expect(JSON.stringify(first.structuredContent)).toContain('choose Apply');
    expect(await notices()).toMatchObject([{ sessionId, workspaceId, title: report.title }]);

    // Applying the mod configuration answers the notice; the next report raises it again.
    const apply = await app.inject({
      method: 'POST',
      url: '/api/agent-settings/claude-desktop-mod',
      headers: { host: 'localhost:4310', origin: 'http://localhost:4310' },
    });
    expect(apply.statusCode).toBe(200);
    expect(await notices()).toEqual([]);
    await desktop.callTool({ name: 'publish_activity', arguments: report });
    expect(await notices()).toHaveLength(1);

    // Once the session runs the mod, the notice clears and reports carry no warning.
    const registered = await app.inject({
      method: 'POST',
      url: '/api/agents/claude-desktop/register',
      payload: { sessionId, cwd: 'D:\\project' },
    });
    expect(registered.statusCode).toBe(200);
    expect(await notices()).toEqual([]);
    const done = await desktop.callTool({
      name: 'publish_activity',
      arguments: { ...report, status: 'done' },
    });
    expect(done.structuredContent).not.toHaveProperty('claudeDesktop');
    // Reports from other hosts never raise the notice.
    await client.callTool({
      name: 'publish_activity',
      arguments: update({
        source: 'claude-code',
        desktopSession: { provider: 'claude', sessionId: 'local_other' },
      }),
    });
    expect(await notices()).toEqual([]);
  });

  it('refuses the Vienna-chat sequence: a Claude Desktop report without its native desktop session', async () => {
    const desktopSession = { provider: 'claude' as const, sessionId: 'local_vienna-chat' };
    for (const modern of [false, true]) {
      const desktop = await connect(
        'claude-desktop',
        modern,
        'claude-code/2.1.309 (claude-desktop, agent-sdk/0.3.309)',
      );
      const report = update({
        source: 'claude-code',
        sourceUrl: 'https://open-meteo.com/',
      });
      const refused = await desktop.callTool({ name: 'publish_activity', arguments: report });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        code: 'DESKTOP_SESSION_REQUIRED',
        workspaceId,
        environmentVariable: 'CLAUDE_CODE_HOST_SESSION_ID',
      });
      expect(JSON.stringify(refused.content)).toContain('CLAUDE_CODE_HOST_SESSION_ID');
      expect(await app.store.listActivity(workspaceId)).toHaveLength(modern ? 1 : 0);
      const linked = await desktop.callTool({
        name: 'publish_activity',
        arguments: { ...report, desktopSession },
      });
      expect(linked.isError).not.toBe(true);
      report.workKey = (linked.structuredContent as { activity: Activity }).activity.workKey;
      // Later progress may omit the session once the item has one.
      const done = await desktop.callTool({
        name: 'publish_activity',
        arguments: { ...report, status: 'done' },
      });
      expect(done.isError).not.toBe(true);
      expect(done.structuredContent).toMatchObject({
        activity: { status: 'done', desktopSession },
      });
    }
    const cli = await connect('claude-cli', true, 'claude-code/2.1.309 (cli)');
    const cliReport = update({ source: 'claude-code' });
    expect(
      (await cli.callTool({ name: 'publish_activity', arguments: cliReport })).isError,
    ).not.toBe(true);
  });

  it('proposes through MCP but applies only an explicit frontend decision', async () => {
    const original = (await app.inject('/api/agent-settings')).json();
    const input = {
      id: randomUUID(),
      workspaceId,
      host: 'codex-desktop',
      evidence: 'Desktop session context; verified local executable.',
      reason: 'Use the installed Codex executable.',
      changes: { codexCommand: 'C:/Codex/codex.exe' },
    };
    const proposed = await client.callTool({
      name: 'propose_agent_settings',
      arguments: { ...input, workspaceId: (await app.store.getWorkspace(workspaceId)).shortId },
    });
    expect(proposed.isError).not.toBe(true);
    expect(proposed.structuredContent).toMatchObject({
      request: { status: 'pending', changes: input.changes, workspaceId },
    });
    expect((await app.inject('/api/agent-settings')).json()).toEqual(original);
    expect(
      (await client.callTool({ name: 'propose_agent_settings', arguments: input }))
        .structuredContent,
    ).toEqual(proposed.structuredContent);
    expect(
      (await client.callTool({ name: 'get_agent_settings', arguments: {} })).structuredContent,
    ).toMatchObject({ settings: original, requests: [{ id: input.id, status: 'pending' }] });
    const decisionPath = `/api/agent-settings/requests/${input.id}/decision`;
    expect(
      (await app.inject({ method: 'POST', url: decisionPath, payload: { decision: 'approve' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: decisionPath,
          headers: { host: 'localhost:4310', origin: 'http://localhost:5173' },
          payload: { decision: 'approve' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await client.listTools()).tools.some((tool) =>
        /approve|decide|update_agent_settings/.test(tool.name),
      ),
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: decisionPath,
          headers: { host: 'localhost:4310', origin: 'http://localhost:4310' },
          payload: { decision: 'approve' },
        })
      ).json(),
    ).toMatchObject({ status: 'approved' });
    expect(
      (await client.callTool({ name: 'get_agent_settings', arguments: {} })).structuredContent,
    ).toMatchObject({
      settings: { ...original, ...input.changes },
      requests: [{ status: 'approved' }],
    });
    // Claude Code has no connection settings, so no Claude host can propose any.
    for (const overrides of [
      { host: 'unknown' },
      { changes: { invalid: 'value' } },
      { changes: {} },
      { workspaceId: 'missing' },
      { host: 'claude-code-desktop' },
      { host: 'claude-code-cli' },
      { changes: { claudeCommand: 'C:/Claude/claude.exe' } },
      { approved: true },
    ]) {
      expect(
        (
          await client.callTool({
            name: 'propose_agent_settings',
            arguments: { ...input, id: randomUUID(), ...overrides },
          })
        ).isError,
      ).toBe(true);
    }
  });

  it('refuses the Rome-chat sequence when settings were read but no executable proposal was sent', async () => {
    const original = (await app.inject('/api/agent-settings')).json();
    await app.inject({
      method: 'PUT',
      url: '/api/agent-settings',
      payload: { ...original, codexCommand: '' },
    });
    const read = await client.callTool({ name: 'get_agent_settings', arguments: {} });
    expect(read.structuredContent).toMatchObject({
      settings: { codexCommand: '' },
      configuration: { codex: { status: 'proposal_required', setting: 'codexCommand' } },
    });
    const workspaces = await client.callTool({ name: 'list_workspaces', arguments: {} });
    expect(workspaces.structuredContent).toMatchObject({
      configuration: { codex: { status: 'proposal_required' } },
    });
    const report = update({
      title: 'Rome weather report',
      agentTarget: { provider: 'codex-desktop', sessionId: 'desktop-weather-chat' },
    });
    for (const status of ['in_progress', 'done'] as const) {
      const refused = await client.callTool({
        name: 'publish_activity',
        arguments: { ...report, status },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        code: 'CONFIGURATION_REQUIRED',
        nextTool: 'propose_agent_settings',
      });
    }
    expect(await app.store.listActivity(workspaceId)).toEqual([]);
    const proposal = {
      id: randomUUID(),
      workspaceId,
      host: 'codex-desktop',
      sessionId: 'desktop-weather-chat',
      evidence: 'Desktop context and executable lookup.',
      reason: 'Enable Desktop chat discovery.',
      changes: { codexCommand: 'C:/Codex/codex.exe' },
    };
    expect(
      (await client.callTool({ name: 'propose_agent_settings', arguments: proposal })).isError,
    ).not.toBe(true);
    const published = await client.callTool({ name: 'publish_activity', arguments: report });
    expect(published.isError).not.toBe(true);
    expect(published.structuredContent).toMatchObject({
      activity: { workKey: expect.any(String), title: 'Rome weather report' },
      configuration: { codex: { status: 'awaiting_approval', requestId: proposal.id } },
    });
    expect((await app.inject('/api/agent-settings')).json().codexCommand).toBe('');
    expect((await app.inject('/api/agent-settings/requests')).json().requests).toHaveLength(1);
    report.workKey = (published.structuredContent as { activity: Activity }).activity.workKey;
    // An MCP reconnect must retain the pending proposal without requiring a duplicate.
    const reconnected = await connect('reconnected-weather-chat');
    expect(
      (
        await reconnected.callTool({
          name: 'publish_activity',
          arguments: { ...report, status: 'done' },
        })
      ).isError,
    ).not.toBe(true);
    await app.inject({
      method: 'POST',
      url: `/api/agent-settings/requests/${proposal.id}/decision`,
      headers: { host: 'localhost:4310', origin: 'http://localhost:4310' },
      payload: { decision: 'reject' },
    });
    const declined = await client.callTool({
      name: 'publish_activity',
      arguments: { ...report, status: 'done' },
    });
    expect(declined.isError).not.toBe(true);
    expect(declined.structuredContent).toMatchObject({
      configuration: { codex: { status: 'rejected', requestId: proposal.id } },
    });
    expect((await app.inject('/api/agent-settings')).json().codexCommand).toBe('');
  });

  it('does not accept an unrelated or outdated proposal as executable setup, or forget existing targets', async () => {
    const original = (await app.inject('/api/agent-settings')).json();
    const report = update({
      source: 'desktop-agent',
      agentTarget: { provider: 'codex-desktop', sessionId: 'saved-chat' },
    });
    report.workKey = (await app.store.publishActivity(report)).workKey;
    await app.inject({
      method: 'PUT',
      url: '/api/agent-settings',
      payload: { ...original, codexCommand: '' },
    });
    const proposal = {
      id: randomUUID(),
      workspaceId,
      host: 'codex-desktop',
      evidence: 'Desktop context.',
      reason: 'Change shared server URL.',
      changes: { codexUrl: 'ws://localhost:4567' },
    };
    await client.callTool({ name: 'propose_agent_settings', arguments: proposal });
    const withoutTarget = { ...report, agentTarget: undefined, status: 'done' };
    expect(
      (await client.callTool({ name: 'publish_activity', arguments: withoutTarget })).isError,
    ).toBe(true);
    await client.callTool({
      name: 'propose_agent_settings',
      arguments: {
        ...proposal,
        id: randomUUID(),
        changes: { codexCommand: 'C:/Codex/codex.exe', codexUrl: 'ws://localhost:4568' },
      },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/agent-settings',
      payload: { ...original, codexCommand: '', codexUrl: 'ws://localhost:4569' },
    });
    expect(
      (await client.callTool({ name: 'publish_activity', arguments: withoutTarget })).isError,
    ).toBe(true);
    expect(await app.store.listActivity(workspaceId)).toMatchObject([{ status: 'in_progress' }]);
  });

  it('updates one card, makes retries idempotent, and persists the REST-visible result', async () => {
    const started = await client.callTool({ name: 'publish_activity', arguments: update() });
    expect(started.isError).not.toBe(true);
    const original = (started.structuredContent as { activity: Activity }).activity;
    const finished = update({
      workKey: original.workKey,
      status: 'done',
      summary: 'The integration works.',
      sourceUrl: 'https://example.com/result',
    });
    const done = await client.callTool({ name: 'publish_activity', arguments: finished });
    const retry = await client.callTool({ name: 'publish_activity', arguments: finished });
    expect(done.isError).not.toBe(true);
    expect(retry.structuredContent).toEqual(done.structuredContent);
    const saved = (done.structuredContent as { activity: Activity }).activity;
    expect(saved).toMatchObject({ ...finished, id: original.id, createdAt: original.createdAt });

    const listed = await client.callTool({ name: 'list_activity', arguments: { workspaceId } });
    expect(listed.structuredContent).toEqual({ activity: [saved] });
    const untouched = await client.callTool({
      name: 'list_activity',
      arguments: { workspaceId: otherWorkspaceId },
    });
    expect(untouched.structuredContent).toEqual({ activity: [] });
    const rest = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/activity`);
    expect(rest.status).toBe(200);
    expect(await rest.json()).toEqual([saved]);
    const disk = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) as {
      activity: Activity[];
    };
    expect(disk.activity).toEqual([saved]);
  });

  it('links each published item to its reported chat, even for chats in the same workspace', async () => {
    const firstTarget = { provider: 'codex-desktop' as const, sessionId: 'first-chat' };
    const secondTarget = { provider: 'codex-desktop' as const, sessionId: 'second-chat' };
    const first = await client.callTool({
      name: 'publish_activity',
      arguments: update({ agentTarget: firstTarget }),
    });
    const second = await client.callTool({
      name: 'publish_activity',
      arguments: update({ agentTarget: secondTarget }),
    });
    expect(first.structuredContent).toMatchObject({ activity: { agentTarget: firstTarget } });
    expect(second.structuredContent).toMatchObject({ activity: { agentTarget: secondTarget } });
    const progress = await client.callTool({
      name: 'publish_activity',
      arguments: update({
        workKey: (first.structuredContent as { activity: Activity }).activity.workKey,
        status: 'done',
      }),
    });
    expect(progress.structuredContent).toMatchObject({
      activity: { agentTarget: firstTarget, status: 'done' },
    });
    expect((await fetch(`${baseUrl}/api/workspaces/${workspaceId}/activity`)).status).toBe(200);
  });

  it('keeps starts, follow-ups, blockers and completion on one activity with retry-safe history', async () => {
    const workspace = await app.store.getWorkspace(workspaceId);
    expect(workspace.shortId).toMatch(/^[a-z0-9]{8}$/);
    const report = update({
      workspaceId: workspace.shortId,
      requestId: randomUUID(),
      subtitle: 'First task',
      status: 'in_progress',
    });
    const created = await client.callTool({ name: 'publish_activity', arguments: report });
    expect(created.isError).not.toBe(true);
    const original = (created.structuredContent as { activity: Activity }).activity;
    expect(original.workId).toMatch(/^[a-z0-9]{8}$/);
    expect(original.workKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(original.status).toBe('in_progress');
    const transitions: Partial<PublishActivity>[] = [
      { status: 'done', subtitle: 'First task complete', summary: '- The dashboard works.' },
      { status: 'in_progress', subtitle: 'Human follow-up', summary: '- Check offline support.' },
      {
        status: 'blocked',
        subtitle: 'Waiting for access',
        summary:
          '- The test service is unavailable.\n  - Restore access to verify offline support.',
      },
      { status: 'in_progress', subtitle: 'Access restored', summary: '- Verify offline support.' },
      { status: 'done', subtitle: 'Follow-up complete', summary: '- Offline support is verified.' },
    ];
    let latest = created;
    for (const [index, transition] of transitions.entries()) {
      const next = update({
        workspaceId: workspace.shortId,
        workId: original.workId,
        ...transition,
      });
      latest = await client.callTool({ name: 'publish_activity', arguments: next });
      expect(latest.isError).not.toBe(true);
      expect(latest.structuredContent).toMatchObject({
        activity: {
          id: original.id,
          workId: original.workId,
          workKey: original.workKey,
          title: original.title,
          revision: index + 2,
          ...transition,
        },
      });
      const retry = await client.callTool({ name: 'publish_activity', arguments: next });
      expect(retry.structuredContent).toEqual(latest.structuredContent);
    }
    const renamed = await client.callTool({
      name: 'publish_activity',
      arguments: update({ workKey: original.workKey, title: 'Changed title' }),
    });
    expect(renamed.isError).toBe(true);
    const delayedRetry = await client.callTool({
      name: 'publish_activity',
      arguments: { ...report, workspaceId },
    });
    expect(delayedRetry.structuredContent).toEqual(latest.structuredContent);
    const listed = await client.callTool({
      name: 'list_activity',
      arguments: { workspaceId: workspace.shortId },
    });
    expect(listed.structuredContent).toMatchObject({
      activity: [{ id: original.id, revision: 6, status: 'done' }],
    });
    expect(await app.store.listActivity(workspaceId)).toHaveLength(1);
    const versions = await app.store.listActivityVersions(workspaceId, original.id);
    expect(versions.map((version) => version.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(versions.map((version) => version.status)).toEqual([
      'in_progress',
      'done',
      'in_progress',
      'blocked',
      'in_progress',
      'done',
    ]);
  });

  it('rejects malformed input and unknown workspaces without storing activity', async () => {
    for (const input of [
      { ...update(), status: 'finished' },
      { ...update(), title: '   ' },
      { ...update(), sourceUrl: 'javascript:alert(1)' },
      { ...update(), extra: 'not in the contract' },
      { ...update(), agentTarget: { provider: 'codex-desktop', sessionId: '   ' } },
      { ...update(), agentTarget: { provider: 'unknown', sessionId: 'chat' } },
      { ...update(), workspaceId: 'missing-workspace' },
    ]) {
      const result = await client.callTool({ name: 'publish_activity', arguments: input });
      expect(result.isError).toBe(true);
    }
    const missing = await client.callTool({
      name: 'list_activity',
      arguments: { workspaceId: 'missing-workspace' },
    });
    expect(missing.isError).toBe(true);
    expect(await app.store.listActivity(workspaceId)).toEqual([]);
  });

  it('generates distinct identities for concurrent producers and workspaces', async () => {
    const otherClient = await connect('second-producer');
    const calls = await Promise.all([
      client.callTool({ name: 'publish_activity', arguments: update({ source: 'codex' }) }),
      otherClient.callTool({ name: 'publish_activity', arguments: update({ source: 'claude' }) }),
      otherClient.callTool({
        name: 'publish_activity',
        arguments: update({ workspaceId: otherWorkspaceId }),
      }),
    ]);
    expect(calls.every((result) => !result.isError)).toBe(true);
    await client.callTool({
      name: 'publish_activity',
      arguments: update({
        workKey: (calls[0].structuredContent as { activity: Activity }).activity.workKey,
        source: 'codex',
        status: 'done',
      }),
    });
    const first = await app.store.listActivity(workspaceId);
    expect(first).toHaveLength(2);
    expect(first.find((activity) => activity.source === 'codex')?.status).toBe('done');
    expect(first.find((activity) => activity.source === 'claude')?.status).toBe('in_progress');
    expect(await app.store.listActivity(otherWorkspaceId)).toMatchObject([
      { source: 'codex', status: 'in_progress' },
    ]);
  });

  it('also accepts the modern protocol alongside existing harness clients', async () => {
    const modernClient = await connect('modern-client', true);
    expect((await modernClient.listTools()).tools.map((tool) => tool.name)).toContain(
      'publish_activity',
    );
    const published = await modernClient.callTool({
      name: 'publish_activity',
      arguments: update({ status: 'done' }),
    });
    expect(published.isError).not.toBe(true);
    const legacyRead = await client.callTool({ name: 'list_activity', arguments: { workspaceId } });
    expect(legacyRead.structuredContent).toMatchObject({
      activity: [{ workKey: expect.any(String), status: 'done' }],
    });
  });

  it('shuts down with an open modern subscription without waiting for the client', async () => {
    const subscribedClient = await connect('subscribed-client', true);
    await subscribedClient.listen({ toolsListChanged: true });
    await app.close();
    expect(app.server.listening).toBe(false);
  }, 5000);
});
