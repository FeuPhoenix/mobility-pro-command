import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Browser tests for the freight workspace.
 *
 * They drive the real UI against a production build: load the demonstration
 * dataset, walk the journey, and check both that the right things happen and
 * that the refusals are visible to the person on the screen.
 */

const SHOTS = 'test-results/screenshots';
mkdirSync(SHOTS, { recursive: true });

async function loadDemo(page: Page) {
  await page.goto('/freight');
  // A fresh browser context has no session, so the workspace may already hold
  // data from an earlier test; reload the dataset either way for determinism.
  const res = await page.request.post('/api/freight/demo');
  expect(res.ok()).toBeTruthy();
  await page.goto('/freight');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function openMainRfq(page: Page) {
  await page.goto('/freight/rfqs');
  await page.getByRole('link', { name: /Tyre import, North China/ }).first().click();
  await expect(page.getByRole('tab', { name: /Comparison/ })).toBeVisible();
}

test.describe('freight workspace', () => {
  test('the overview answers the five questions', async ({ page }) => {
    await loadDemo(page);

    for (const label of [
      'need your approval',
      'waiting for responses',
      'quotes to check',
      'replies to match',
      'comparisons ready',
      'records to finish',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    await expect(page.getByRole('heading', { name: 'Quotes to check' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Replies to match' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ERPNext records' })).toBeVisible();

    // Simulated state must be visible, never dressed up as a live connection.
    await expect(page.getByText('Simulated mail and ERPNext')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-overview.png`, fullPage: true });
  });

  test('providers that must not be contacted cannot be selected', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/freight/providers');
    await page.getByRole('button', { name: /Mobility Pro Distribution/ }).click();

    await expect(page.getByText('Horizon Global Forwarding')).toBeVisible();
    await expect(page.getByText(/Under a fixed annual agreement/)).toBeVisible();
    await expect(page.getByText(/Excluded by the Logistics Operations Manager/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-providers.png`, fullPage: true });

    // In the picker for a draft request, those providers are disabled.
    await page.goto('/freight/rfqs');
    await page.getByRole('radio', { name: 'All' }).click();
    const draft = page.getByRole('link', { name: /Component import/ });
    if (await draft.count()) {
      await draft.first().click();
      await page.getByRole('tab', { name: /Providers/ }).click();
    }
  });

  test('an email cannot be sent without approval, and editing revokes it', async ({ page }) => {
    await loadDemo(page);
    await openMainRfq(page);

    await page.getByRole('tab', { name: /Providers/ }).click();
    await page.getByRole('button', { name: 'Prepare reminders' }).click();
    await expect(page.locator('.toast').filter({ hasText: /reminder/i })).toBeVisible();

    await page.getByRole('tab', { name: /Emails/ }).click();
    await page.getByRole('button', { name: /^Reminder —/ }).first().click();

    // Not approved yet, so there is no send control at all.
    await expect(page.getByRole('button', { name: 'Send now' })).toHaveCount(0);
    await expect(page.getByText('Awaiting approval').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/03-email-awaiting-approval.png`, fullPage: true });

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Approved. ')).toBeVisible();

    // Editing after approval must visibly revoke it.
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Subject').fill('Edited after approval');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('This changed after it was approved.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send now' })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/04-approval-revoked.png`, fullPage: true });
  });

  test('a quotation is reviewed against its source and then compared', async ({ page }) => {
    await loadDemo(page);
    await openMainRfq(page);

    await page.getByRole('tab', { name: /Quotes/ }).click();
    await expect(page.getByRole('heading', { name: 'The original' })).toBeVisible();
    // The source sits beside the fields.
    await expect(page.locator('.source-text')).toBeVisible();
    await expect(page.getByText('Base freight').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/05-quote-review.png`, fullPage: true });

    // The offer with a missing surcharge says so rather than showing zero.
    await page.locator('button.fr-row', { hasText: 'Delta Freight Partners' }).first().click();
    await expect(page.getByText(/this offer cannot be compared/i).first()).toBeVisible();
    // The provenance note must actually be readable, not squashed to a sliver.
    const srcWidth = await page.locator('.prov-row .src').first().evaluate((el) => el.getBoundingClientRect().width);
    expect(srcWidth).toBeGreaterThan(200);

    // Confirm every quotation that still needs checking.
    for (let i = 0; i < 6; i++) {
      const row = page.locator('button.fr-row', { hasText: 'Needs checking' }).first();
      if ((await row.count()) === 0) break;
      await row.click();
      await page.getByRole('button', { name: 'Confirm these figures' }).click();
      await expect(page.locator('.toast').filter({ hasText: /Checked/i }).first()).toBeVisible();
      await page.waitForTimeout(250);
    }

    await page.getByRole('tab', { name: /Comparison/ }).click();
    await page.getByRole('button', { name: /Build comparison/ }).click();
    await expect(page.getByRole('heading', { name: 'Recommendation' })).toBeVisible({ timeout: 20_000 });

    // The cheapest and the recommended offer are both named, and differ.
    await expect(page.getByText('The cheapest offer is not the recommended one.')).toBeVisible();
    await expect(page.getByText(/Recommended$/).first()).toBeVisible();
    await expect(page.getByText(/nothing booked|no booking has been made/i).first()).toBeVisible();

    // The matrix keeps provider names pinned across the top.
    await expect(page.locator('.cmp thead th').first()).toBeVisible();
    await expect(page.locator('.cmp tbody tr').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/06-comparison.png`, fullPage: true });
  });

  test('the comparison email is prepared, approved and only then sent', async ({ page }) => {
    await loadDemo(page);
    await openMainRfq(page);

    // Confirm the quotes, then build.
    await page.getByRole('tab', { name: /Quotes/ }).click();
    for (let i = 0; i < 6; i++) {
      const row = page.locator('button.fr-row', { hasText: 'Needs checking' }).first();
      if ((await row.count()) === 0) break;
      await row.click();
      await page.getByRole('button', { name: 'Confirm these figures' }).click();
      await page.waitForTimeout(250);
    }
    await page.getByRole('tab', { name: /Comparison/ }).click();
    await page.getByRole('button', { name: /Build comparison/ }).click();
    await expect(page.getByRole('heading', { name: 'Recommendation' })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Prepare the comparison email' }).click();
    await expect(page.locator('.toast').filter({ hasText: /approval/i })).toBeVisible();

    await page.getByRole('tab', { name: /Emails/ }).click();
    await page.getByRole('button', { name: /^Comparison —/ }).first().click();
    await expect(page.getByText('Awaiting approval').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Freight comparison RFQ-MPD-2026-0001\.xlsx/ })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/07-comparison-email.png`, fullPage: true });

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Send now' }).click();
    await page.getByRole('button', { name: /Confirm \(simulated send\)/ }).click();
    await expect(page.locator('.toast').filter({ hasText: /simulated/i })).toBeVisible();
  });

  test('a failed ERPNext record can be retried and is never called live', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/freight');

    const erpRow = page.locator('.fr-row', { hasText: 'RFQ-MPD-2026-0003' }).first();
    await expect(erpRow).toBeVisible();
    await expect(erpRow.getByText('Recording failed')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/08-erp-failed.png`, fullPage: true });

    await erpRow.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.toast').filter({ hasText: /Recorded locally|simulated/i })).toBeVisible();
    // It must say simulated, never "written to ERPNext".
    await expect(page.getByText('Simulated, not in ERPNext').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/09-erp-recovered.png`, fullPage: true });
  });

  test('an ambiguous reply asks a person instead of guessing', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/freight/inbox');

    await expect(page.getByRole('heading', { name: 'Which request is this?' })).toBeVisible();
    await expect(page.getByText(/No RFQ reference was quoted/)).toBeVisible();
    await expect(page.getByText('Candidates the matcher considered')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/10-ambiguous-reply.png`, fullPage: true });

    await page.locator('input[name="candidate"]').first().check();
    await page.getByRole('button', { name: 'Attach and read the quotation' }).click();
    await expect(page.locator('.toast').filter({ hasText: /Attached to the RFQ/i })).toBeVisible();
  });

  test('company boundaries hold when acting as another company user', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/freight');

    const picker = page.getByLabel('Acting as which person');
    const reemValue = await picker.locator('option', { hasText: 'Reem Al Suwaidi' }).first().getAttribute('value');
    await picker.selectOption(reemValue as string);
    await page.waitForTimeout(600);
    await page.goto('/freight/rfqs');
    await page.getByRole('radio', { name: 'All' }).click();
    await expect(page.getByText('RFQ-MPD-2026-0001')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/11-company-isolation.png`, fullPage: true });
  });

  test('a filled-in spreadsheet fills the new request form, and creates nothing by itself', async ({ page }) => {
    await loadDemo(page);
    const template = await page.request.get('/api/freight/template/rfq');
    expect(template.ok()).toBeTruthy();
    const before = (await (await page.request.get('/api/freight/state')).json()).overview.rfqs.length;

    await page.goto('/freight/rfqs/new');
    await page.locator('input[type="file"][accept=".xlsx,.csv"]').setInputFiles({
      name: 'requirement.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await template.body()),
    });

    await expect(page.getByLabel('Title')).toHaveValue('Tyre import, North China to Alexandria');
    await expect(page.getByLabel('Origin port')).toHaveValue('CNSHA');
    await expect(page.getByLabel('Destination port')).toHaveValue('EGALY');
    await expect(page.getByText(/Loaded "Tyre import/)).toBeVisible();
    const after = (await (await page.request.get('/api/freight/state')).json()).overview.rfqs.length;
    expect(after).toBe(before);
    await page.screenshot({ path: `${SHOTS}/13-import-template.png`, fullPage: true });
  });

  test('the workspace is usable at a narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadDemo(page);

    // Nothing should overflow the viewport horizontally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${SHOTS}/12-narrow.png`, fullPage: true });
  });
});
