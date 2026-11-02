import { test, expect } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';

const sessionId = 'local_53ef5087-66b0-464b-bdc2-c371e7445cfe';

test('installs the Congruence mod and messages a Claude Desktop session through it', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-claude-desktop-ui-'));
  const settingsPath = join(directory, 'settings.json');
  const codex = new FakeCodex();
  codex.sessions = [];
  const app = await buildApp({
    dataDir: join(directory, 'data'),
    claudeSettingsPath: settingsPath,
    codexAdapter: codex,
    desktopAdapter: false,
    mcp: false,
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Panda',
      description: '',
      repositories: ['D:\\panda'],
    });
    await app.store.publishActivity({
      workspaceId: workspace.id,
      source: 'claude-code',
      title: 'Vienna weather report',
      summary: 'Done',
      status: 'done',
      desktopSession: { provider: 'claude', sessionId },
    });
    // These requests stand for the mod running in the Claude Desktop session.
    const mod = async (path: string, body: object, token?: string) => {
      const response = await fetch(`${url}/api/agents/claude-desktop/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    await page.goto(url);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Agent settings', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Claude Code Desktop', exact: true }).click();
    const pane = dialog.getByRole('tabpanel', { name: 'Claude Code Desktop', exact: true });
    await expect(pane).toContainText('Not installed · 0 connected sessions');
    const snippet = {
      env: { CLAUDE_CODE_PLUGIN_DIRS: resolve('apps/claude-mod'), CONGRUENCE_URL: url },
    };
    const blocks = pane.locator('.copy-block code');
    await expect(blocks.nth(0)).toHaveText(settingsPath);
    await expect(pane.getByText('Configuration to add or update:', { exact: true })).toBeVisible();
    await expect(blocks.nth(1)).toHaveText(JSON.stringify(snippet, null, 2));
    await expect(
      pane.getByRole('button', { name: 'Copy Claude Code settings configuration', exact: true }),
    ).toBeVisible();
    await pane.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(pane).toContainText('Installed · 0 connected sessions');
    await expect(pane).toContainText('Configuration saved.');
    // The snippet shows exactly what Apply wrote.
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(snippet);

    const { token } = await mod('register', { sessionId, cwd: 'D:\\koala' });
    await pane.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(pane).toContainText('Installed · 1 connected session');
    await dialog.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByRole('button', { name: /Vienna weather report/ }).click();
    await expect(page.getByRole('link', { name: 'Open in Claude' })).toHaveAttribute(
      'href',
      `claude://code/continue?session=${sessionId}`,
    );
    await page.getByRole('button', { name: 'Message agent', exact: true }).click();
    await expect(dialog.getByRole('group', { name: 'Linked agent session' })).toContainText(
      'Claude Code Desktop · koala · 53ef5087',
    );
    await expect(dialog.getByRole('link', { name: 'Open session in Claude' })).toHaveAttribute(
      'href',
      `claude://code/continue?session=${sessionId}`,
    );
    await expect(dialog).not.toContainText('Offline.');
    await dialog.getByLabel('Message', { exact: true }).fill('Is tomorrow drier?');
    await dialog.getByRole('button', { name: 'Send to Claude Code Desktop', exact: true }).click();
    await expect(dialog.getByText('Sending', { exact: true })).toBeVisible();

    const { messages } = await mod(`${sessionId}/poll`, {}, token);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('Is tomorrow drier?');
    await expect(dialog.getByText('Queued', { exact: true })).toBeVisible();
    await mod(`${sessionId}/receipts`, { messageId: messages[0].id, outcome: 'started' }, token);
    await expect(dialog.getByText('Accepted', { exact: true })).toBeVisible();
    await mod(
      `${sessionId}/receipts`,
      { messageId: messages[0].id, outcome: 'replied', reply: 'Yes. Monday stays dry.' },
      token,
    );
    await expect(dialog.getByText('Yes. Monday stays dry.')).toBeVisible();
    await expect(dialog.getByText('Replied', { exact: true })).toBeVisible();
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/claude-desktop-messages.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();

    // The card keeps its Claude Desktop link after messaging.
    await expect(page.getByRole('link', { name: 'Open in Claude' })).toHaveAttribute(
      'href',
      `claude://code/continue?session=${sessionId}`,
    );
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await dialog.getByRole('button', { name: 'Agent settings', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Claude Code Desktop', exact: true }).click();
    await pane.getByRole('button', { name: 'Remove from config file', exact: true }).click();
    await expect(pane).toContainText('Configuration removed');
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({});
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shows Claude Desktop sessions without the mod on the Claude tab', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-claude-attention-ui-'));
  const codex = new FakeCodex();
  codex.sessions = [];
  const app = await buildApp({
    dataDir: join(directory, 'data'),
    claudeSettingsPath: join(directory, 'settings.json'),
    codexAdapter: codex,
    desktopAdapter: false,
  });
  const client = new Client({ name: 'claude-desktop', version: '1.0.0' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Panda',
      description: '',
      repositories: [],
    });
    // The agent runs in Claude Desktop, which names itself in the User-Agent.
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', url), {
        requestInit: {
          headers: { 'User-Agent': 'claude-code/2.1.309 (claude-desktop, agent-sdk/0.3.309)' },
        },
      }),
    );
    const report = {
      workspaceId: workspace.id,
      source: 'claude-code',
      requestId: randomUUID(),
      title: 'Vienna weather report',
      summary: 'Fetching the forecast.',
      status: 'in_progress',
      desktopSession: { provider: 'claude', sessionId },
    };
    const published = await client.callTool({ name: 'publish_activity', arguments: report });
    expect(published.structuredContent).toMatchObject({
      claudeDesktop: { status: 'mod_not_connected' },
    });
    // Claude Code has no connection settings, so a Claude host cannot propose any.
    const proposal = {
      id: randomUUID(),
      workspaceId: workspace.id,
      host: 'claude-code-desktop',
      sessionId,
      evidence: 'CLAUDE_CODE_ENTRYPOINT is claude-desktop; the CLI was found at this path.',
      reason: 'Use the installed Claude Code CLI in the setup commands.',
      changes: { claudeCommand: 'C:/Tools/Claude/claude.exe' },
    };
    expect(
      (await client.callTool({ name: 'propose_agent_settings', arguments: proposal })).isError,
    ).toBe(true);

    await page.goto(url);
    const agentsButton = page.getByRole('button', { name: 'Agents', exact: true });
    await expect(agentsButton).toHaveText('Agents1');
    await expect(agentsButton).toHaveAccessibleDescription(
      '1 Claude Desktop session needs the Congruence mod',
    );
    await agentsButton.click();
    const dialog = page.getByRole('dialog');
    // The dialog opens where the attention is: Agent settings, on the Claude tab.
    await expect(
      dialog.getByRole('button', { name: 'Agent settings', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    const claudeTab = dialog.getByRole('tab', { name: /Claude Code Desktop/ });
    await expect(claudeTab).toHaveAttribute('aria-selected', 'true');
    const pane = dialog.getByRole('tabpanel', { name: 'Claude Code Desktop', exact: true });
    // Only Codex has settings requests, so the Claude tab shows the mod setup alone.
    await expect(pane.getByText('Past requests')).toHaveCount(0);
    await expect(pane.getByRole('region', { name: 'Needs approval' })).toHaveCount(0);
    // A session without the mod highlights Apply in place of a separate card.
    const apply = pane.getByRole('button', { name: 'Apply', exact: true });
    // Apply takes the badge's orange.
    await expect(apply).toHaveClass(/button-attention/);
    await expect(apply).toHaveCSS('background-color', 'rgb(226, 189, 141)');
    await expect(pane.getByRole('region', { name: 'Needs attention' })).toHaveCount(0);
    await apply.scrollIntoViewIfNeeded();
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/claude-desktop-attention.png'),
      fullPage: true,
    });

    // Apply answers the notice: the badge clears and Apply returns to its normal look.
    await apply.click();
    await expect(pane).toContainText('Configuration saved.');
    await expect(agentsButton).toHaveText('Agents');
    await expect(apply).not.toHaveClass(/button-attention/);

    // A new report raises it again live; the session's mod connecting clears it.
    await client.callTool({ name: 'publish_activity', arguments: report });
    await expect(apply).toHaveClass(/button-attention/);
    await expect(agentsButton).toHaveText('Agents1');
    const registered = await fetch(`${url}/api/agents/claude-desktop/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd: 'D:\\koala' }),
    });
    expect(registered.status).toBe(200);
    await expect(apply).not.toHaveClass(/button-attention/);
    await expect(agentsButton).toHaveText('Agents');
    await expect(pane).toContainText('Installed · 1 connected session');
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    await page.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
