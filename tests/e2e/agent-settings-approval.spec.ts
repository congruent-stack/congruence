import { test, expect } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';
import { FakeDesktop } from '../helpers/fake-desktop.js';

test('reviews live proposals and manages past requests only through explicit frontend actions', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-review-'));
  const desktop = new FakeDesktop();
  let resets = 0;
  desktop.close = () => {
    resets++;
  };
  const app = await buildApp({
    dataDir,
    claudeSettingsPath: join(dataDir, 'claude-settings.json'),
    codexAdapter: new FakeCodex(),
    desktopAdapter: desktop,
  });
  const client = new Client({ name: 'settings-test', version: '1.0.0' });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Example project',
      description: '',
      repositories: [],
    });
    const original = { ...(await app.inject('/api/agent-settings')).json(), codexCommand: '' };
    await app.inject({ method: 'PUT', url: '/api/agent-settings', payload: original });
    resets = 0;
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url)));
    await page.goto(url);
    const agentsButton = page.getByRole('button', { name: 'Agents', exact: true });
    await expect(agentsButton).toHaveCount(1);
    await expect(agentsButton).toHaveText('Agents');
    await expect(
      page.getByRole('banner').getByRole('button', { name: /settings|agent/i }),
    ).toHaveCount(0);
    // Reproduce an agent that read settings but skipped its proposal before reporting progress.
    await client.callTool({ name: 'get_agent_settings', arguments: {} });
    await client.callTool({ name: 'list_workspaces', arguments: {} });
    const report = {
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Weather task',
      summary: 'Getting the forecast.',
      status: 'in_progress',
      agentTarget: { provider: 'codex-desktop', sessionId: 'example-chat' },
    };
    const refused = await client.callTool({ name: 'publish_activity', arguments: report });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: 'CONFIGURATION_REQUIRED' });
    const input = {
      id: randomUUID(),
      workspaceId: workspace.id,
      host: 'codex-desktop',
      sessionId: 'example-chat',
      evidence:
        'The session explicitly identifies Codex Desktop. Local executable lookup returned the proposed path.',
      reason: 'Use the installed Codex executable to discover this workspace’s chats.',
      changes: { codexCommand: 'C:/Applications/Codex/codex.exe' },
    };
    expect(
      (await client.callTool({ name: 'propose_agent_settings', arguments: input })).isError,
    ).not.toBe(true);
    const progress = await client.callTool({ name: 'publish_activity', arguments: report });
    expect(progress.isError).not.toBe(true);
    expect(progress.structuredContent).toMatchObject({
      configuration: { codex: { status: 'awaiting_approval' } },
    });
    await expect(agentsButton).toHaveAccessibleDescription('1 connection change needs approval');
    await expect(agentsButton).toHaveText('Agents1');
    await agentsButton.click();
    const dialog = page.getByRole('dialog');
    const navigation = dialog.getByRole('navigation', { name: 'Agent sections' });
    const settingsButton = navigation.getByRole('button', {
      name: 'Agent settings',
      exact: true,
    });
    await expect(dialog).toHaveCount(1);
    await expect(navigation.getByRole('button')).toHaveCount(2);
    await expect(navigation.getByRole('button', { name: 'Past requests' })).toHaveCount(0);
    await expect(settingsButton).toHaveAttribute('aria-current', 'page');
    await expect(settingsButton).toHaveAccessibleDescription('1 pending request');
    await expect(dialog.getByRole('region', { name: 'Needs approval', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy MCP endpoint' })).toBeHidden();
    await expect(dialog).toContainText(input.changes.codexCommand);
    await expect(dialog).toContainText('Not set');
    await dialog.getByText('Details', { exact: true }).click();
    await expect(dialog).toContainText(input.evidence);
    expect((await app.inject('/api/agent-settings')).json()).toEqual(original);
    expect(resets).toBe(0);
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/agent-settings-review.png'),
      fullPage: true,
    });
    await dialog.getByText('Details', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve('.local/screenshots/agents-approval-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The browser test simulates a human decision against this disposable fixture only.
    await dialog.getByRole('button', { name: 'Approve and apply', exact: true }).click();
    await expect(
      dialog.getByText('Approved. Connection settings have been applied.', { exact: true }),
    ).toBeVisible();
    expect((await app.inject('/api/agent-settings')).json()).toEqual({
      ...original,
      ...input.changes,
    });
    expect(resets).toBe(1);
    await expect(agentsButton).toHaveText('Agents');
    await expect(dialog.getByRole('region', { name: 'Needs approval', exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.getByText('Approved', { exact: true })).toBeHidden();
    await expect(dialog.getByLabel('Codex executable', { exact: true })).toHaveValue(
      input.changes.codexCommand,
    );
    expect(
      (await client.callTool({ name: 'get_agent_settings', arguments: {} })).structuredContent,
    ).toMatchObject({ requests: [{ id: input.id, status: 'approved' }] });
    await page.reload();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await expect(dialog.getByText('Approved', { exact: true })).toBeHidden();
    await settingsButton.click();
    const history = dialog.locator('details.settings-history');
    await expect(history).toHaveJSProperty('open', false);
    await history.locator(':scope > summary').click();
    await expect(dialog.getByText('Approved', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Rejected', { exact: true })).toBeHidden();
    await expect(history.getByRole('button', { name: 'In use', exact: true })).toBeDisabled();
    await dialog
      .getByLabel('Codex executable', { exact: true })
      .fill('C:/Applications/Codex/newer.exe');
    await dialog.getByRole('button', { name: 'Save and test' }).click();
    await expect(history).toContainText('C:/Applications/Codex/newer.exe');
    await expect(history.getByRole('button', { name: 'Reapply', exact: true })).toBeEnabled();
    await history.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await dialog.screenshot({ path: resolve('.local/screenshots/agents-past-requests.png') });
    await history.getByRole('button', { name: 'Reapply', exact: true }).click();
    await expect(history.getByText('Reapplied', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Codex executable', { exact: true })).toHaveValue(
      input.changes.codexCommand,
    );
    const afterReapply = resets;
    expect(afterReapply).toBe(3);
    const savedReview = (await app.inject('/api/agent-settings/requests')).json();
    expect(savedReview.requests.find((entry: { id: string }) => entry.id === input.id).status).toBe(
      'approved',
    );
    expect(
      savedReview.requests.find(
        (entry: { reappliedFrom?: string }) => entry.reappliedFrom === input.id,
      ),
    ).toMatchObject({ status: 'approved', changes: input.changes });
    const originalCard = history
      .getByRole('region')
      .filter({ has: page.getByText('Approved', { exact: true }) });
    await originalCard.getByRole('button', { name: 'Delete', exact: true }).click();
    await originalCard.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await app.inject('/api/agent-settings/requests')).json().requests).toHaveLength(2);
    await originalCard.getByRole('button', { name: 'Delete', exact: true }).click();
    await originalCard.getByRole('button', { name: 'Delete request', exact: true }).click();
    await expect(originalCard).toHaveCount(0);
    await history.getByRole('button', { name: 'Delete', exact: true }).click();
    await history.getByRole('button', { name: 'Delete request', exact: true }).click();
    await expect(history.getByText('No past requests', { exact: true })).toBeVisible();
    expect((await app.inject('/api/agent-settings')).json().codexCommand).toBe(
      input.changes.codexCommand,
    );
    expect(resets).toBe(afterReapply);
    await dialog.getByRole('tab', { name: 'Claude Code Desktop', exact: true }).click();
    await expect(
      dialog.getByRole('tabpanel', { name: 'Claude Code Desktop', exact: true }),
    ).toContainText('Not installed · 0 connected sessions');
    expect((await app.inject('/api/agent-settings/requests')).json().requests).toHaveLength(0);
  } finally {
    await client.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
