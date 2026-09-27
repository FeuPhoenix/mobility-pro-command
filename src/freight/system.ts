/**
 * System identities: work the application does on its own, not for a person.
 *
 * There is exactly one today, the Mailbox Collector. Scheduled collection has
 * no signed-in person behind it, but `ingestMessage` needs a `Ctx`, so the
 * collector acts under its own named identity. Its audit entries then say
 * "Mailbox Collector" rather than borrowing a manager's name.
 *
 * WHAT IT MAY DO
 * --------------
 * It reads every company, because one shared mailbox serves them all and a
 * reply must be matched against every open request to be filed correctly.
 * That is the only thing it does: `assertCanEdit` refuses it, `assertCanApprove`
 * refuses it, and it is never written to the users table, so `resolveCtx` and
 * the "Acting as" picker cannot select it.
 */

import { listAllCompanyIds, type Ctx } from './repo';

export const MAILBOX_COLLECTOR_ID = 'system_mailbox_collector';
export const MAILBOX_COLLECTOR_NAME = 'Mailbox Collector';

/** Built fresh for each run, so a company added since the last run is covered. */
export function mailboxCollectorCtx(): Ctx {
  return {
    user: {
      id: MAILBOX_COLLECTOR_ID,
      name: MAILBOX_COLLECTOR_NAME,
      title: 'System account - files replies from the shared mailbox',
      email: 'mailbox-collector@system.invalid',
      role: 'system_mailbox_collector',
      companyIds: listAllCompanyIds(),
    },
  };
}
