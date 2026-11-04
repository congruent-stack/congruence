import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';

async function expectHistoryLayout(
  dialog: Locator,
  viewport: { width: number; height: number },
  maxChromeHeight?: number,
) {
  const layout = await dialog.evaluate((element) => {
    const dialogBounds = element.getBoundingClientRect();
    const firstField = element.querySelector('.history-field')?.getBoundingClientRect();
    return {
      width: dialogBounds.width,
      height: dialogBounds.height,
      top: dialogBounds.y,
      chromeHeight: firstField ? firstField.y - dialogBounds.y + element.scrollTop : null,
    };
  });
  expect(Math.abs(layout.width - viewport.width * 0.8)).toBeLessThan(1);
  expect(Math.abs(layout.height - (viewport.height - 40))).toBeLessThan(1);
  expect(Math.abs(layout.top - 20)).toBeLessThan(1);
  if (maxChromeHeight !== undefined) {
    expect(layout.chromeHeight).not.toBeNull();
    expect(layout.chromeHeight!).toBeLessThan(maxChromeHeight);
  }
}

async function dragVersionPin(
  page: Page,
  dialog: Locator,
  label: 'From version' | 'To version',
  revision: number,
) {
  const slider = dialog.getByRole('slider', { name: label, exact: true });
  const node = dialog.getByRole('button', { name: `Version ${revision}`, exact: true });
  await slider.scrollIntoViewIfNeeded();
  const origin = await slider.boundingBox();
  const destination = await node.boundingBox();
  if (!origin || !destination) throw new Error('The version pin and node must be visible.');
  const y = origin.y + origin.height / 2;
  await page.mouse.move(origin.x + origin.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 2, y, { steps: 8 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', String(revision));
}

test('activity keeps its title and compares saved versions on desktop and mobile', async ({
  page,
  request,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-activity-history-'));
  const app = await buildApp({
    dataDir,
    desktopAdapter: false,
    claudeSettingsPath: join(dataDir, 'claude-settings.json'),
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspaceResponse = await request.post(`${url}/api/workspaces`, {
      data: { name: 'Activity history', description: '', repositories: [] },
    });
    expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json();
    expect(workspace.shortId).toMatch(/^[a-z0-9]{8}$/);
    const report = {
      workspaceId: workspace.id,
      title: 'Improve offline maps',
      subtitle: 'Preparing the map cache',
      summary: 'Maps are downloading. Search needs a connection.',
      source: 'history-test',
      status: 'in_progress',
    };
    const firstResponse = await request.post(`${url}/api/activity`, { data: report });
    expect(firstResponse.ok()).toBe(true);
    const first = await firstResponse.json();
    expect(first.workId).toMatch(/^[a-z0-9]{8}$/);
    expect(first.workKey).toMatch(/^[0-9a-f-]{36}$/i);
    const secondResponse = await request.post(`${url}/api/activity`, {
      data: {
        ...report,
        workId: first.workId,
        subtitle: 'Checking offline search',
        summary: 'Maps are cached. Search needs a connection.',
      },
    });
    expect(secondResponse.ok()).toBe(true);
    const latestResponse = await request.post(`${url}/api/activity`, {
      data: {
        ...report,
        workId: first.workId,
        subtitle: 'Ready for offline trips',
        summary: 'Maps are cached. Search works offline.',
        status: 'done',
      },
    });
    expect(latestResponse.ok()).toBe(true);
    const latest = await latestResponse.json();
    expect(latest.title).toBe(report.title);
    expect(latest.revision).toBe(3);
    const renamed = await request.post(`${url}/api/activity`, {
      data: { ...report, workId: first.workId, title: 'A different title' },
    });
    expect(renamed.ok()).toBe(false);

    await page.goto(url);
    await page.getByRole('button', { name: /^Workspace:/ }).click();
    await expect(page.locator('.workspace-id')).toHaveText(`Workspace ID ${workspace.shortId}`);
    await page.keyboard.press('Escape');
    const row = page.locator('article.activity-item').filter({ hasText: report.title });
    const reader = page.locator('article.activity-reader');
    await expect(row.getByText('Ready for offline trips', { exact: true })).toBeVisible();
    await expect(
      reader.getByText('Maps are cached. Search works offline.', { exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByText('Maps are downloading. Search needs a connection.', { exact: true }),
    ).toHaveCount(0);
    await page.getByLabel('Search activity').fill(first.workId);
    await expect(page.locator('article.activity-item')).toHaveCount(1);
    await page.getByLabel('Search activity').fill('Ready for offline trips');
    await expect(page.locator('article.activity-item')).toHaveCount(1);
    await page.getByLabel('Search activity').fill('');
    await row.locator('.activity-main').click();
    await expect(reader.locator('.activity-detail-footer').getByText(first.workId)).toBeVisible();
    await expect(reader.locator('.activity-detail-footer')).not.toContainText(first.workKey);
    await expect(reader.getByText('Work Key', { exact: false })).toHaveCount(0);
    await reader.getByRole('button', { name: /Version history/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    await expect(dialog).toBeVisible();
    const from = dialog.getByRole('slider', { name: 'From version', exact: true });
    const to = dialog.getByRole('slider', { name: 'To version', exact: true });
    await expect(from).toHaveAttribute('aria-valuenow', '2');
    await expect(to).toHaveAttribute('aria-valuenow', '3');
    await expectHistoryLayout(dialog, page.viewportSize()!, 250);
    const trackBounds = await dialog.locator('.history-timeline-track').boundingBox();
    const dialogBounds = await dialog.boundingBox();
    if (!trackBounds || !dialogBounds) throw new Error('The version timeline must be visible.');
    expect(trackBounds.width).toBeLessThan(dialogBounds.width / 3);
    const nodes = await dialog.locator('.history-timeline-node').evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.x + bounds.width / 2;
      }),
    );
    expect(nodes[1] - nodes[0]).toBeGreaterThanOrEqual(44);
    expect(nodes[1] - nodes[0]).toBeLessThanOrEqual(72);
    expect(nodes[2] - nodes[1]).toBeCloseTo(nodes[1] - nodes[0], 1);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(from).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(to).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Show unchanged')).toBeFocused();
    await expect(dialog.getByRole('status')).toHaveText('3 fields changed');
    await expect(
      dialog.locator('[aria-label="Summary before line 1"] .history-line-text'),
    ).toHaveText('Maps are cached. Search needs a connection.');
    const addedText = dialog.locator('[aria-label="Summary after line 1"] ins').first();
    await expect(addedText).toContainText('works');
    await expect(addedText).toHaveCSS('text-decoration-line', 'none');
    expect(
      await addedText.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe('rgba(0, 0, 0, 0)');
    const removedText = dialog.locator('[aria-label="Summary before line 1"] del').first();
    await expect(removedText).toHaveCSS('text-decoration-line', 'none');
    expect(
      await removedText.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe('rgba(0, 0, 0, 0)');
    await dragVersionPin(page, dialog, 'From version', 1);
    await expect(
      dialog.locator('[aria-label="Summary before line 1"] .history-line-text'),
    ).toHaveText(report.summary);
    await dragVersionPin(page, dialog, 'To version', 2);
    await expect(dialog.getByRole('status')).toHaveText('2 fields changed');
    await expectHistoryLayout(dialog, page.viewportSize()!);
    await dialog.getByLabel('Show unchanged').check();
    await expect(dialog.getByRole('heading', { name: /Status\s*Unchanged/ })).toBeVisible();
    await expectHistoryLayout(dialog, page.viewportSize()!);
    await dialog.getByLabel('Show unchanged').uncheck();
    await to.press('End');
    await expect(to).toHaveAttribute('aria-valuenow', '3');
    // Both pins can select the same node and remain independently keyboard-accessible.
    await from.press('End');
    await expect(from).toHaveAttribute('aria-valuenow', '3');
    await expect(dialog.getByRole('status')).toHaveText('0 fields changed');
    await expect(dialog.getByText('These versions have the same content.')).toBeVisible();
    await expectHistoryLayout(dialog, page.viewportSize()!);
    await dragVersionPin(page, dialog, 'From version', 2);
    await to.press('Home');
    await expect(to).toHaveAttribute('aria-valuenow', '2');
    await to.press('ArrowLeft');
    await expect(to).toHaveAttribute('aria-valuenow', '2');
    await from.press('Home');
    await to.press('End');
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/activity-history-desktop.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectHistoryLayout(dialog, page.viewportSize()!, 300);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expect(from).toBeVisible();
    await dragVersionPin(page, dialog, 'To version', 2);
    await expect(dialog.getByRole('status')).toHaveText('2 fields changed');
    await to.press('End');
    await page.screenshot({
      path: resolve('.local/screenshots/activity-history-mobile.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reader.getByRole('button', { name: /Version history/ })).toBeFocused();

    // A failed history request is recoverable without discarding the current report.
    await page.route(`**/api/workspaces/${workspace.id}/activity/${first.id}/versions`, (route) =>
      route.abort(),
    );
    await reader.getByRole('button', { name: /Version history/ }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expectHistoryLayout(dialog, page.viewportSize()!);
    await page.unroute(`**/api/workspaces/${workspace.id}/activity/${first.id}/versions`);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(to).toHaveAttribute('aria-valuenow', '3');
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a long version timeline scrolls and preserves the selected comparison after live updates', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-history-timeline-'));
  const app = await buildApp({
    dataDir,
    mcp: false,
    desktopAdapter: false,
    claudeSettingsPath: join(dataDir, 'claude-settings.json'),
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Long activity history',
      description: '',
      repositories: [],
    });
    const report = {
      workspaceId: workspace.id,
      title: 'Long-running map work',
      subtitle: 'Revision 1',
      summary: 'Reviewing cached maps.',
      source: 'timeline-test',
      status: 'in_progress' as const,
    };
    const first = await app.store.publishActivity(report);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    const row = page.locator('article.activity-item').filter({ hasText: report.title });
    await row.locator('.activity-main').click();
    await page
      .locator('article.activity-reader')
      .getByRole('button', { name: /Version history/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    const from = dialog.getByRole('slider', { name: 'From version', exact: true });
    const to = dialog.getByRole('slider', { name: 'To version', exact: true });
    const scroll = dialog.locator('.history-timeline-scroll');
    await expect(dialog.getByText('No earlier versions yet.', { exact: false })).toBeVisible();
    await expectHistoryLayout(dialog, page.viewportSize()!);
    await app.store.publishActivity({ ...report, workId: first.workId, subtitle: 'Revision 2' });
    await expect(from).toHaveAttribute('aria-valuenow', '1');
    await expect(to).toHaveAttribute('aria-valuenow', '2');
    for (let revision = 3; revision <= 18; revision++)
      await app.store.publishActivity({
        ...report,
        workId: first.workId,
        subtitle: `Revision ${revision}`,
      });
    await expect(dialog.getByRole('button', { name: 'Version 18', exact: true })).toHaveCount(1);
    await expect(from).toHaveAttribute('aria-valuenow', '1');
    await expect(to).toHaveAttribute('aria-valuenow', '2');
    await to.press('End');
    await from.press('End');
    await from.press('ArrowLeft');
    await expect(from).toHaveAttribute('aria-valuenow', '17');
    await expect(to).toHaveAttribute('aria-valuenow', '18');
    await dialog.getByRole('button', { name: 'Version 16', exact: true }).click();
    await expect(from).toHaveAttribute('aria-valuenow', '16');
    await expect(to).toHaveAttribute('aria-valuenow', '18');
    expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await scroll.hover();
    await page.mouse.wheel(-2000, 0);
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
    await page.mouse.wheel(400, 0);
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    // Holding a pin at the rail edge keeps moving through offscreen versions.
    await from.press('Home');
    await to.press('End');
    await from.scrollIntoViewIfNeeded();
    const pinBounds = await from.boundingBox();
    const railBounds = await scroll.boundingBox();
    if (!pinBounds || !railBounds) throw new Error('The version timeline must be visible.');
    const pinY = pinBounds.y + pinBounds.height / 2;
    await page.mouse.move(pinBounds.x + pinBounds.width / 2, pinY);
    await page.mouse.down();
    try {
      await page.mouse.move(railBounds.x + railBounds.width - 8, pinY, { steps: 8 });
      await expect
        .poll(async () => Number(await from.getAttribute('aria-valuenow')))
        .toBeGreaterThan(6);
    } finally {
      await page.mouse.up();
    }

    await from.press('Home');
    for (let step = 0; step < 3; step++) await from.press('ArrowRight');
    await to.press('Home');
    for (let step = 0; step < 8; step++) await to.press('ArrowRight');
    await expect(from).toHaveAttribute('aria-valuenow', '4');
    await expect(to).toHaveAttribute('aria-valuenow', '12');
    await expect(
      dialog.locator('[aria-label="Subtitle before line 1"] .history-line-text'),
    ).toHaveText('Revision 4');
    await expect(
      dialog.locator('[aria-label="Subtitle after line 1"] .history-line-text'),
    ).toHaveText('Revision 12');

    await expect(to).toBeFocused();
    await app.store.publishActivity({
      ...report,
      workId: first.workId,
      subtitle: 'Revision 19',
    });
    await expect(dialog.getByRole('button', { name: 'Version 19', exact: true })).toHaveCount(1);
    await expect(from).toHaveAttribute('aria-valuenow', '4');
    await expect(to).toHaveAttribute('aria-valuenow', '12');
    await expect(to).toBeFocused();
    await expect(
      dialog.locator('[aria-label="Subtitle before line 1"] .history-line-text'),
    ).toHaveText('Revision 4');
    await expect(
      dialog.locator('[aria-label="Subtitle after line 1"] .history-line-text'),
    ).toHaveText('Revision 12');
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('multiline comparisons align edited lines and insertion or deletion spacers at every viewport', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-history-lines-'));
  const app = await buildApp({
    dataDir,
    mcp: false,
    desktopAdapter: false,
    claudeSettingsPath: join(dataDir, 'claude-settings.json'),
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Aligned line history',
      description: '',
      repositories: [],
    });
    const originalRoute =
      'Routes use the cached tiles and detailed walking descriptions for the entire coastal route while the device remains offline.';
    const updatedRoute =
      'Routes use the refreshed tiles and detailed walking descriptions for the entire coastal route while the device remains offline, including newly verified ferry connections and accessible detours.';
    const inserted = 'New note: ferry timetable is included.';
    const deleted = 'Remove obsolete elevation tiles.';
    const before = [
      'Map readiness',
      originalRoute,
      'Keep shared checkpoint.',
      deleted,
      'Final validation passes.',
    ];
    const after = [
      'Map readiness',
      inserted,
      updatedRoute,
      'Keep shared checkpoint.',
      'Final validation passes.',
    ];
    const report = {
      workspaceId: workspace.id,
      title: 'Compare map readiness',
      subtitle: 'Reviewing route notes',
      summary: before.join('\n'),
      source: 'line-diff-test',
      status: 'in_progress' as const,
    };
    const first = await app.store.publishActivity(report);
    await app.store.publishActivity({ ...report, workId: first.workId, summary: after.join('\n') });

    await page.goto(url);
    const row = page.locator('article.activity-item').filter({ hasText: report.title });
    await row.locator('.activity-main').click();
    await page
      .locator('article.activity-reader')
      .getByRole('button', { name: /Version history/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    const summary = dialog.locator('section[aria-label="Summary"]');
    const rows = summary.locator('.history-diff-row');
    await expect(rows).toHaveCount(6);
    expect(
      await rows.evaluateAll((elements) =>
        elements.map((element) => {
          function text(side: string) {
            const cell = element.querySelector<HTMLElement>(`.history-${side}`)!;
            return cell.dataset.empty === 'true'
              ? null
              : cell.querySelector('.history-line-text')?.textContent;
          }
          return [text('before'), text('after')];
        }),
      ),
    ).toEqual([
      [before[0], after[0]],
      [null, inserted],
      [originalRoute, updatedRoute],
      [before[2], after[3]],
      [deleted, null],
      [before[4], after[4]],
    ]);
    await expect(summary.getByLabel('Summary before spacer', { exact: true })).toHaveText('');
    await expect(summary.getByLabel('Summary after spacer', { exact: true })).toHaveText('');
    await expect(
      summary.getByLabel('Summary before line 2', { exact: true }).locator('del').first(),
    ).toContainText('cached');
    await expect(
      summary.getByLabel('Summary after line 3', { exact: true }).locator('ins').first(),
    ).toContainText('refreshed');
    await expect(summary.locator('del').first()).toHaveCSS('text-decoration-line', 'none');

    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expectHistoryLayout(dialog, viewport);
      const alignment = await rows.evaluateAll((elements) =>
        elements.map((element) => {
          const before = element.querySelector('.history-before')!.getBoundingClientRect();
          const after = element.querySelector('.history-after')!.getBoundingClientRect();
          return {
            before: { x: before.x, y: before.y, height: before.height },
            after: { x: after.x, y: after.y, height: after.height },
          };
        }),
      );
      for (const cells of alignment) {
        expect(cells.before.x).toBeLessThan(cells.after.x);
        expect(Math.abs(cells.before.y - cells.after.y)).toBeLessThan(1);
        expect(Math.abs(cells.before.height - cells.after.height)).toBeLessThan(1);
      }
      // The long edit wraps, and its shorter opposite side fills the same row height.
      expect(alignment[2].before.height).toBeGreaterThan(alignment[0].before.height);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await mkdir(resolve('.local/screenshots'), { recursive: true });
      await page.screenshot({
        path: resolve(
          `.local/screenshots/activity-history-lines-${viewport.width === 390 ? 'mobile' : 'desktop'}.png`,
        ),
        animations: 'disabled',
      });
      if (viewport.width === 390) {
        expect(
          await dialog.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        const pageScroll = await page.evaluate(() => window.scrollY);
        await dialog.hover();
        await page.mouse.wheel(0, 600);
        await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await expectHistoryLayout(dialog, viewport);
      }
    }
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
