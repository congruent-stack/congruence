import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';
import { FakeDesktop } from '../helpers/fake-desktop.js';

test('uses the reported Desktop chat automatically and polls its reply without an SSE notification', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-desktop-ui-'));
  const desktop = new FakeDesktop();
  desktop.sessions.unshift({
    ...desktop.sessions[0],
    sessionId: 'other-chat',
    name: 'Another chat in the same repository',
  });
  const codex = new FakeCodex();
  codex.sessions = [];
  const app = await buildApp({ dataDir, codexAdapter: codex, desktopAdapter: desktop, mcp: false });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Desktop messages',
      description: '',
      repositories: ['D:/test-project'],
    });
    const report = {
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Desktop delivery test',
      summary: 'Ready',
      status: 'in_progress' as const,
      agentTarget: { provider: 'codex-desktop' as const, sessionId: 'desktop-chat' },
    };
    const item = await app.store.publishActivity(report);
    await page.goto(url);
    await page.getByRole('button', { name: /Desktop delivery test/ }).click();
    await page.getByRole('button', { name: 'Message agent', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('group', { name: 'Linked agent session' })).toContainText(
      'Codex Desktop · Existing Desktop chat',
    );
    await expect(dialog.getByLabel('Agent session', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('link', { name: 'Open chat in Desktop' })).toHaveAttribute(
      'href',
      'codex://threads/desktop-chat',
    );
    await dialog.getByLabel('Message', { exact: true }).fill('Please continue the same work item.');
    await dialog.getByRole('button', { name: 'Send to Codex Desktop', exact: true }).click();
    await expect(dialog.getByText('Queued', { exact: true })).toBeVisible();
    expect(desktop.sent).toHaveLength(1);
    expect(desktop.sent[0].sessionId).toBe('desktop-chat');
    expect(desktop.sent[0].repositories).toEqual(['D:/test-project']);
    const [message] = await app.store.listAgentMessages(workspace.id, item.id);
    desktop.receipts.set(message.id, {
      status: 'accepted',
      turnId: 'desktop-turn',
      detail: 'Received in Desktop',
    });
    await expect(dialog.getByText('Accepted', { exact: true })).toBeVisible();
    desktop.receipts.set(message.id, {
      status: 'replied',
      turnId: 'desktop-turn',
      detail: 'Reply received',
      reply: 'The existing chat received your instruction.',
    });
    await expect(dialog.getByText('The existing chat received your instruction.')).toBeVisible();
    await expect(dialog.getByText('Replied', { exact: true })).toBeVisible();
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/codex-desktop-messages.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve('.local/screenshots/codex-desktop-messages-mobile.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await app.store.publishActivity({
      ...report,
      workKey: item.workKey,
      status: 'blocked',
      summary: 'Awaiting review',
    });
    await page.reload();
    await page.getByRole('button', { name: /Desktop delivery test/ }).click();
    await page.getByRole('button', { name: 'Message agent', exact: true }).click();
    await expect(dialog.getByRole('group', { name: 'Linked agent session' })).toContainText(
      'Codex Desktop · Existing Desktop chat',
    );
    await expect(dialog.getByText('The existing chat received your instruction.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    desktop.sessions = desktop.sessions.filter((session) => session.sessionId !== 'desktop-chat');
    await page.getByRole('button', { name: 'Message agent', exact: true }).click();
    await expect(dialog.getByText('Linked chat unavailable', { exact: true })).toBeVisible();
    await dialog
      .getByLabel('Message', { exact: true })
      .fill('Do not deliver to a different chat automatically.');
    await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(dialog.getByLabel('Agent session')).toHaveValue('codex-desktop:desktop-chat');
    await dialog.getByLabel('Agent session').selectOption('codex-desktop:other-chat');
    await expect(dialog.getByRole('group', { name: 'Linked agent session' })).toContainText(
      'Another chat in the same repository',
    );
    expect(desktop.sent).toHaveLength(1);
    expect(codex.sent).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('messages an existing agent, displays replies and approvals, and keeps the selected session', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-message-ui-'));
  const codex = new FakeCodex();
  const connectedSessions = codex.sessions;
  codex.sessions = [];
  const app = await buildApp({ dataDir, codexAdapter: codex, desktopAdapter: false, mcp: false });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Agent conversations',
      description: 'Follow up on work without losing its context.',
      repositories: [],
    });
    const report = {
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Review the workspace changes',
      summary: 'Ready for your next instruction.',
      status: 'in_progress' as const,
    };
    const item = await app.store.publishActivity(report);
    await page.goto(url);
    await page.getByRole('button', { name: /Review the workspace changes/ }).click();
    await page.getByRole('button', { name: 'Message agent', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('No agent sessions found', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Agent session')).toBeDisabled();
    await expect(
      dialog.getByText(/Open a Codex Desktop chat in one of this workspace/),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    codex.sessions = connectedSessions;
    await dialog.getByRole('button', { name: 'Refresh sessions' }).click();
    await expect(dialog.getByRole('option', { name: /Integration session/ })).toBeAttached();
    await dialog.getByLabel('Agent session').selectOption('codex:test-codex');
    await dialog
      .getByLabel('Message', { exact: true })
      .fill('Please run the tests before finishing.');
    await dialog.getByRole('button', { name: 'Send to Codex', exact: true }).click();
    await expect(dialog.getByText('Accepted', { exact: true })).toBeVisible();
    expect(codex.sent).toHaveLength(1);
    codex.onRequest(17, 'item/commandExecution/requestApproval', {
      threadId: 'test-codex',
      command: 'pnpm test',
    });
    await expect(dialog.getByText('Codex needs approval')).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve once' }).click();
    await expect.poll(() => codex.answered.length).toBe(1);
    codex.onNotification('item/completed', {
      threadId: 'test-codex',
      turnId: 'test-turn',
      item: {
        type: 'agentMessage',
        phase: 'final_answer',
        text: 'All tests passed. The changes are ready for review.',
      },
    });
    await expect(
      dialog.getByText('All tests passed. The changes are ready for review.'),
    ).toBeVisible();
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/agent-messages-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole('heading', { name: 'Message agent' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve('.local/screenshots/agent-messages-mobile.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await app.store.publishActivity({
      ...report,
      workKey: item.workKey,
      summary: 'Tests passed.',
      status: 'done',
    });
    await page.reload();
    await page.getByRole('button', { name: /Review the workspace changes/ }).click();
    await page.getByRole('button', { name: 'Message agent', exact: true }).click();
    await expect(dialog.getByRole('group', { name: 'Linked agent session' })).toContainText(
      'Codex · Integration session',
    );
    await expect(
      dialog.getByText('All tests passed. The changes are ready for review.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Agents' }).click();
    await expect(dialog.getByRole('tab', { name: 'Codex Desktop', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await dialog.getByRole('tab', { name: 'Manual setup', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Copy MCP endpoint' })).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    await dialog.getByRole('button', { name: 'Copy MCP endpoint' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url + '/mcp');
    await expect(dialog.locator('code').filter({ hasText: '--remote' })).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Codex CLI', exact: true })).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Claude Code Desktop', exact: true }).click();
    await expect(dialog.getByRole('tab', { name: 'Manual setup', exact: true })).toHaveCount(0);
    await expect(dialog.locator('code').filter({ hasText: 'mcpServers' })).toBeVisible();
    await expect(
      dialog.locator('code').filter({ hasText: '--dangerously-load-development-channels' }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
