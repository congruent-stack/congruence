import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';

test('renders grouped Markdown in the selected activity and version previews, keeping the list compact', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-activity-markdown-'));
  const app = await buildApp({
    dataDir,
    mcp: false,
    codexAdapter: new FakeCodex(),
    desktopAdapter: false,
    claudeSettingsPath: join(dataDir, 'claude-settings.json'),
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Markdown activity',
      description: '',
      repositories: [],
    });
    const summary = [
      '# Weather brief',
      '',
      '- Forecast',
      '  - Sunday: **Cloudy** with *light wind*.',
      '  - Monday: Rain; check `radar`.',
      '- Location: [Budapest](https://example.test/weather "Weather source")',
      '',
      '| Day | Conditions |',
      '| --- | --- |',
      '| Sunday | Cloudy |',
      '| Monday | Rain |',
      '',
      '- [x] Check hourly forecast',
      '- [ ] Pack umbrella',
      '',
      '> Conditions may change.',
      '',
      '~~Old warning~~ has cleared.',
      '',
      '```text',
      `station=${'coastal-observation-'.repeat(12)}`,
      '```',
    ].join('\n');
    const before = summary
      .replace('**Cloudy**', '**Sunny**')
      .replace('- [x] Check hourly forecast', '- [ ] Check hourly forecast');
    const report = {
      workspaceId: workspace.id,
      title: 'Plan a dry walking route',
      subtitle: 'Checking the weekend forecast',
      summary: before,
      source: 'markdown-test',
      status: 'in_progress' as const,
    };
    const first = await app.store.publishActivity(report);
    await app.store.publishActivity({ ...report, workId: first.workId, summary });

    await page.goto(url);
    await page.getByLabel('Current workspace').selectOption(workspace.id);
    const row = page.locator('article.activity-item').filter({ hasText: report.title });
    const reader = page.locator('article.activity-reader');
    await expect(row.locator('.activity-main')).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toContainText(report.subtitle);
    await expect(row).not.toContainText('Weather brief');
    await expect(row).not.toContainText('Cloudy');
    await expect(row).not.toContainText('Budapest');
    await expect(
      row.locator('.activity-main a, .activity-main input, .activity-main button'),
    ).toHaveCount(0);
    await page.getByLabel('Search activity').fill('Sunday: Cloudy with light wind');
    await expect(row).toBeVisible();
    await expect(page.locator('article.activity-item')).toHaveCount(1);
    await page.getByLabel('Search activity').fill('');

    await row.locator('.activity-main').click();
    const markdown = reader.locator('.activity-markdown');
    await expect(markdown.getByRole('heading', { name: 'Weather brief' })).toBeVisible();
    const parents = markdown.locator(':scope > ul').first().locator(':scope > li');
    await expect(parents).toHaveCount(2);
    const children = parents.first().locator(':scope > ul > li');
    await expect(children).toHaveCount(2);
    await expect(children.nth(0)).toContainText('Sunday: Cloudy');
    await expect(children.nth(1)).toContainText('Monday: Rain');
    await expect(markdown.locator('strong')).toHaveText('Cloudy');
    await expect(markdown.locator('em')).toHaveText('light wind');
    await expect(markdown.locator('li code')).toHaveText('radar');
    await expect(markdown.locator('blockquote')).toContainText('Conditions may change.');
    await expect(markdown.locator('del')).toHaveText('Old warning');
    await expect(markdown.locator('pre code')).toContainText('station=coastal-observation-');
    const link = markdown.getByRole('link', { name: 'Budapest', exact: true });
    await expect(link).toHaveAttribute('href', 'https://example.test/weather');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
    await expect(markdown.getByRole('table').getByRole('row')).toHaveCount(3);
    await expect(markdown.getByRole('columnheader', { name: 'Conditions' })).toBeVisible();
    const tasks = markdown.getByRole('checkbox');
    await expect(tasks).toHaveCount(2);
    await expect(tasks.nth(0)).toBeChecked();
    await expect(tasks.nth(1)).not.toBeChecked();
    await expect(tasks.nth(0)).toBeDisabled();
    await expect(tasks.nth(1)).toBeDisabled();

    await mkdir(resolve('.local/screenshots'), { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await markdown.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(
          `.local/screenshots/activity-markdown-${width === 390 ? 'mobile' : 'desktop'}.png`,
        ),
        animations: 'disabled',
      });
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await reader.getByRole('button', { name: /Version history/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    const summaryField = dialog.locator('section[aria-label="Summary"]');
    await expect(
      summaryField.locator('.history-line-text').filter({ hasText: '**Cloudy**' }),
    ).toHaveCount(1);
    const render = summaryField.getByRole('checkbox', { name: 'Render Markdown', exact: true });
    await render.check();
    const oldPreview = dialog.getByRole('region', { name: 'Summary before preview', exact: true });
    const newPreview = dialog.getByRole('region', { name: 'Summary after preview', exact: true });
    await expect(oldPreview.locator('strong')).toHaveText('Sunny');
    await expect(newPreview.locator('strong')).toHaveText('Cloudy');
    await expect(oldPreview.getByRole('checkbox').first()).not.toBeChecked();
    await expect(newPreview.getByRole('checkbox').first()).toBeChecked();
    await expect(newPreview.locator('ul ul > li')).toHaveCount(2);
    await expect(summaryField.locator('.history-line-text')).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        await newPreview.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(
          `.local/screenshots/activity-markdown-history-${width === 390 ? 'mobile' : 'desktop'}.png`,
        ),
        animations: 'disabled',
      });
    }
    await render.uncheck();
    await expect(oldPreview).toHaveCount(0);
    await expect(newPreview).toHaveCount(0);
    await expect(
      summaryField.locator('.history-line-text').filter({ hasText: '**Cloudy**' }),
    ).toHaveCount(1);
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Markdown activity summaries keep raw HTML and unsafe URLs inert', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-markdown-safety-'));
  const app = await buildApp({
    dataDir,
    mcp: false,
    codexAdapter: new FakeCodex(),
    desktopAdapter: false,
    claudeSettingsPath: join(dataDir, 'claude-settings.json'),
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Inert Markdown',
      description: '',
      repositories: [],
    });
    await app.store.publishActivity({
      workspaceId: workspace.id,
      title: 'Inspect imported summary',
      summary: [
        'Safe visible content.',
        '',
        '<script>window.__markdownExecuted = 1</script>',
        '<img src="/should-not-load" onerror="window.__markdownExecuted = 1">',
        '<iframe src="/should-not-load"></iframe>',
        '',
        '[JavaScript link](javascript:alert%281%29)',
        '',
        '[Data link](data:text/html,hello)',
        '',
        '[Safe link](https://example.test/safe)',
      ].join('\n'),
      source: 'markdown-test',
      status: 'in_progress',
    });
    const unexpectedRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/should-not-load')) unexpectedRequests.push(request.url());
    });
    await page.addInitScript(() => {
      (window as unknown as { __markdownExecuted: number }).__markdownExecuted = 0;
    });
    await page.goto(url);
    await page.getByLabel('Current workspace').selectOption(workspace.id);
    const row = page
      .locator('article.activity-item')
      .filter({ hasText: 'Inspect imported summary' });
    await expect(row.locator('.activity-main a, .activity-main input')).toHaveCount(0);
    await row.locator('.activity-main').click();
    const markdown = page.locator('article.activity-reader .activity-markdown');
    await expect(markdown).toContainText('Safe visible content.');
    await expect(markdown.getByText('JavaScript link', { exact: true })).toBeVisible();
    await expect(markdown.getByText('Data link', { exact: true })).toBeVisible();
    await expect(markdown.locator('script, img, iframe')).toHaveCount(0);
    await expect(markdown.getByRole('link')).toHaveCount(1);
    await expect(markdown.getByRole('link', { name: 'Safe link' })).toHaveAttribute(
      'href',
      'https://example.test/safe',
    );
    await expect(markdown.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __markdownExecuted: number }).__markdownExecuted,
      ),
    ).toBe(0);
    expect(unexpectedRequests).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
