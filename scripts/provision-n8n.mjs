/**
 * Provisions a local n8n instance with the freight workflows.
 *
 * Talks to n8n's internal REST API — the one its own editor uses — because the
 * public API needs an API key, and getting one requires logging in first. This
 * is for a local instance you control; it is not a supported integration point.
 *
 * It is idempotent: run it again and it updates rather than duplicating.
 *
 *   node scripts/provision-n8n.mjs
 *
 * Environment:
 *   N8N_URL        default http://localhost:5678
 *   N8N_EMAIL      owner account to create or log in as
 *   N8N_PASSWORD   owner password (n8n requires 8+ chars, a number, a capital)
 *   MPC_BASE_URL   where n8n should call this application, default :4310
 *   FREIGHT_AUTOMATION_TOKEN / MAILBOX_COLLECT_TOKEN  the bearer tokens
 */

import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const N8N = (process.env.N8N_URL ?? 'http://localhost:5678').replace(/\/+$/, '');
const EMAIL = process.env.N8N_EMAIL ?? 'freight@mobilitypro.test';
const PASSWORD = process.env.N8N_PASSWORD ?? 'FreightRfq2026';
const MPC = (process.env.MPC_BASE_URL ?? 'http://localhost:4310').replace(/\/+$/, '');
const AUTOMATION_TOKEN = process.env.FREIGHT_AUTOMATION_TOKEN ?? '';
/** With a Teams Incoming Webhook URL the notification nodes become real posts. */
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK_URL ?? '';
const COLLECT_TOKEN = process.env.MAILBOX_COLLECT_TOKEN ?? '';

const WORKFLOW_DIR = 'scripts/.n8n-workflows';

let cookie = '';

async function api(path, init = {}) {
  const res = await fetch(`${N8N}/rest${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'browser-id': 'freight-provisioner',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function waitForN8n() {
  process.stdout.write('Waiting for n8n');
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${N8N}/rest/settings`);
      if (res.ok) {
        console.log(' — up.');
        return await res.json();
      }
    } catch {
      /* not listening yet */
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`n8n did not come up at ${N8N}`);
}

/** First run needs an owner; after that, log in. */
async function authenticate(settings) {
  const needsSetup = settings?.data?.userManagement?.showSetupOnFirstLoad;
  if (needsSetup) {
    const res = await api('/owner/setup', {
      method: 'POST',
      body: JSON.stringify({
        email: EMAIL,
        firstName: 'Freight',
        lastName: 'Operations',
        password: PASSWORD,
      }),
    });
    if (res.status >= 400) throw new Error(`Could not create the owner account: ${JSON.stringify(res.body)}`);
    console.log(`Created the owner account ${EMAIL}.`);
    return;
  }

  const res = await api('/login', {
    method: 'POST',
    body: JSON.stringify({ emailOrLdapLoginId: EMAIL, password: PASSWORD }),
  });
  if (res.status >= 400) throw new Error(`Could not log in as ${EMAIL}: ${JSON.stringify(res.body)}`);
  console.log(`Logged in as ${EMAIL}.`);
}

/** Header Auth credentials carrying the two bearer tokens. */
async function ensureCredential(name, token) {
  if (!token) {
    console.log(`  skipped ${name} — no token in the environment`);
    return null;
  }
  const existing = await api('/credentials?includeScopes=true');
  const list = Array.isArray(existing.body?.data) ? existing.body.data : [];
  const found = list.find((c) => c.name === name);

  const payload = {
    name,
    type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: `Bearer ${token}` },
  };

  if (found) {
    const res = await api(`/credentials/${found.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    if (res.status >= 400) throw new Error(`Could not update credential ${name}: ${JSON.stringify(res.body)}`);
    console.log(`  updated credential  ${name}`);
    return found.id;
  }

  const res = await api('/credentials', { method: 'POST', body: JSON.stringify(payload) });
  if (res.status >= 400) throw new Error(`Could not create credential ${name}: ${JSON.stringify(res.body)}`);
  console.log(`  created credential  ${name}`);
  return res.body?.data?.id ?? res.body?.id;
}

/** Attaches the right credential to every HTTP node in a workflow. */
function withCredentials(workflow, automationId, collectId) {
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    const isCollect = String(node.parameters.url ?? '').includes('/api/freight/collect');
    const id = isCollect ? collectId : automationId;
    if (!id) continue;
    node.credentials = {
      httpHeaderAuth: { id, name: isCollect ? 'MPC collect token' : 'MPC automation token' },
    };
  }
  return workflow;
}

async function importWorkflows(automationId, collectId) {
  const existing = await api('/workflows?includeScopes=true');
  const list = Array.isArray(existing.body?.data) ? existing.body.data : [];

  for (const file of readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json'))) {
    const wf = withCredentials(
      JSON.parse(readFileSync(`${WORKFLOW_DIR}/${file}`, 'utf8')),
      automationId,
      collectId,
    );

    // Only the fields n8n accepts on create/update.
    const payload = {
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: wf.settings ?? { executionOrder: 'v1' },
    };

    const found = list.find((w) => w.name === wf.name);
    if (found) {
      const res = await api(`/workflows/${found.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      if (res.status >= 400) throw new Error(`Could not update ${wf.name}: ${JSON.stringify(res.body)}`);
      console.log(`  updated  ${wf.name}`);
    } else {
      const res = await api('/workflows', { method: 'POST', body: JSON.stringify(payload) });
      if (res.status >= 400) throw new Error(`Could not import ${wf.name}: ${JSON.stringify(res.body)}`);
      console.log(`  imported ${wf.name}`);
    }
  }
}

/* ---------------------------------- Run ---------------------------------------- */

console.log(`n8n              ${N8N}`);
console.log(`this application ${MPC}`);
console.log('');

// Rebuild the exports with literal URLs: n8n Variables are a licensed feature,
// so $vars does not resolve on the community edition.
console.log('Generating workflows with literal URLs for this instance:');
execFileSync(
  process.execPath,
  [
    'scripts/build-freight-workflows.mjs',
    `--base-url=${MPC}`,
    `--out=${WORKFLOW_DIR}`,
    ...(TEAMS_WEBHOOK ? [`--teams-webhook=${TEAMS_WEBHOOK}`] : []),
  ],
  { stdio: 'inherit' },
);
if (!TEAMS_WEBHOOK) {
  console.log('  (no TEAMS_WEBHOOK_URL: notification nodes stay placeholders)');
}
console.log('');

const settings = await waitForN8n();
await authenticate(settings);

console.log('\nCredentials:');
const automationId = await ensureCredential('MPC automation token', AUTOMATION_TOKEN);
const collectId = await ensureCredential('MPC collect token', COLLECT_TOKEN);

console.log('\nWorkflows:');
await importWorkflows(automationId, collectId);

console.log(`\nDone. Open ${N8N} and sign in as ${EMAIL}.`);
console.log('Workflows are imported inactive. Use "Test workflow" to run one by hand.');
