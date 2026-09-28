/**
 * Executes a workflow inside n8n and reports what each node did.
 *
 *   node scripts/n8n-run-workflow.mjs "MPC Freight - Deadline chaser"
 *
 * This is the real proof that the seam works: n8n itself makes the HTTP calls,
 * with its own credential, through its own expressions. Calling the endpoints
 * from a script only proves the endpoints work.
 */

import { createRequire } from 'node:module';

const N8N = (process.env.N8N_URL ?? 'http://localhost:5678').replace(/\/+$/, '');
/**
 * n8n serialises execution data with `flatted`, not JSON, so it can carry
 * circular references compactly. Borrow the copy from the n8n install.
 */
const N8N_HOME = process.env.N8N_HOME ?? 'C:/n8n-host';
let parseFlatted = null;
try {
  const req = createRequire(`${N8N_HOME}/package.json`);
  parseFlatted = req('flatted').parse;
} catch {
  parseFlatted = null;
}
const EMAIL = process.env.N8N_EMAIL ?? 'freight@mobilitypro.test';
const PASSWORD = process.env.N8N_PASSWORD ?? 'FreightRfq2026';
const WANTED = process.argv[2];

if (!WANTED) {
  console.error('Usage: node scripts/n8n-run-workflow.mjs "<workflow name>"');
  process.exit(1);
}

let cookie = '';

async function api(path, init = {}) {
  const res = await fetch(`${N8N}/rest${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'browser-id': 'freight-runner',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

const login = await api('/login', {
  method: 'POST',
  body: JSON.stringify({ emailOrLdapLoginId: EMAIL, password: PASSWORD }),
});
if (login.status >= 400) {
  console.error(`Could not sign in: ${JSON.stringify(login.body)}`);
  process.exit(1);
}

const list = await api('/workflows?includeScopes=true');
const summary = (list.body?.data ?? []).find((w) => w.name === WANTED);
if (!summary) {
  console.error(`No workflow called "${WANTED}". Found: ${(list.body?.data ?? []).map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const full = await api(`/workflows/${summary.id}`);
const wf = full.body?.data ?? full.body;

console.log(`Running "${wf.name}" (${wf.nodes.length} nodes)\n`);

// n8n 2.x refuses a manual run unless it is told where to start. These are
// schedule-triggered workflows, so name the trigger explicitly.
const trigger = wf.nodes.find((n) => n.type.endsWith('scheduleTrigger'));
if (!trigger) {
  console.error('That workflow has no schedule trigger to start from.');
  process.exit(1);
}

const run = await api(`/workflows/${summary.id}/run`, {
  method: 'POST',
  body: JSON.stringify({
    workflowData: { id: wf.id, name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings },
    triggerToStartFrom: { name: trigger.name },
  }),
});

if (run.status >= 400) {
  console.error(`Could not start it: ${run.status} ${JSON.stringify(run.body).slice(0, 300)}`);
  process.exit(1);
}

const executionId = run.body?.data?.executionId;
if (!executionId) {
  console.error(`No execution id came back: ${JSON.stringify(run.body).slice(0, 300)}`);
  process.exit(1);
}

// Poll until the execution finishes.
let execution = null;
for (let i = 0; i < 60; i++) {
  const res = await api(`/executions/${executionId}?includeData=true`);
  const data = res.body?.data ?? res.body;
  if (data && data.finished === true) {
    execution = data;
    break;
  }
  if (data && data.status && !['running', 'new', 'waiting'].includes(data.status)) {
    execution = data;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

if (!execution) {
  console.error('The execution did not finish within 60 seconds.');
  process.exit(1);
}

console.log(`status: ${execution.status}\n`);

let payload = execution.data;
if (typeof payload === 'string') {
  if (!parseFlatted) {
    console.log('(node detail unavailable: flatted not found; set N8N_HOME)');
    payload = null;
  } else {
    payload = parseFlatted(payload);
  }
}

const runData = payload?.resultData?.runData ?? {};
let failed = false;

for (const [nodeName, runs] of Object.entries(runData)) {
  for (const r of runs) {
    if (r.error) {
      failed = true;
      console.log(`  ERROR   ${nodeName}: ${r.error.message ?? JSON.stringify(r.error).slice(0, 160)}`);
      continue;
    }
    const items = r.data?.main?.[0] ?? [];
    const first = items[0]?.json;
    let detail = '';
    if (first && typeof first === 'object') {
      if ('statusCode' in first) {
        const inner = first.body;
        detail = `HTTP ${first.statusCode}`;
        if (inner && typeof inner === 'object') {
          if (inner.message) detail += ` — ${inner.message}`;
          else if (inner.data) detail += ` — ${JSON.stringify(inner.data).slice(0, 110)}`;
        }
      } else {
        detail = JSON.stringify(first).slice(0, 110);
      }
    }
    console.log(`  ran     ${nodeName}${detail ? `: ${detail}` : ''}`);
  }
}

const error = payload?.resultData?.error;
if (error) {
  failed = true;
  console.log(`\nWorkflow error: ${error.message ?? JSON.stringify(error).slice(0, 200)}`);
}

console.log('');
process.exit(failed || execution.status === 'error' ? 1 : 0);
