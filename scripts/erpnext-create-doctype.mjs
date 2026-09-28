/**
 * Creates a freight destination DocType on an ERPNext instance.
 *
 * Two destinations exist. **`quotation` is the one the customer chose** (the
 * raw quotations); `comparison` is the decision record, still available.
 *
 * Run it ONCE per destination. It changes the ERPNext schema, so it needs an
 * administrator's API key - NOT the key the application uses day to day, which
 * should only be able to write records.
 *
 *   node scripts/erpnext-create-doctype.mjs --dry-run
 *   node scripts/erpnext-create-doctype.mjs --module Freight [--supplier-link]
 *   node scripts/erpnext-create-doctype.mjs --destination comparison --module Buying
 *
 * Environment:
 *   ERPNEXT_BASE_URL            e.g. https://erp.example.com
 *   ERPNEXT_ADMIN_API_KEY       an administrator's API key
 *   ERPNEXT_ADMIN_API_SECRET    and secret
 *
 * It creates, skipping anything that already exists:
 *   - the role "Freight RFQ Integration", to give the application's API user,
 *   - the child DocType "Freight Comparison Offer",
 *   - the DocType "Freight Comparison", with freight_idempotency_key marked
 *     Unique so ERPNext itself refuses a duplicate record.
 *
 * It never modifies or deletes an existing DocType. If one exists with the
 * same name, it says so and leaves it alone.
 */

import * as comparison from './erpnext/freight-comparison-doctype.mjs';
import * as quotation from './erpnext/freight-quotation-doctype.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DESTINATIONS = { quotation, comparison };
const which = option('--destination', 'quotation');
const dest = DESTINATIONS[which];
if (!dest) {
  console.error(`Unknown destination "${which}". Use quotation (the agreed one) or comparison.`);
  process.exit(2);
}
const { CHILD, INTEGRATION_ROLE, PARENT, childDoctype, parentDoctype } = dest;

// Freight is the natural module for the quotations; the comparison record was
// drafted against Buying.
const opts = {
  module: option('--module', which === 'quotation' ? 'Freight' : 'Buying'),
  supplierLink: flag('--supplier-link'),
};
const definitions = [childDoctype(opts), parentDoctype(opts)];

if (flag('--dry-run')) {
  console.log(JSON.stringify({ role: INTEGRATION_ROLE, doctypes: definitions }, null, 2));
  process.exit(0);
}

const base = (process.env.ERPNEXT_BASE_URL ?? '').replace(/\/+$/, '');
const key = process.env.ERPNEXT_ADMIN_API_KEY;
const secret = process.env.ERPNEXT_ADMIN_API_SECRET;
if (!base || !key || !secret) {
  console.error('Set ERPNEXT_BASE_URL, ERPNEXT_ADMIN_API_KEY and ERPNEXT_ADMIN_API_SECRET. Use --dry-run to see what would be created.');
  process.exit(2);
}

const headers = { authorization: `token ${key}:${secret}`, 'content-type': 'application/json', accept: 'application/json' };
const resource = (doctype, name) => `${base}/api/resource/${encodeURIComponent(doctype)}${name ? `/${encodeURIComponent(name)}` : ''}`;

async function exists(doctype, name) {
  const res = await fetch(resource(doctype, name), { headers });
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new Error(`Checking ${doctype} "${name}" returned ${res.status}. Is the key an administrator's?`);
}

async function create(doctype, body, label) {
  if (await exists(doctype, body.name ?? body.role_name ?? body.module_name)) {
    console.log(`  exists   ${label} (left unchanged)`);
    return;
  }
  const res = await fetch(resource(doctype), { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`Creating ${label} failed (${res.status}): ${detail.exception ?? detail._server_messages ?? 'no detail'}`);
  }
  console.log(`  created  ${label}`);
}

console.log(`Creating the freight ${which} destination on ${base} (module: ${opts.module})`);
try {
  // A DocType cannot be created in a module that does not exist, and stock
  // ERPNext has no "Freight" module. Found against a real instance: the error
  // Frappe gives is a bare LinkValidationError, so create it rather than
  // leaving someone to decode that.
  await create(
    'Module Def',
    { doctype: 'Module Def', module_name: opts.module, app_name: 'frappe', custom: 1 },
    `module "${opts.module}"`,
  );
  await create('Role', { doctype: 'Role', role_name: INTEGRATION_ROLE, desk_access: 1 }, `role "${INTEGRATION_ROLE}"`);
  await create('DocType', definitions[0], `DocType "${CHILD}"`);
  await create('DocType', definitions[1], `DocType "${PARENT}"`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}

console.log(`
Next:
  1. Give the application's API user the role "${INTEGRATION_ROLE}", and
     permission to create File (for the workbook attachment).
  2. Set ${which === 'quotation' ? 'ERPNEXT_QUOTATION_DOCTYPE' : 'ERPNEXT_DOCTYPE'}="${PARENT}" and ERPNEXT_ADAPTER=live on the server.
  3. Settings -> Connections -> ERPNext -> Check connection. It must say
     "ERPNext connected" with no setup requirements before anything is written.`);
