import { NextResponse } from 'next/server';
import { parseEml, UnreadableEml } from '@/freight/parsers/eml';
import { ingestMessage } from '@/freight/service/inbox';
import { FreightError } from '@/freight/repo';
import { resolveCtx } from '@/freight/session';
import { validateUpload, FileError, MAX_ATTACHMENT_BYTES } from '@/freight/files';

export const dynamic = 'force-dynamic';

/**
 * Loads a `.eml` file as though it had arrived in the mailbox.
 *
 * It goes through the same `ingestMessage` the live collector uses, so the
 * matcher, the extractor and the revision handling all behave exactly as they
 * would on a real reply. That is the point: this is for checking extraction
 * against real quotations before anything is wired to a live mailbox.
 *
 * Attachments the system does not accept are reported, not dropped silently.
 */
export async function POST(request: Request) {
  try {
    const ctx = await resolveCtx();
    const form = await request.formData();
    const files = form.getAll('file').filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ ok: false, error: 'Attach one or more .eml files.' }, { status: 400 });
    }

    const results: {
      filename: string;
      ok: boolean;
      matched?: string;
      subject?: string;
      from?: string;
      quoteId?: string | null;
      note?: string | null;
      warnings?: string[];
      error?: string;
    }[] = [];

    for (const file of files) {
      if (!/\.eml$/i.test(file.name)) {
        results.push({
          filename: file.name,
          ok: false,
          error: /\.msg$/i.test(file.name)
            ? '.msg is an Outlook-only format this reader cannot open. Export the message as .eml instead.'
            : 'Only .eml files can be loaded here.',
        });
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        results.push({ filename: file.name, ok: false, error: 'That file is too large.' });
        continue;
      }

      try {
        const parsed = parseEml(Buffer.from(await file.arrayBuffer()));

        // Only attachments the system can actually read are carried through;
        // the rest are reported so nobody assumes they were considered.
        const accepted: { filename: string; content: Buffer }[] = [];
        const rejected: string[] = [];
        for (const a of parsed.attachments) {
          try {
            validateUpload(a.filename, a.content.byteLength);
            accepted.push({ filename: a.filename, content: a.content });
          } catch (err) {
            rejected.push(`${a.filename}: ${err instanceof Error ? err.message : 'not accepted'}`);
          }
        }

        const outcome = await ingestMessage(ctx, {
          // The real Message-ID keeps this idempotent: loading the same file
          // twice cannot create the quotation twice.
          externalId: parsed.messageId ?? `eml:${file.name}:${file.size}`,
          threadId: null,
          inReplyTo: parsed.inReplyTo,
          fromEmail: parsed.fromEmail,
          fromName: parsed.fromName,
          subject: parsed.subject,
          receivedAt: parsed.date ?? new Date().toISOString(),
          bodyText: parsed.bodyText,
          attachments: accepted,
          simulated: true,
        });

        results.push({
          filename: file.name,
          ok: true,
          from: parsed.fromEmail,
          subject: parsed.subject,
          matched: outcome.message.matchStatus,
          quoteId: outcome.quote?.id ?? null,
          note: outcome.note,
          warnings: [...parsed.warnings, ...rejected],
        });
      } catch (err) {
        results.push({
          filename: file.name,
          ok: false,
          error:
            err instanceof UnreadableEml || err instanceof FreightError
              ? err.message
              : 'That file could not be read as an email.',
        });
      }
    }

    const loaded = results.filter((r) => r.ok).length;
    const failed = results.length - loaded;
    return NextResponse.json({
      ok: failed === 0,
      message:
        failed === 0
          ? `Loaded ${loaded} message${loaded === 1 ? '' : 's'}.`
          : `Loaded ${loaded}, and ${failed} could not be read.`,
      data: { results },
    });
  } catch (err) {
    if (err instanceof FreightError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    if (err instanceof FileError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    console.error('[freight/inbox/import]', err);
    return NextResponse.json({ ok: false, error: 'Those files could not be loaded.' }, { status: 500 });
  }
}
