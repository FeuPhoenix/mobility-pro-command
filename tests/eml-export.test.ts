/**
 * Writing an approved email out as a `.eml` file.
 *
 * The point of the file is that a person sends it from their own mailbox
 * before Microsoft Graph exists, so what matters is that the recipients,
 * subject, body and attachments in the file are exactly the reviewed ones.
 *
 * Most of these read the file back with our own `.eml` parser: a round trip
 * checks the writer against something other than itself, and the parser is
 * already tested against real-world messages.
 */

import { describe, expect, it } from 'vitest';
import { toEml, emlFilename, encodeHeaderValue } from '@/freight/mail/eml';
import { parseEml } from '@/freight/parsers/eml';

const email = {
  to: [{ name: 'Ann Fahmy', email: 'ann@alpha.test' }],
  cc: [],
  subject: 'Request for quotation RFQ-MPD-2026-0001',
  bodyText: 'Dear Ann,\n\nPlease quote for 6 x 40HC, CNSHA to EGALY.\n\nRegards,\nHala',
};

/**
 * Reads the file back.
 *
 * The exported file has no `From` on purpose, and the inbound parser insists on
 * one, so the harness adds the sender that the person's own mailbox would.
 */
const parsed = (text: string) =>
  parseEml(Buffer.from(['From: Hala Mansour <hala@mobilitypro.test>', text].join('\r\n'), 'utf8'));

describe('the file carries what was approved', () => {
  it('round trips the recipient, subject and body', () => {
    const back = parsed(toEml(email));

    expect(back.to).toEqual([{ name: 'Ann Fahmy', email: 'ann@alpha.test' }]);
    expect(back.subject).toBe(email.subject);
    expect(back.bodyText.replace(/\r\n/g, '\n').trim()).toBe(email.bodyText.trim());
  });

  it('uses CRLF line endings, as the format requires', () => {
    const text = toEml(email);
    expect(text).toContain('\r\n');
    expect(text.split('\r\n').some((l) => l.includes('\n'))).toBe(false);
  });

  it('opens as a draft rather than a received message', () => {
    // Without this Outlook shows it as something already received, and there
    // is no Send button - which would defeat the whole feature.
    expect(toEml(email)).toContain('X-Unsent: 1');
  });

  it('invents no sender', () => {
    // Whoever opens it sends from their own mailbox. A From we made up would
    // either be wrong or look like a forgery.
    expect(toEml(email)).not.toMatch(/^From:/m);
  });

  it('includes a Cc only when there is one', () => {
    expect(toEml(email)).not.toMatch(/^Cc:/m);
    const withCc = toEml({ ...email, cc: [{ name: null, email: 'ops@alpha.test' }] });
    expect(parsed(withCc).to).toEqual([{ name: 'Ann Fahmy', email: 'ann@alpha.test' }]);
    expect(withCc).toMatch(/^Cc: ops@alpha\.test$/m);
  });
});

describe('text that is not plain ASCII', () => {
  it('keeps a non-ASCII subject readable', () => {
    const back = parsed(toEml({ ...email, subject: 'Demande de cotation — Alexandrie' }));
    expect(back.subject).toBe('Demande de cotation — Alexandrie');
  });

  it('keeps a non-ASCII body readable', () => {
    const body = 'مرحبا\nPlease quote 6 × 40HC — thank you.';
    const back = parsed(toEml({ ...email, bodyText: body }));
    expect(back.bodyText.replace(/\r\n/g, '\n').trim()).toBe(body);
  });

  it('encodes a display name that needs it, and leaves a plain one alone', () => {
    expect(encodeHeaderValue('Ann Fahmy')).toBe('Ann Fahmy');
    expect(encodeHeaderValue('Ahmed Hafez — Alexandria')).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe('attachments', () => {
  const workbook = {
    filename: 'Shipping requirement RFQ-MPD-2026-0001.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: Buffer.from('PK\u0003\u0004 pretend workbook'),
  };

  it('carries the file, its name and its bytes', () => {
    const back = parsed(toEml(email, [workbook]));

    expect(back.attachments).toHaveLength(1);
    expect(back.attachments[0].filename).toBe(workbook.filename);
    expect(Buffer.from(back.attachments[0].content).toString()).toBe(workbook.content.toString());
  });

  it('keeps the body readable alongside the attachment', () => {
    const back = parsed(toEml(email, [workbook]));
    expect(back.bodyText).toContain('Please quote for 6 x 40HC');
  });

  it('carries several attachments', () => {
    const second = { filename: 'Terms.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 x') };
    const back = parsed(toEml(email, [workbook, second]));
    expect(back.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      workbook.filename,
      'Terms.pdf',
    ]);
  });

  it('survives a non-ASCII filename', () => {
    const arabic = { ...workbook, filename: 'طلب عرض سعر.xlsx' };
    const back = parsed(toEml(email, [arabic]));
    expect(back.attachments[0].filename).toBe('طلب عرض سعر.xlsx');
  });

  it('wraps base64 so no line exceeds what MIME allows', () => {
    const big = { ...workbook, content: Buffer.alloc(5000, 7) };
    const longest = Math.max(...toEml(email, [big]).split('\r\n').map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(998);
  });
});

describe('the download filename', () => {
  it('is named after the subject', () => {
    expect(emlFilename('Request for quotation RFQ-MPD-2026-0001')).toBe(
      'Request for quotation RFQ-MPD-2026-0001.eml',
    );
  });

  it('drops characters a filesystem refuses', () => {
    expect(emlFilename('RE: quote 40HC / 20GP <urgent>')).toBe('RE quote 40HC 20GP urgent.eml');
  });

  it('never produces a nameless file', () => {
    expect(emlFilename('***')).toBe('message.eml');
  });
});
