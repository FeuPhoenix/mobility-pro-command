/**
 * Go-live readiness: the checklist in docs/FREIGHT_GO_LIVE.md, as far as the
 * application can check it itself.
 *
 * Each check says what it found and what to do, in plain language. Nothing
 * here changes anything, and nothing secret is reported - only whether a value
 * is set and whether a connection check succeeded.
 *
 * A "fail" is something that must not be true on a production workspace (demo
 * sign-in, demo data, email not really connected). A "warn" is something to
 * confirm (a backup this old, the operations demo still served).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, db, getSetting } from './db';
import { listAllCompanyIds, listUsers } from './repo';
import { authMode, entraConfig } from './auth/config';
import { needsFirstRunSetup } from './auth/password';
import { integrationStatus } from './view';
import { operationsDemoEnabled } from '../operationsDemo';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface ReadinessCheck {
  id: string;
  area: 'Sign-in' | 'Data' | 'Email' | 'ERPNext' | 'Operations';
  status: CheckStatus;
  title: string;
  detail: string;
}

export interface Readiness {
  ready: boolean;
  counts: Record<CheckStatus, number>;
  checks: ReadinessCheck[];
}

/** How recent the newest backup must be. A nightly job plus some slack. */
const BACKUP_MAX_AGE_HOURS = 36;

function newestBackup(dir: string): { name: string; ageHours: number } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^freight-.*\.db$/.test(f));
  let best: { name: string; mtime: number } | null = null;
  for (const f of files) {
    const mtime = statSync(path.join(dir, f)).mtimeMs;
    if (!best || mtime > best.mtime) best = { name: f, mtime };
  }
  return best ? { name: best.name, ageHours: (Date.now() - best.mtime) / 3_600_000 } : null;
}

/** Addresses in reserved domains that cannot receive mail: demonstration data. */
function demoAddressCount(): number {
  const q = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
  const reserved = "(lower(email) LIKE '%.test' OR lower(email) LIKE '%.invalid' OR lower(email) LIKE '%.example')";
  return (
    q(`SELECT count(*) AS n FROM provider_contacts WHERE ${reserved}`) +
    q(`SELECT count(*) AS n FROM providers WHERE ${reserved.replace(/email/g, 'general_email')}`) +
    q(`SELECT count(*) AS n FROM users WHERE ${reserved}`)
  );
}

export function checkReadiness(env: NodeJS.ProcessEnv = process.env): Readiness {
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);
  const mode = authMode();
  const people = listUsers().filter((u) => !u.disabled);
  const managers = people.filter((u) => u.role === 'logistics_manager');

  /* -------------------------------- Sign-in -------------------------------- */

  if (mode === 'demo') {
    add({
      id: 'auth.mode', area: 'Sign-in', status: 'fail', title: 'Sign-in is off (demonstration mode)',
      detail: 'Anyone who can reach the server can act as anyone. Set AUTH_MODE=entra (Sign in with Microsoft) or AUTH_MODE=password.',
    });
  } else if (mode === 'entra') {
    const { config, problems } = entraConfig();
    add(
      config
        ? { id: 'auth.mode', area: 'Sign-in', status: 'ok', title: 'Sign in with Microsoft is on and configured', detail: 'Only people on the People list can sign in.' }
        : { id: 'auth.mode', area: 'Sign-in', status: 'fail', title: 'Sign in with Microsoft is on but incomplete', detail: problems.join(' ') },
    );
    if (config?.bootstrapAdminEmail && managers.length > 0) {
      add({
        id: 'auth.bootstrap', area: 'Sign-in', status: 'warn', title: 'Remove AUTH_BOOTSTRAP_ADMIN_EMAIL',
        detail: 'A manager exists, so it no longer does anything. Remove it from the environment and restart.',
      });
    }
  } else {
    add(
      needsFirstRunSetup()
        ? { id: 'auth.mode', area: 'Sign-in', status: 'fail', title: 'Password sign-in has no account yet', detail: 'Open the sign-in page and complete first-run setup.' }
        : { id: 'auth.mode', area: 'Sign-in', status: 'ok', title: 'Password sign-in is on', detail: 'Accounts sign in with a password held here, hashed with scrypt.' },
    );
  }

  const base = entraConfig().config?.baseUrl ?? env.AUTH_BASE_URL ?? '';
  const secure = env.FREIGHT_FORCE_SECURE_COOKIES === 'true' || base.startsWith('https://');
  add(
    secure
      ? { id: 'auth.https', area: 'Sign-in', status: 'ok', title: 'Session cookies are sent over HTTPS only', detail: env.FREIGHT_FORCE_SECURE_COOKIES === 'true' ? 'FREIGHT_FORCE_SECURE_COOKIES=true.' : 'AUTH_BASE_URL is https.' }
      : { id: 'auth.https', area: 'Sign-in', status: 'warn', title: 'Confirm HTTPS in front of the application', detail: 'Either the proxy sets x-forwarded-proto: https, or set FREIGHT_FORCE_SECURE_COOKIES=true.' },
  );

  if (env.FREIGHT_MODE_SWITCH === 'on') {
    add({
      id: 'auth.modeSwitch', area: 'Sign-in', status: 'warn', title: 'The demo/production switch is on',
      detail: 'A signed-in manager can switch this server to the anonymous demonstration workspace. Production data is not exposed by it, but on a server people rely on, remove FREIGHT_MODE_SWITCH and restart.',
    });
  }

  /* --------------------------------- Data ---------------------------------- */

  const demoData = getSetting<boolean>('demo.mode', false);
  const reserved = demoAddressCount();
  add(
    demoData || reserved > 0
      ? {
          id: 'data.demo', area: 'Data', status: 'fail', title: 'Demonstration data is in this workspace',
          detail: `${demoData ? 'The demonstration dataset was loaded. ' : ''}${reserved > 0 ? `${reserved} address${reserved === 1 ? '' : 'es'} use a reserved domain (.test, .invalid, .example) that cannot receive mail. ` : ''}Start production from an empty data folder, then add the real companies, providers and people.`,
        }
      : { id: 'data.demo', area: 'Data', status: 'ok', title: 'No demonstration data', detail: 'No demo flag and no reserved-domain addresses.' },
  );

  const companies = listAllCompanyIds().length;
  add(
    companies > 0
      ? { id: 'data.companies', area: 'Data', status: 'ok', title: `${companies} compan${companies === 1 ? 'y' : 'ies'} set up`, detail: 'Providers and people are held per company.' }
      : { id: 'data.companies', area: 'Data', status: 'fail', title: 'No companies yet', detail: 'Add each company on Providers before anything else.' },
  );

  add(
    managers.length === 0
      ? { id: 'data.people', area: 'Data', status: 'fail', title: 'No Logistics Operations Manager', detail: 'Nobody could approve an email. Add at least one on Settings -> People.' }
      : managers.length === 1
        ? { id: 'data.people', area: 'Data', status: 'warn', title: 'Only one manager can approve email', detail: `${people.length} people in total. With one manager, approvals stop when they are away. Consider a second.` }
        : { id: 'data.people', area: 'Data', status: 'ok', title: `${people.length} people, ${managers.length} managers`, detail: 'More than one person can approve email.' },
  );

  add(
    env.FREIGHT_DATA_DIR
      ? { id: 'data.folder', area: 'Data', status: 'ok', title: 'The data folder is set explicitly', detail: 'FREIGHT_DATA_DIR is set. Make sure it is on a persistent, backed-up disk.' }
      : { id: 'data.folder', area: 'Data', status: 'warn', title: 'The data folder is the default one inside the application', detail: 'Set FREIGHT_DATA_DIR to a persistent, backed-up disk, so an update or redeploy cannot replace it.' },
  );

  const backup = newestBackup(path.join(DATA_DIR, 'backups'));
  add(
    !backup
      ? { id: 'data.backup', area: 'Data', status: 'fail', title: 'No backup found', detail: 'Schedule node scripts/backup.mjs nightly, copy the backups off the server, and restore-test one with node scripts/restore.mjs --check.' }
      : backup.ageHours > BACKUP_MAX_AGE_HOURS
        ? { id: 'data.backup', area: 'Data', status: 'warn', title: `The newest backup is ${Math.round(backup.ageHours)} hours old`, detail: `${backup.name}. Check the nightly schedule is running.` }
        : { id: 'data.backup', area: 'Data', status: 'ok', title: 'A recent backup exists', detail: `${backup.name}, ${Math.round(backup.ageHours)} hours old. Backups kept only on this disk do not survive losing it; copy them elsewhere.` },
  );

  /* ------------------------------ Integrations ----------------------------- */

  const i = integrationStatus();
  add(
    i.mail.kind !== 'graph'
      ? { id: 'email.send', area: 'Email', status: 'fail', title: 'Email is simulated', detail: 'Approved email is recorded but never sent. Set MAIL_ADAPTER=graph with the Graph app registration (docs/FREIGHT_W2_LIVE_TEST.md).' }
      : i.mail.connected
        ? { id: 'email.send', area: 'Email', status: 'ok', title: 'Outgoing email is connected', detail: i.mail.detail }
        : { id: 'email.send', area: 'Email', status: 'fail', title: 'Outgoing email is not connected', detail: 'Press Check connection on Settings -> Connections. ' + i.mail.detail },
  );
  add(
    i.mailbox.kind !== 'graph'
      ? { id: 'email.collect', area: 'Email', status: 'fail', title: 'Reply collection reads a simulated mailbox', detail: 'Set MAILBOX_ADAPTER=graph.' }
      : i.mailbox.connected
        ? { id: 'email.collect', area: 'Email', status: 'ok', title: 'The mailbox is connected', detail: i.mailbox.detail }
        : { id: 'email.collect', area: 'Email', status: 'fail', title: 'The mailbox is not connected', detail: 'Press Check connection on Settings -> Connections. ' + i.mailbox.detail },
  );
  const scheduled = Boolean(i.collection.pollSeconds || i.collection.externalTrigger || env.FREIGHT_AUTOMATION_TOKEN);
  add(
    scheduled
      ? { id: 'email.schedule', area: 'Email', status: 'ok', title: 'Reply collection is scheduled', detail: i.collection.pollSeconds ? `Every ${i.collection.pollSeconds} seconds.` : 'An external scheduler can trigger it.' }
      : { id: 'email.schedule', area: 'Email', status: 'warn', title: 'Reply collection is not scheduled', detail: 'Replies arrive only when someone presses Collect now. Set MAILBOX_POLL_SECONDS, or a token for an external scheduler.' },
  );

  add(
    i.erp.kind !== 'live'
      ? { id: 'erp.write', area: 'ERPNext', status: 'fail', title: 'ERPNext is simulated', detail: 'Nothing is written to ERPNext. Set ERPNEXT_ADAPTER=live once the destination DocType exists (docs/FREIGHT_ERPNEXT.md).' }
      : i.erp.connected && i.erp.setupRequirements.length === 0
        ? { id: 'erp.write', area: 'ERPNext', status: 'ok', title: 'ERPNext is connected and the destination is ready', detail: i.erp.detail }
        : { id: 'erp.write', area: 'ERPNext', status: 'fail', title: 'ERPNext is not ready', detail: [i.erp.detail, ...i.erp.setupRequirements].join(' ') },
  );

  /* ------------------------------- Operations ------------------------------ */

  add(
    operationsDemoEnabled(env)
      ? { id: 'ops.demo', area: 'Operations', status: 'warn', title: 'The operations demo is still served', detail: 'It is fictional and has no sign-in. Set OPERATIONS_DEMO=off unless it should be reachable on this address.' }
      : { id: 'ops.demo', area: 'Operations', status: 'ok', title: 'The operations demo is switched off', detail: 'Its pages and APIs answer 404; "/" opens the freight workspace.' },
  );

  const counts = { ok: 0, warn: 0, fail: 0 } as Record<CheckStatus, number>;
  for (const c of checks) counts[c.status] += 1;
  return { ready: counts.fail === 0, counts, checks };
}
