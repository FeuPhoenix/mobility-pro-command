'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDemo } from './DemoProvider';
import { Icon } from './ui';

export interface GuideStep {
  /** Which part of the story this step belongs to, shown as an eyebrow. */
  chapter: string;
  title: string;
  /** What is happening and why it matters. Two or three sentences at most. */
  body: string;
  /** Specific things to look at on this screen. */
  look?: string[];
  /** The one thing to do before moving on. */
  tryThis?: string;
  href: string;
  cta: string;
}

export const GUIDE_STEPS: GuideStep[] = [
  {
    chapter: '1 · Start here',
    title: 'See what needs attention today',
    body: 'This page brings the important problems to the team instead of making people search through the ERP. Each card says what happened, who owns it and what money may be affected.',
    look: [
      'Problems are ordered by urgency.',
      'The name on each card shows who should act.',
    ],
    tryThis: 'Start with the supplier document at the top of the list.',
    href: '/',
    cta: 'See today’s problems',
  },
  {
    chapter: '2 · Supplier document',
    title: 'The invoice does not match the order',
    body: 'The supplier invoice has four important differences from what the company ordered. The shipment is paused so the warehouse does not accept the wrong goods or terms by mistake.',
    look: [
      'The screen shows the invoice value beside the ordered value.',
      'It explains every difference in normal language.',
    ],
    tryThis: 'Scroll through the highlighted differences and the original invoice.',
    href: '/operations/documents/DOC-PI-0418-R1',
    cta: 'Open the document',
  },
  {
    chapter: '3 · Old stock',
    title: 'Find stock that is not selling',
    body: 'There are 812 tyres at the Obour warehouse that have been sitting for 215 days. Recent sales have also slowed down, so the business may want to hold, move or discount this stock.',
    look: [
      'Known facts are kept separate from guesses about future sales.',
      'Changing the quantity or discount updates the numbers.',
    ],
    tryThis: 'Compare the hold, transfer and discount choices.',
    href: '/operations/inventory/OPP-2026-014',
    cta: 'Open the stock problem',
  },
  {
    chapter: '4 · Customer order',
    title: 'Turn an idea into an order',
    body: 'After choosing a customer, quantity and price, the proposed sale appears here. Before anything is released, the system checks the price, available stock and the customer’s payment position.',
    look: [
      'Draft orders do not reserve stock yet.',
      'Every order shows its value and expected profit separately.',
    ],
    tryThis: 'Open the Minya Motors order marked “Blocked - credit”.',
    href: '/operations/orders',
    cta: 'See the orders',
  },
  {
    chapter: '5 · Credit check',
    title: 'Explain why the order is paused',
    body: 'The stock and price checks pass, but this sale would take Minya Motors above its credit limit. The screen shows the full calculation and offers three safe ways to continue.',
    look: [
      'The reason for the block is visible, not hidden in a score.',
      'Options include a deposit, a smaller release or finance review.',
    ],
    tryThis: 'Review the numbers and the three ways forward.',
    href: '/operations/orders/SO-2026-0766',
    cta: 'Open the credit check',
  },
  {
    chapter: '6 · Manager decision',
    title: 'Send unusual decisions to the right person',
    body: 'If an order needs an exception, it goes to the manager who has authority to decide. The manager sees the reason, the amount and the effect before approving or rejecting it.',
    look: [
      'The person who requested approval cannot approve it themselves.',
      'The decision is saved in the activity history.',
    ],
    tryThis: 'Approval requests appear here after one is created from an order.',
    href: '/approvals',
    cta: 'See approvals',
  },
  {
    chapter: '7 · n8n automation',
    title: 'Let n8n handle the repetitive work',
    body: 'This demo is not connected to n8n. It includes seven real, importable workflows showing how n8n can read mail, check ERPNext, send alerts and remind approvers while this app keeps the business rules.',
    look: [
      'Choose a workflow to see its trigger and steps.',
      'Every run shown here is clearly marked as simulated.',
    ],
    tryThis: 'Open “Supplier document intake” and follow its six steps.',
    href: '/automations',
    cta: 'See the n8n workflows',
  },
  {
    chapter: '8 · The whole story',
    title: 'Spot, explain, decide and follow up',
    body: 'The app finds the problem, explains it and sends the decision to the right person. ERPNext keeps the company records, while n8n can move information and send reminders around the decision.',
    look: [
      'No live ERPNext or n8n account is connected in this demo.',
      'Use Reset demo whenever you want to start the story again.',
    ],
    tryThis: 'Return to the overview or press Reset demo to run the tour again.',
    href: '/',
    cta: 'Return to overview',
  },
];

export function GuidedDemo() {
  const { state, dispatch } = useDemo();
  const router = useRouter();
  const step = state?.meta.guidedStep ?? null;
  if (step === null || !state) return null;

  const current = GUIDE_STEPS[step];
  if (!current) return null;

  const go = async (next: number | null) => {
    await dispatch({ type: 'demo.setGuidedStep', step: next });
    if (next !== null && GUIDE_STEPS[next]) router.push(GUIDE_STEPS[next].href);
  };

  return (
    <div className="guide" role="region" aria-label="Guided demo">
      <div className="guide-head">
        <Icon name="play" size={14} />
        <span className="step">
          {step + 1} of {GUIDE_STEPS.length}
        </span>
        <span className="guide-chapter">{current.chapter}</span>
        <div style={{ flex: 1 }} />
        <button
          className="btn ghost sm"
          style={{ color: '#b9cadb' }}
          onClick={() => void go(null)}
          aria-label="Exit guided demo"
        >
          Exit
        </button>
      </div>

      <div className="guide-progress">
        <i style={{ width: `${((step + 1) / GUIDE_STEPS.length) * 100}%` }} />
      </div>

      <div className="guide-body">
        <h4>{current.title}</h4>
        <p>{current.body}</p>

        {current.look?.length ? (
          <div className="guide-look">
            <span className="eyebrow">What to notice</span>
            <ul>
              {current.look.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {current.tryThis ? (
          <div className="guide-try">
            <span className="eyebrow">Try this</span>
            <p>{current.tryThis}</p>
          </div>
        ) : null}
      </div>

      <div className="guide-foot">
        <button className="btn sm" onClick={() => void go(Math.max(0, step - 1))} disabled={step === 0}>
          Back
        </button>
        <Link className="btn sm" href={current.href}>
          {current.cta}
        </Link>
        <div style={{ flex: 1 }} />
        {step < GUIDE_STEPS.length - 1 ? (
          <button className="btn primary sm" onClick={() => void go(step + 1)}>
            Next
          </button>
        ) : (
          <button className="btn primary sm" onClick={() => void go(null)}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
