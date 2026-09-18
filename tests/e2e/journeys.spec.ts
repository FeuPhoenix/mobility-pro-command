import { expect, test, type Page } from '@playwright/test';

/**
 * Every test starts from the original scenario in its own isolated session.
 * The browser owns the demo document, so clearing its storage is the reset.
 */
async function resetDemo(page: Page) {
  await page.goto('/');
  await page.waitForSelector('.briefing h1');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.waitForSelector('.briefing h1');
}

test.describe('Opening experience', () => {
  test('opens into a populated workspace that explains itself', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/');

    await expect(page.locator('.briefing h1')).toContainText('need a decision');
    await expect(page.locator('.demo-chip')).toHaveText('Demo data');
    await expect(page.locator('.adapter-chip')).toContainText('ERPNext demo adapter');
    await expect(page.locator('.adapter-chip')).toContainText('Not connected');

    // The four seeded exception types are all present and ranked.
    const queue = page.locator('.exc');
    await expect(queue.first()).toHaveAttribute('data-sev', 'critical');
    await expect(page.locator('.exc-title', { hasText: 'PI-ORI-88412 does not match PO-2026-0418' })).toBeVisible();
    await expect(page.locator('.exc-title', { hasText: /has aged past 180 days/ })).toBeVisible();
    await expect(page.locator('.exc-title', { hasText: /needs a credit decision/ }).first()).toBeVisible();
    await expect(page.locator('.exc-title', { hasText: /is priced on Egypt Trade Price List 2026-Q2/ })).toBeVisible();

    // Measures are reported separately, never blended.
    await expect(page.locator('.m-label', { hasText: 'Purchase value exposed' })).toBeVisible();
    await expect(page.locator('.m-label', { hasText: 'Inventory carrying value' })).toBeVisible();
    await expect(page.locator('.m-label', { hasText: 'Receivables at risk' })).toBeVisible();
  });

  test('state survives a refresh and reset restores the original scenario', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/operations/documents/DOC-PI-0418-R1');

    await page.getByRole('button', { name: 'Create discrepancy case' }).click();
    await expect(page.getByRole('heading', { name: /^Case CASE-/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: /^Case CASE-/ })).toBeVisible();

    // Reset from the rail, then confirm.
    await page.getByRole('button', { name: 'Reset demo' }).click();
    await page.getByRole('button', { name: 'Reset to the original scenario' }).click();
    await page.goto('/operations/documents/DOC-PI-0418-R1');
    await expect(page.getByRole('button', { name: 'Create discrepancy case' })).toBeVisible();
  });
});

test.describe('Journey A - supplier document control', () => {
  test('compare, correct, case, clarify, revise, release readiness', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/operations/documents/DOC-PI-0418-R1');

    // 1. Readiness is held, with the reasons stated.
    await expect(page.getByText('SHP-2026-0088 — Held - document control')).toBeVisible();
    await expect(page.locator('.pill.bad', { hasText: '4 blocking' })).toBeVisible();

    // 2. The source document renders and the offending lines are flagged.
    await expect(page.locator('.doc-facsimile').first()).toContainText('PRO FORMA INVOICE');
    await expect(page.locator('.doc-row.flagged').first()).toBeVisible();

    // 3. The packing list is available and agrees with the order.
    await expect(page.getByText(/Open sample documents: PI-ORI-88412, PL-ORI-88412/)).toBeVisible();
    await expect(page.getByText(/agrees with the order, so the difference sits with this document/)).toBeVisible();

    // 4. Correcting an extracted value changes the comparison.
    const plyRow = page.locator('tr', { hasText: 'Ply rating' }).first();
    await plyRow.getByRole('button', { name: 'Correct' }).click();
    await page.getByLabel('Value as it reads on the document').fill('16PR');
    await page.getByRole('button', { name: 'Save and re-validate' }).click();
    await expect(page.locator('.pill.bad', { hasText: '3 blocking' })).toBeVisible();

    // 5. Put it back — the document really does say 18PR.
    await plyRow.getByRole('button', { name: 'Correct' }).click();
    await page.getByLabel('Value as it reads on the document').fill('18PR');
    await page.getByRole('button', { name: 'Save and re-validate' }).click();
    await expect(page.locator('.pill.bad', { hasText: '4 blocking' })).toBeVisible();

    // 6. Raise the case.
    await page.getByRole('button', { name: 'Create discrepancy case' }).click();
    await expect(page.getByRole('heading', { name: /^Case CASE-/ })).toBeVisible();

    // 7. Generate and edit the supplier clarification.
    await page.getByRole('button', { name: 'Generate draft' }).click();
    const body = page.getByLabel('Message');
    await expect(body).toContainText('PO-2026-0418');
    await expect(body).toContainText('18PR');
    await page.getByLabel('Subject').fill('URGENT: PO-2026-0418 revised pro forma invoice required');
    await page.getByRole('button', { name: 'Save draft' }).click();

    // 8. Record as sent — and be explicit that nothing left the demo.
    await page.getByRole('button', { name: 'Record as sent' }).click();
    await expect(page.getByText('Recorded as sent inside the demo.')).toBeVisible();
    await expect(page.getByText(/Nothing leaves this application/)).toBeVisible();

    // 9. Simulate the corrected document and re-run validation.
    await page.getByRole('button', { name: 'Simulate receipt of a corrected document' }).click();
    await expect(page.getByText('A revised document has been received')).toBeVisible();
    await page.getByRole('button', { name: 'Re-run validation and close the case' }).click();

    // 10. Readiness is released, the advisory survives, and nothing claims arrival.
    await page.goto('/operations/documents');
    await expect(page.locator('.pill.good', { hasText: 'Ready for receiving' })).toBeVisible();
    await expect(page.getByText('1 advisory note')).toBeVisible();
    await expect(
      page.locator('table').last().locator('tr', { hasText: 'CASE-' }).locator('.pill'),
    ).toHaveText('Resolved');
  });

  test('an override needs an authorised role and a written reason', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/operations/documents/DOC-PI-0418-R1');
    await page.getByRole('button', { name: 'Create discrepancy case' }).click();

    // The current role is Supply Planning, so the override is refused up front.
    await page.getByRole('button', { name: 'Override with a reason' }).click();
    await expect(page.getByText(/You are acting as Rana Fathy/)).toBeVisible();
    const reason = page.getByLabel('Reason (retained on the case)');
    await reason.fill('Supplier confirmed the 18PR casing is an approved upgrade at no extra cost.');
    await expect(page.getByRole('button', { name: 'Override with this reason' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Switch to the authorised role.
    await page.getByLabel('Acting as which demo role').selectOption({ label: 'Omar Shalaby — Procurement Manager' });
    await page.getByRole('button', { name: 'Override with a reason' }).click();
    const reason2 = page.getByLabel('Reason (retained on the case)');
    await reason2.fill('Too short');
    await expect(page.getByRole('button', { name: 'Override with this reason' })).toBeDisabled();
    await reason2.fill('Supplier confirmed the 18PR casing is an approved upgrade at no extra cost.');
    await page.getByRole('button', { name: 'Override with this reason' }).click();

    await expect(page.getByText(/Overridden by Omar Shalaby/)).toBeVisible();
    await expect(page.getByText('SHP-2026-0088 — Ready for receiving')).toBeVisible();
  });

  test('the clean supplier document reports no mismatch', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/operations/documents/DOC-PI-0431');
    await expect(page.getByText('This document matches the purchase order')).toBeVisible();
    await expect(page.locator('.pill.good', { hasText: '0 blocking' })).toBeVisible();
  });
});

test.describe('Journey B - aging stock to a controlled sale', () => {
  test('scenarios, order, credit block, approval and downstream effects', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/operations/inventory/OPP-2026-014');

    // 1. The evidence is stated as fact, with limits stated separately.
    await expect(page.getByText('What we actually know')).toBeVisible();
    await expect(page.getByText('WHAT THIS CANNOT TELL YOU')).toBeVisible();
    await expect(page.getByText('Whether a discount actually produces extra volume. It is an assumption, editable below.')).toBeVisible();

    // 2. Scenario arithmetic is correct at 8% on 420 pcs.
    await page.getByLabel(/Proposed quantity/).first().fill('420');
    await page.getByRole('radio', { name: '8%' }).click();
    const eight = page.locator('.scen', { hasText: 'Discount 8%' });
    await expect(eight).toContainText('EGP 4,241.20');
    await expect(eight).toContainText('EGP 1,781,304');
    await expect(eight).toContainText('EGP 294,504');

    // 3. Changing the discount changes the arithmetic.
    await page.getByRole('radio', { name: '10%' }).click();
    const ten = page.locator('.scen', { hasText: 'Discount 10%' });
    await expect(ten).toContainText('EGP 4,149.00');

    // 4. Changing the ASSUMPTION must not change the arithmetic.
    const revenueBefore = await ten.textContent();
    await page.getByLabel(/Uplift assumption/).fill('20');
    await expect(ten).toContainText('EGP 4,149.00');
    expect(revenueBefore).toBeTruthy();
    await expect(ten).toContainText('/mo'); // the assumed rate did move

    // 5. Suggested customers carry their purchase-history evidence.
    await expect(page.getByText('Who has bought this SKU')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nile Fleet Services' }).first()).toBeVisible();

    // 6. Prepare the order at 420 @ 8%.
    await page.getByRole('radio', { name: '8%' }).click();
    await page.getByLabel('Customer').selectOption('C-NILEFLT');
    await page.getByRole('button', { name: 'Prepare proposed order' }).click();

    // 7. The real block: stock is fine, the limit is fine, an invoice is 52 days overdue.
    await expect(page).toHaveURL(/\/operations\/orders\/SO-/);
    await expect(page.locator('.notice.bad')).toContainText('an invoice is 52 days past due');
    await expect(page.locator('tr', { hasText: 'Sufficient available quantity' }).locator('.pill.good')).toBeVisible();

    // 8. Three explainable options, each routed to the Finance Director.
    await expect(page.getByText('Release against a 30% advance deposit')).toBeVisible();
    await expect(page.getByText('Partial release within the uncovered limit')).toBeVisible();
    await expect(page.getByText('Finance review with a dated collection commitment')).toBeVisible();

    // 9. Request approval.
    await page.getByRole('radio').first().check();
    await page.getByLabel('Note for the approver (optional)').fill('Customer has committed to settle INV-2026-0412 by 30 Sep.');
    await page.getByRole('button', { name: 'Request approval' }).click();
    await expect(page).toHaveURL(/\/approvals/);

    // 10. The wrong role cannot decide.
    await expect(page.getByText(/You are acting as Rana Fathy/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();

    // 11. Switch to Finance Director and approve.
    await page.getByLabel('Acting as which demo role').selectOption({ label: 'Samir Ghali — Finance Director' });
    await page.getByLabel('Decision note (optional)').fill('Approved against a 30% advance deposit.');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.locator('.toast').last()).toContainText('released and stock is reserved');

    // 12. Downstream: reservation created, available stock reduced, exposure updated.
    await page.goto('/operations/inventory');
    const row = page.locator('tr', { hasText: '265/70R16 10PR' }).first();
    await expect(row).toContainText('392'); // 812 available - 420 reserved

    await page.goto('/customers/C-NILEFLT');
    await expect(page.getByText('Credit exposure')).toBeVisible();
    // Receivables are unchanged: approval does not collect cash.
    await expect(
      page.locator('.measure').filter({ has: page.locator('.m-label', { hasText: /^Open receivables$/ }) }),
    ).toContainText('EGP 13,223,000');
  });

  test('a superseded price list blocks release until the order is re-priced', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/operations/orders/SO-2026-0771');
    await expect(page.getByText('Priced on a superseded price list')).toBeVisible();
    await page.getByRole('button', { name: /Re-price onto/ }).click();
    await expect(page.locator('.toast').last()).toContainText('Re-priced onto');
    await expect(page.getByText('Priced on a superseded price list')).toBeHidden();
  });
});

test.describe('Assistant', () => {
  test('answers in labelled bands, links records and previews an action', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/operations/documents/DOC-PI-0418-R1');
    await page.getByRole('button', { name: 'Assistant' }).click();

    await expect(page.locator('.assistant .pill.warn', { hasText: 'Simulated' })).toBeVisible();
    await expect(page.locator('.ctx-chip')).toContainText('supplier document');

    await page.getByRole('button', { name: 'Why is this shipment blocked?' }).click();
    await expect(page.locator('.a-band[data-kind="facts"]')).toBeVisible();
    await expect(page.locator('.a-band[data-kind="calculations"]')).toContainText('BLOCKING');
    await expect(page.locator('.a-band[data-kind="assumptions"]')).toContainText('PR-3.1');
    await expect(page.locator('.assistant .ref-chip').first()).toBeVisible();
    await expect(page.getByText('Action preview')).toBeVisible();
  });

  test('declines a question it cannot answer instead of inventing one', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Assistant' }).click();
    await page.getByLabel('Ask the assistant').fill('What will the tyre market do next quarter?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.locator('.a-band[data-kind="limitation"]')).toBeVisible();
    await expect(page.getByText('I cannot answer that from the demo dataset.')).toBeVisible();
  });
});

test.describe('Automations', () => {
  test('shows the n8n workflows, their guardrails and a simulated run', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/automations');

    // Honest about the connection, every time.
    await expect(page.locator('.notice.warn')).toContainText('n8n demo adapter');
    await expect(page.locator('.notice.warn')).toContainText('not connected');

    // Seven workflows, each with a trigger and a journey.
    await expect(page.locator('.wf-row')).toHaveCount(7);
    await expect(page.locator('.wf-row').first()).toContainText('Supplier document intake');

    // Selecting one shows its real n8n node types and both boundaries.
    await page.locator('.wf-row', { hasText: 'Aging stock sweep' }).click();
    await expect(page.locator('.wf-step-node').first()).toContainText('n8n-nodes-base.');
    await expect(page.getByText('What it will not do')).toBeVisible();
    await expect(page.getByText(/Never prices, discounts, transfers or reserves/)).toBeVisible();

    // A simulated run reads the live demo data and is recorded as simulated.
    const rowsBefore = await page.locator('tbody tr').count();
    await page.getByRole('button', { name: 'Simulate a run' }).click();
    await expect(page.locator('.toast').last()).toContainText('lots evaluated');
    await expect(page.locator('tbody tr')).toHaveCount(rowsBefore + 1);

    // The export is downloadable.
    await expect(page.getByRole('link', { name: 'Download workflow' })).toHaveAttribute(
      'href',
      '/n8n/aging-stock-sweep.json',
    );
  });

  test('refuses to simulate a draft workflow', async ({ page }) => {
    await resetDemo(page);
    await page.goto('/automations');
    await page.locator('.wf-row', { hasText: 'ERPNext master sync' }).click();
    await expect(page.locator('.card-head .pill.warn', { hasText: 'Draft' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Simulate a run' })).toBeDisabled();
  });
});

test.describe('Responsive', () => {
  test('is usable at phone width without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetDemo(page);
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The rail collapses behind a menu button.
    await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect(page.getByRole('link', { name: /Approvals/ })).toBeVisible();
  });
});
