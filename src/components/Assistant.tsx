'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useDemo } from './DemoProvider';
import { Icon, Pill, RefChip } from './ui';
import { SUGGESTED_QUESTIONS, type AssistantAnswer, type AssistantContext } from '@/domain/assistant';
import type { Action } from '@/server/actions';

/** Derives "what am I looking at" from the URL. */
export function useAssistantContext(): AssistantContext {
  const pathname = usePathname();
  const params = useSearchParams();

  return useMemo(() => {
    const seg = pathname.split('/').filter(Boolean);
    if (seg[0] === 'operations' && seg[1] === 'documents' && seg[2]) {
      return { type: 'document', id: decodeURIComponent(seg[2]), path: pathname };
    }
    if (seg[0] === 'operations' && seg[1] === 'inventory' && seg[2]) {
      return { type: 'opportunity', id: decodeURIComponent(seg[2]), path: pathname };
    }
    if (seg[0] === 'operations' && seg[1] === 'orders' && seg[2]) {
      return { type: 'salesOrder', id: decodeURIComponent(seg[2]), path: pathname };
    }
    if (seg[0] === 'customers' && seg[1]) {
      return { type: 'customer', id: decodeURIComponent(seg[1]), path: pathname };
    }
    if (seg[0] === 'approvals') {
      const focus = params.get('focus');
      return focus ? { type: 'approval', id: focus, path: pathname } : { path: pathname };
    }
    return { path: pathname };
  }, [pathname, params]);
}

function contextLabel(ctx: AssistantContext): string {
  if (!ctx.type) return 'No record open — answering across the whole workspace.';
  const nice: Record<string, string> = {
    document: 'supplier document',
    case: 'discrepancy case',
    shipment: 'shipment',
    opportunity: 'inventory opportunity',
    salesOrder: 'sales order',
    customer: 'customer',
    sku: 'SKU',
    approval: 'approval request',
  };
  return `Context: ${nice[ctx.type] ?? ctx.type} ${ctx.id ?? ''}`;
}

export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const { dispatch, state } = useDemo();
  const ctx = useAssistantContext();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [thinking, setThinking] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setThinking(true);
      setQuestion('');
      setHistory((h) => [trimmed, ...h].slice(0, 6));
      try {
        const res = await fetch('/api/assistant', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, question: trimmed, context: ctx }),
        });
        const data = await res.json();
        setAnswer(data.answer as AssistantAnswer);
      } finally {
        setThinking(false);
        requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
      }
    },
    [ctx, state],
  );

  return (
    <aside className="assistant" role="complementary" aria-label="Contextual assistant">
      <div className="assistant-head">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 7 }}>
            <h2 style={{ fontSize: 14 }}>Assistant</h2>
            <Pill tone="warn">Simulated</Pill>
          </div>
          <div className="tiny muted" style={{ marginTop: 2 }}>
            Deterministic rules over the demo dataset. No model credentials.
          </div>
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onClose} aria-label="Close assistant">
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="assistant-body" ref={bodyRef}>
        <div className="ctx-chip">{contextLabel(ctx)}</div>

        {!answer && !thinking ? (
          <>
            <p className="small muted">
              Ask about what is on screen. Answers separate observed facts, deterministic
              calculations, assumptions and a recommendation — and link to the records behind them.
            </p>
            <div className="row" style={{ gap: 6 }}>
              {SUGGESTED_QUESTIONS.map((q) => (
                <button key={q} className="q-chip" onClick={() => void send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {thinking ? (
          <div className="stack" aria-live="polite">
            <div className="skel" style={{ height: 14, width: '70%' }} />
            <div className="skel" style={{ height: 44 }} />
            <div className="skel" style={{ height: 44 }} />
          </div>
        ) : null}

        {answer && !thinking ? (
          <div className="stack" aria-live="polite">
            <div>
              <div className="eyebrow">Answer</div>
              <h3 style={{ fontSize: 15, marginTop: 4, lineHeight: 1.4 }}>{answer.headline}</h3>
            </div>

            {answer.bands.map((band) => (
              <div className="a-band" data-kind={band.kind} key={band.kind + band.title}>
                <h4>{band.title}</h4>
                <ul>
                  {band.items.filter(Boolean).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}

            {answer.refs.length ? (
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>Records referenced</div>
                <div className="row" style={{ gap: 6 }}>
                  {answer.refs.map((r, i) => (
                    <RefChip key={`${r.type}-${r.id}-${i}`} refItem={r} />
                  ))}
                </div>
              </div>
            ) : null}

            {answer.actions.length ? (
              <div className="card" style={{ background: 'var(--surface-2)' }}>
                <div className="card-body tight stack" style={{ gap: 10 }}>
                  <div>
                    <div className="eyebrow">Action preview</div>
                    <div className="tiny muted" style={{ marginTop: 3 }}>
                      Nothing has happened yet. Confirming runs the same validated action as the
                      button in the main workspace, with the same authorisation checks.
                    </div>
                  </div>
                  {answer.actions.map((a, i) => (
                    <div key={i} className="stack" style={{ gap: 5 }}>
                      <div className="small">{a.description}</div>
                      {a.requires ? (
                        <div className="tiny muted">Routed to: {a.requires}</div>
                      ) : null}
                      <button
                        className="btn primary sm"
                        onClick={async () => {
                          const r = await dispatch(a.action as unknown as Action);
                          if (r.ok) await send(question || 'What needs my attention today?');
                        }}
                      >
                        {a.label}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <button className="btn ghost sm" onClick={() => setAnswer(null)} style={{ alignSelf: 'flex-start' }}>
              Ask something else
            </button>
          </div>
        ) : null}

        {history.length && answer ? (
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Recent</div>
            <div className="row" style={{ gap: 6 }}>
              {history.slice(1).map((h, i) => (
                <button key={i} className="q-chip" onClick={() => void send(h)}>
                  {h}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <form
        className="assistant-foot"
        onSubmit={(e) => {
          e.preventDefault();
          void send(question);
        }}
      >
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <input
            ref={inputRef}
            className="input"
            placeholder="Ask about this record…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            aria-label="Ask the assistant"
          />
          <button className="btn primary" type="submit" disabled={thinking || !question.trim()}>
            Ask
          </button>
        </div>
      </form>
    </aside>
  );
}
