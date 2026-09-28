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

const DEMO_PASSWORD = 'FreightDemo2026';

/**
 * Loads the demonstration dataset and signs in as the manager.
 *
 * Seeding needs a manager unless nobody can sign in yet, so this signs in first
 * when it can. Each test gets a fresh browser context, hence a fresh session.
 */
async function authMode(page: Page): Promise<'demo' | 'password' | 'entra'> {
  const res = await page.request.get('/api/freight/state');
  const body = (await res.json()) as { auth?: { mode?: 'demo' | 'password' | 'entra' } };
  return body.auth?.mode ?? 'demo';
}

/**
 * Loads the demonstration dataset and becomes `as`.
 *
 * Works in both modes the suite can meet. In demo mode there is no sign-in and
 * the person is chosen with the picker; in password mode it signs in, and
 * seeding needs a manager first. Each test gets a fresh browser context, hence
 * a fresh session.
 */
async function loadDemo(page: Page, as: RegExp = /Manager/i) {
  const mode = await authMode(page);

  if (mode === 'password') {
    const state = await page.request.get('/api/freight/auth/state');
    const before = (await state.json()) as {
      needsSetup?: boolean;
      demo?: { accounts: { email: string; title: string }[] };
    };
    if (!before.needsSetup) {
      const manager = (before.demo?.accounts ?? []).find((a) => /Manager/i.test(a.title));
      if (manager) {
        await page.request.post('/api/freight/auth/login', {
          data: { email: manager.email, password: DEMO_PASSWORD },
        });
      }
    }
  }

  const seeded = await page.request.post('/api/freight/demo');
  expect(seeded.ok(), `seed failed: ${seeded.status()} ${await seeded.text()}`).toBeTruthy();

  // Seeding replaced every account, so become whoever this test wants.
  const after = await page.request.get('/api/freight/state');
  const users = ((await after.json()) as { users?: { id: string; email: string; title: string; name: string }[] })
    .users ?? [];
  const who = users.find((u) => as.test(u.title) || as.test(u.name)) ?? users[0];

  if (mode === 'password') {
    const login = await page.request.post('/api/freight/auth/login', {
      data: { email: who.email, password: DEMO_PASSWORD },
    });
    expect(login.ok(), `sign-in failed: ${await login.text()}`).toBeTruthy();
  } else if (who) {
    const switched = await page.request.post('/api/freight/state', { data: { userId: who.id } });
    expect(switched.ok(), `switch failed: ${await switched.text()}`).toBeTruthy();
  }

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

  test('a charge the reader did not recognise reaches the reviewer', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/freight/rfqs');
    await page.getByRole('link', { name: /RFQ-MPD-2026-0001/ }).first().click();
    await page.getByRole('tab', { name: /Quotes/ }).click();

    // One demo provider words a charge in a way no rule covers. It must be put
    // in front of a person, not dropped - a quotation missing a charge looks
    // cheaper than it is.
    await page.getByRole('button', { name: /Levant Maritime Services/ }).first().click();
    await expect(page.getByText('Lines with an amount that were not recognised')).toBeVisible();
    const list = page.locator('h3:has-text("not recognised") + p + ul');
    await expect(list).toContainText('Low sulphur fuel levy');
    // Only the charge: a panel that also lists greetings is one nobody reads.
    await expect(list.locator('li')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/14-unrecognised-charge.png`, fullPage: true });
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

  test('a quotation nobody has checked is refused, and the screen says why', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/freight/rfqs');
    await page.getByRole('link', { name: /RFQ-MPD-2026-0001/ }).first().click();
    await page.getByRole('tab', { name: /Record/ }).click();

    const card = page.locator('.card', { hasText: 'Quotations in ERPNext' });
    await expect(card.locator('tbody tr')).not.toHaveCount(0);
    await expect(card.getByText(/figures have not been checked yet/).first()).toBeVisible();
    // A superseded version explains itself rather than looking merely unrecorded.
    await expect(card.getByText(/replaced by a later quotation/).first()).toBeVisible();
    // Nothing unchecked may be offered for writing.
    await expect(card.getByRole('button', { name: /Record \d+ quotation/ })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/12-quotation-refusals.png`, fullPage: true });
  });

  test('checked quotations are recorded, and never presented as live', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/freight/rfqs');
    // 0003 is finished, so it is not in the default list of live requests.
    await page.getByRole('radio', { name: 'All' }).click();
    await page.getByRole('link', { name: /RFQ-MPD-2026-0003/ }).first().click();
    await page.getByRole('tab', { name: /Record/ }).click();

    const card = page.locator('.card', { hasText: 'Quotations in ERPNext' });
    const record = card.getByRole('button', { name: /Record \d+ quotation/ });
    await record.click();
    await page.getByRole('button', { name: /Confirm/ }).click();

    // This request's first ERPNext attempt is scripted to fail in the demo, and
    // a failure must be visible rather than swallowed - and must not be
    // announced with a success tick.
    await expect(page.locator('.toast').filter({ hasText: /failed/ })).toHaveAttribute('data-tone', 'bad');
    await expect(card.getByText(/did not succeed/).first()).toBeVisible();

    // The retry uses the same idempotency key, so it recovers without a second record.
    await record.click();
    await page.getByRole('button', { name: /Confirm/ }).click();
    await expect(card.getByText('Simulated, not in ERPNext').first()).toBeVisible();
    await expect(card.getByText('Freight Quotation').first()).toBeVisible();
    await expect(record).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/13-quotations-recorded.png`, fullPage: true });
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

  test('company boundaries hold when signed in as another company user', async ({ page }) => {

    await loadDemo(page, /Reem/);
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

test.describe('authentication', () => {
  /*
   * These exercise password mode in a browser, and they need both password mode
   * and a seeded workspace. Those two cannot be had in one run of this suite:
   * seeding is deliberately refused once sign-in is on, and the mode is fixed
   * when the server boots. So they skip unless the server was started in
   * password mode against a workspace that already holds the demo data.
   *
   * To run them:
   *   npm start                       # demo mode, press Load demo data
   *   AUTH_MODE=password npm start    # restart, then point the suite at it
   *
   * Password sign-in itself is covered without a browser by the 25 tests in
   * tests/auth-password.test.ts and the password-mode run of scripts/journey.mjs.
   */
  test.beforeEach(async ({ page }) => {
    const mode = await authMode(page);
    test.skip(mode !== 'password', `server is in ${mode} mode`);
    const res = await page.request.get('/api/freight/auth/state');
    const body = (await res.json()) as { demo?: { accounts: unknown[] } };
    test.skip((body.demo?.accounts ?? []).length === 0, 'workspace has no demo accounts to sign in with');
  });

  test('an unauthenticated visitor is sent to sign in', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/freight');
    await expect(page).toHaveURL(/\/freight\/login/);
    await expect(page.getByRole('heading', { name: /Sign in|Create the first account/ })).toBeVisible();
  });

  test('a wrong password is refused, and the right one gets in', async ({ page }) => {
    await loadDemo(page);
    const accounts = await page.request.get('/api/freight/auth/state');
    const who = ((await accounts.json()) as { demo?: { accounts: { email: string }[] } }).demo!.accounts[0];

    await page.context().clearCookies();
    await page.goto('/freight/login');

    await page.getByLabel('Email address').fill(who.email);
    await page.getByLabel('Password').fill('DefinitelyWrong1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/do not match an account/i)).toBeVisible();
    await expect(page).toHaveURL(/\/freight\/login/);

    await page.getByLabel('Password').fill('FreightDemo2026');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  });

  test('signing out ends the session', async ({ page }) => {
    await loadDemo(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/freight\/login/);

    // Going back must not resurrect the workspace.
    await page.goto('/freight');
    await expect(page).toHaveURL(/\/freight\/login/);
  });

  test('the demo accounts are offered, and fill the form', async ({ page }) => {
    await loadDemo(page);
    await page.context().clearCookies();
    await page.goto('/freight/login');

    await expect(page.getByRole('heading', { name: 'Demonstration accounts' })).toBeVisible();
    await page.getByRole('button', { name: 'Use' }).first().click();
    await expect(page.getByLabel('Email address')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  });
});
