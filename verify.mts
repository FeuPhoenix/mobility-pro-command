import { seedDemo } from './src/freight/demo/seed.ts';
import { listRfqs, listQuotes, getCompanyProvider } from './src/freight/repo.ts';
import { reviewQuote } from './src/freight/service/inbox.ts';
import { closeRfq } from './src/freight/service/rfq.ts';
import { createComparison } from './src/freight/service/compare.ts';
import { describeIssue } from './src/freight/domain/comparison.ts';

const { users } = await seedDemo();
const ctx = { user: users[0] };
const rfq = listRfqs(ctx).find(r => r.reference === 'RFQ-MPD-2026-0001')!;

console.log('\n=== QUOTES ON', rfq.reference, '===');
for (const q of listQuotes(ctx, rfq.id)) {
  const name = getCompanyProvider(ctx, q.companyProviderId).provider.name;
  console.log(`${name} v${q.version} [${q.status}] base=${q.baseFreight.value} ${q.currency.value} basis=${q.containerBasis.value} transit=${q.transitDays.value} free=${q.freeDaysDestination.value} valid=${q.validUntil.value} surcharges=${q.surcharges.map(s=>s.code+'='+s.amount).join(',')}`);
}

// Confirm all current quotes, as a reviewer would.
for (const q of listQuotes(ctx, rfq.id)) {
  if (q.status === 'needs_review') reviewQuote(ctx, q.id, { fields: [], confirm: true });
}
closeRfq(ctx, rfq.id);
const c = await createComparison(ctx, rfq.id);

console.log('\n=== COMPARISON ===');
for (const l of c.lines) {
  console.log(`${String(l.rank ?? '-').padStart(2)} ${l.providerName.padEnd(28)} total=${l.totalInBaseCurrency ?? 'n/a'} transit=${l.transitDays} free=${l.freeDays} score=${l.scoreTotal} comparable=${l.comparable}`);
  for (const i of l.issues) console.log('      ! ' + describeIssue(i));
}
const rec = c.lines.find(l=>l.quoteId===c.recommendedQuoteId);
const ch  = c.lines.find(l=>l.quoteId===c.cheapestQuoteId);
console.log('\nRECOMMENDED:', rec?.providerName, rec?.totalInBaseCurrency);
console.log('CHEAPEST   :', ch?.providerName, ch?.totalInBaseCurrency);
console.log('DIFFER     :', rec?.quoteId !== ch?.quoteId ? 'YES (scenario satisfied)' : 'NO');
console.log('\nREASONS:'); c.recommendationReasons.forEach(r=>console.log(' -',r));
console.log('TRADEOFFS:'); c.recommendationTradeoffs.forEach(r=>console.log(' -',r));
console.log('BLOCKED:'); c.blockedNotes.forEach(r=>console.log(' -',r));
