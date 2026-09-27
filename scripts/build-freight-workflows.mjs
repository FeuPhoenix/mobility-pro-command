/**
 * Generates the freight n8n workflow exports under public/n8n/.
 *
 * They are written by a script rather than by hand so the five stay consistent
 * with each other: same auth, same node style, same "the rule lives in the
 * application" notes. Re-run with `node scripts/build-freight-workflows.mjs`
 * after changing an endpoint path.
 *
 * The output is importable into a real n8n instance. Set two n8n variables
 * (`MPC_BASE_URL`) and a Header Auth credential carrying the bearer token.
 */

import { writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';

const OUT = 'public/n8n';

const node = (id, name, type, typeVersion, position, parameters, notes) => ({
  parameters,
  id,
  name,
  type,
  typeVersion,
  position,
  ...(notes ? { notes, notesInFlow: true } : {}),
});

const cron = (id, name, expression, position) =>
  node(id, name, 'n8n-nodes-base.scheduleTrigger', 1.2, position, {
    rule: { interval: [{ field: 'cronExpression', expression }] },
  });

const http = (id, name, method, path, position, notes) =>
  node(
    id,
    name,
    'n8n-nodes-base.httpRequest',
    4.2,
    position,
    {
      method,
      url: `={{ $vars.MPC_BASE_URL }}${path}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      // fullResponse so a failure can be branched on rather than thrown.
      options: { response: { response: { neverError: true, fullResponse: true } } },
    },
    notes,
  );

const iff = (id, name, position, leftValue, operation, rightValue, notes) =>
  node(
    id,
    name,
    'n8n-nodes-base.if',
    2.2,
    position,
    {
      conditions: {
        options: { caseSensitive: true, version: 2 },
        combinator: 'and',
        conditions: [{ operator: { type: 'number', operation }, leftValue, rightValue }],
      },
    },
    notes,
  );

const noop = (id, name, position, notes) =>
  node(id, name, 'n8n-nodes-base.noOp', 1, position, {}, notes);

/** n8n connections are keyed by node *name*; index 0 is true, 1 is false. */
const conn = (pairs) => {
  const c = {};
  for (const [from, to, outputIndex = 0] of pairs) {
    c[from] = c[from] ?? { main: [] };
    while (c[from].main.length <= outputIndex) c[from].main.push([]);
    c[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
  }
  return c;
};

const workflow = (name, nodes, connections, notes) => ({
  name,
  nodes,
  connections,
  // Imports land switched off. A workflow that starts running the moment it is
  // imported would chase providers from someone's test instance.
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [{ name: 'Mobility Pro Command' }, { name: 'Freight RFQ' }],
  notes,
});

const write = (file, wf) => {
  writeFileSync(`${OUT}/${file}`, `${JSON.stringify(wf, null, 2)}\n`);
  console.log(`${file.padEnd(38)} ${String(wf.nodes.length).padStart(2)} nodes  ${wf.name}`);
};

/* ----------------------------- 1. Reply collection ---------------------------- */

write(
  'freight-reply-collection.json',
  workflow(
    'MPC Freight - Reply collection',
    [
      cron('frc-01', 'Every 15 minutes', '*/15 * * * *', [260, 300]),
      http(
        'frc-02',
        'Collect replies',
        'POST',
        '/api/freight/collect',
        [480, 300],
        'Reads the shared mailbox and files replies. Matching, extraction and revision handling all happen in the application. This endpoint uses MAILBOX_COLLECT_TOKEN, not the automation token.',
      ),
      iff(
        'frc-03',
        'Did it fail?',
        [700, 300],
        '={{ $json.statusCode }}',
        'gte',
        400,
        'Only a transport or configuration failure reaches here. A reply that cannot be matched is a normal outcome: it waits in the review queue for a person.',
      ),
      noop(
        'frc-04',
        'Raise to operations',
        [920, 220],
        'Wire to Slack or email. Do not add a blind retry: collection already advances its cursor only after a page is filed, and a lease stops overlapping runs.',
      ),
      noop('frc-05', 'Done', [920, 400]),
    ],
    conn([
      ['Every 15 minutes', 'Collect replies'],
      ['Collect replies', 'Did it fail?'],
      ['Did it fail?', 'Raise to operations', 0],
      ['Did it fail?', 'Done', 1],
    ]),
    'Collection is idempotent on the transport message id, so repeated or overlapping runs file nothing twice.',
  ),
);

/* ----------------------------- 2. Deadline chaser ----------------------------- */

write(
  'freight-deadline-chaser.json',
  workflow(
    'MPC Freight - Deadline chaser',
    [
      cron('fdc-01', 'Every weekday at 09:00', '0 9 * * 1-5', [260, 300]),
      http(
        'fdc-02',
        'Who is due a chase?',
        'GET',
        '/api/freight/automation/reminders',
        [480, 300],
        'The application decides who is due, using the reminder policy in Settings. This workflow supplies the clock, never the judgement. Each provider comes back with the reason.',
      ),
      iff('fdc-03', 'Anyone due?', [700, 300], '={{ $json.body.data.providersDue }}', 'gt', 0),
      http(
        'fdc-04',
        'Prepare the reminders',
        'POST',
        '/api/freight/automation/reminders',
        [920, 220],
        'Creates DRAFT reminders only. It cannot send: the automation identity is refused by both assertCanApprove and assertCanSend. Every draft waits in the manager approval queue.',
      ),
      noop(
        'fdc-05',
        'Tell the manager they are waiting',
        [1140, 220],
        'Wire to Slack or email. The message must say reminders are waiting for approval - never that they were sent.',
      ),
      noop('fdc-06', 'Nothing due', [920, 400]),
    ],
    conn([
      ['Every weekday at 09:00', 'Who is due a chase?'],
      ['Who is due a chase?', 'Anyone due?'],
      ['Anyone due?', 'Prepare the reminders', 0],
      ['Prepare the reminders', 'Tell the manager they are waiting'],
      ['Anyone due?', 'Nothing due', 1],
    ]),
    'This workflow never sends. Preparing the same reminder twice is refused by the application and reported as a skip, not an error.',
  ),
);

/* ------------------------------ 3. Approval nudge ----------------------------- */

write(
  'freight-approval-nudge.json',
  workflow(
    'MPC Freight - Approval nudge',
    [
      cron('fan-01', 'Every three hours in office hours', '0 8-18/3 * * 1-5', [260, 300]),
      http(
        'fan-02',
        'What is waiting for approval?',
        'GET',
        '/api/freight/automation/approvals',
        [480, 300],
        'Read-only. Includes approvals that lapsed because the email was edited after being approved, which are the easiest ones to miss.',
      ),
      iff('fan-03', 'Anything waiting?', [700, 300], '={{ $json.body.data.count }}', 'gt', 0),
      noop(
        'fan-04',
        'Nudge the manager',
        [920, 220],
        'Wire to Slack or email. Link to /freight: approving has to happen in the application, where the recipients and the body are visible.',
      ),
      noop('fan-05', 'Queue is clear', [920, 400]),
    ],
    conn([
      ['Every three hours in office hours', 'What is waiting for approval?'],
      ['What is waiting for approval?', 'Anything waiting?'],
      ['Anything waiting?', 'Nudge the manager', 0],
      ['Anything waiting?', 'Queue is clear', 1],
    ]),
    'Notification only. Nothing here can approve or send an email.',
  ),
);

/* ------------------------------ 4. ERPNext retry ------------------------------ */

write(
  'freight-erpnext-retry.json',
  workflow(
    'MPC Freight - ERPNext retry',
    [
      cron('fer-01', 'Every hour', '0 * * * *', [260, 300]),
      http(
        'fer-02',
        'What has not been recorded?',
        'GET',
        '/api/freight/automation/erpnext',
        [480, 300],
        'Separates records that can be retried from those blocked on missing setup.',
      ),
      iff('fer-03', 'Anything retryable?', [700, 300], '={{ $json.body.data.retryable }}', 'gt', 0),
      http(
        'fer-04',
        'Retry them',
        'POST',
        '/api/freight/automation/erpnext',
        [920, 220],
        'Each record carries a stable idempotency key, so a retry updates rather than duplicates. Records blocked on setup are skipped deliberately - retrying those on a timer would fail forever and bury the real message.',
      ),
      iff('fer-05', 'Still failing?', [1140, 220], '={{ $json.body.ok ? 0 : 1 }}', 'gt', 0),
      noop(
        'fer-06',
        'Raise to operations',
        [1360, 140],
        'A record that keeps failing needs a person. Do not tighten the schedule.',
      ),
      noop('fer-07', 'Recovered', [1360, 300]),
      noop('fer-08', 'Nothing to retry', [920, 400]),
    ],
    conn([
      ['Every hour', 'What has not been recorded?'],
      ['What has not been recorded?', 'Anything retryable?'],
      ['Anything retryable?', 'Retry them', 0],
      ['Retry them', 'Still failing?'],
      ['Still failing?', 'Raise to operations', 0],
      ['Still failing?', 'Recovered', 1],
      ['Anything retryable?', 'Nothing to retry', 1],
    ]),
    'While the ERPNext adapter is simulated, nothing is written to ERPNext and the response says so. Never treat a simulated success as a live write.',
  ),
);

/* ------------------------------ 5. Daily briefing ----------------------------- */

write(
  'freight-daily-briefing.json',
  workflow(
    'MPC Freight - Daily briefing',
    [
      cron('fdb-01', 'Every weekday at 08:00', '0 8 * * 1-5', [260, 300]),
      http(
        'fdb-02',
        'Freight summary',
        'GET',
        '/api/freight/automation/summary',
        [480, 300],
        'One call. The counts come from the same read model the Overview screen uses, so the briefing and the screen can never disagree.',
      ),
      iff(
        'fdb-03',
        'Anything worth reporting?',
        [700, 300],
        '={{ $json.body.data.awaitingApproval + $json.body.data.staleApprovals + $json.body.data.providersDueAChase + $json.body.data.quotesToCheck + $json.body.data.repliesToMatch + $json.body.data.comparisonsReady + $json.body.data.erpNeedsAttention + $json.body.data.deadlinesWithin24h.length }}',
        'gt',
        0,
        'A briefing that says "nothing to do" every morning stops being read. Post only when there is something.',
      ),
      noop(
        'fdb-04',
        'Post the briefing',
        [920, 220],
        'Wire to Slack or email. Lead with deadlines inside 24 hours and anything waiting for approval.',
      ),
      noop('fdb-05', 'Quiet day, stay silent', [920, 400]),
    ],
    conn([
      ['Every weekday at 08:00', 'Freight summary'],
      ['Freight summary', 'Anything worth reporting?'],
      ['Anything worth reporting?', 'Post the briefing', 0],
      ['Anything worth reporting?', 'Quiet day, stay silent', 1],
    ]),
    'Read-only.',
  ),
);

/* --------------------------------- Validation --------------------------------- */

/**
 * A workflow that points at an endpoint which does not exist is worse than no
 * workflow: it fails silently at 3am in someone else's instance. So every
 * generated file is checked before this script exits.
 */
let problems = 0;
const fail = (msg) => {
  console.error(`  PROBLEM  ${msg}`);
  problems += 1;
};

console.log('');
console.log('Validating:');
for (const file of readdirSync(OUT).filter((f) => f.startsWith('freight-'))) {
  const wf = JSON.parse(readFileSync(`${OUT}/${file}`, 'utf8'));
  const names = new Set(wf.nodes.map((n) => n.name));

  // Every connection must join two nodes that exist.
  for (const [from, value] of Object.entries(wf.connections)) {
    if (!names.has(from)) fail(`${file}: connection from unknown node "${from}"`);
    for (const output of value.main) {
      for (const link of output) {
        if (!names.has(link.node)) fail(`${file}: connection to unknown node "${link.node}"`);
      }
    }
  }

  // Every node except the trigger must be reachable.
  const reached = new Set();
  const walk = (name) => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const output of wf.connections[name]?.main ?? []) {
      for (const link of output) walk(link.node);
    }
  };
  if (wf.active !== false) fail(`${file}: must be exported inactive`);
  if (wf.nodes.length < 4) fail(`${file}: fewer than 4 nodes`);

  const trigger = wf.nodes.find((n) => n.type.endsWith('scheduleTrigger'));
  if (!trigger) fail(`${file}: no trigger`);
  else walk(trigger.name);
  for (const n of wf.nodes) {
    if (!reached.has(n.name)) fail(`${file}: "${n.name}" is not reachable from the trigger`);
  }

  // Every URL must resolve to a route that actually exists in this repository.
  for (const n of wf.nodes) {
    const url = n.parameters?.url;
    if (typeof url !== 'string') continue;
    const path = url.replace('={{ $vars.MPC_BASE_URL }}', '');
    if (!existsSync(`src/app${path}/route.ts`)) fail(`${file}: no route for ${path}`);
    else console.log(`  ok  ${file.padEnd(34)} ${n.parameters.method.padEnd(4)} ${path}`);
  }
}

if (problems > 0) {
  console.error(`${problems} problem(s).`);
  process.exit(1);
}
console.log('');
console.log('All workflows valid; every endpoint they call exists.');
