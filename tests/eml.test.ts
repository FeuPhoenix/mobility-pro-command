/**
 * `.eml` reading.
 *
 * The fixtures here are deliberately awkward, because real Outlook mail is:
 * folded headers, encoded subjects, quoted-printable bodies, HTML-only
 * messages, nested multiparts, and filenames split across RFC 2231 segments.
 * A reader that only copes with the tidy case is no use for customer samples.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeEncodedWords,
  htmlToText,
  parseAddressList,
  parseEml,
  parseHeaders,
  UnreadableEml,
} from '@/freight/parsers/eml';

/** Real messages use CRLF; building fixtures with it keeps them honest. */
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

const SIMPLE = crlf(`From: Yasmine Farouk <yasmine.farouk@nilestar.test>
To: Hala Mansour <hala@mobilitypro.test>
Subject: RE: Request for quotation RFQ-MPD-2026-0001
Date: Mon, 21 Sep 2026 10:14:02 +0200
Message-ID: <abc123@nilestar.test>
In-Reply-To: <original@mobilitypro.test>
Content-Type: text/plain; charset="utf-8"

Dear Hala,

Base ocean freight: USD 1,640.00 per 40HC
Transit time: 32 days

Regards
`);

describe('header parsing', () => {
  it('unfolds a header split across lines', () => {
    const h = parseHeaders('Subject: a very long subject\r\n  continued here\r\nFrom: x@y.test');
    expect(h.get('subject')?.[0]).toBe('a very long subject continued here');
    expect(h.get('from')?.[0]).toBe('x@y.test');
  });

  it('decodes encoded words in both base64 and quoted-printable', () => {
    expect(decodeEncodedWords('=?UTF-8?B?UkZRIHF1b3RhdGlvbg==?=')).toBe('RFQ quotation');
    expect(decodeEncodedWords('=?UTF-8?Q?Quotation_RFQ=2D0001?=')).toBe('Quotation RFQ-0001');
    expect(decodeEncodedWords('plain subject')).toBe('plain subject');
  });

  it('joins adjacent encoded words without inserting a space', () => {
    // Otherwise a long subject gains a space in the middle of a word.
    expect(decodeEncodedWords('=?UTF-8?B?Zm9v?= =?UTF-8?B?YmFy?=')).toBe('foobar');
  });

  it('reads addresses with and without display names', () => {
    expect(parseAddressList('Yasmine Farouk <y@n.test>')).toEqual([
      { name: 'Yasmine Farouk', email: 'y@n.test' },
    ]);
    expect(parseAddressList('a@b.test, "Smith, John" <j@s.test>')).toEqual([
      { name: null, email: 'a@b.test' },
      { name: 'Smith, John', email: 'j@s.test' },
    ]);
  });
});

describe('a plain message', () => {
  it('reads the envelope and the body', () => {
    const m = parseEml(SIMPLE);
    expect(m.fromEmail).toBe('yasmine.farouk@nilestar.test');
    expect(m.fromName).toBe('Yasmine Farouk');
    expect(m.subject).toBe('RE: Request for quotation RFQ-MPD-2026-0001');
    expect(m.messageId).toBe('abc123@nilestar.test');
    expect(m.inReplyTo).toBe('original@mobilitypro.test');
    expect(m.date).toBe('2026-09-21T08:14:02.000Z');
    expect(m.bodyText).toContain('Base ocean freight: USD 1,640.00 per 40HC');
    expect(m.attachments).toHaveLength(0);
    expect(m.warnings).toHaveLength(0);
  });

  it('produces text the quotation parser can actually read', async () => {
    const { extractFromText } = await import('@/freight/parsers/text');
    const m = parseEml(SIMPLE);
    const fields = extractFromText({ label: 'email body', text: m.bodyText });
    expect(fields.baseFreight.value).toBe(1640);
    expect(fields.transitDays.value).toBe(32);
  });
});

describe('encodings', () => {
  it('decodes a quoted-printable body, including soft line breaks', () => {
    const raw = crlf(`From: a@b.test
Subject: Quote
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Base ocean freight: USD 1=2C640.00 per 40HC
This line is very long and so it is soft wrapped right =
here.
`);
    const m = parseEml(raw);
    expect(m.bodyText).toContain('USD 1,640.00');
    expect(m.bodyText).toContain('soft wrapped right here.');
  });

  it('decodes a base64 body', () => {
    const body = Buffer.from('Ocean freight: USD 950.00\n').toString('base64');
    const raw = crlf(`From: a@b.test
Subject: Quote
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: base64

${body}
`);
    expect(parseEml(raw).bodyText).toContain('USD 950.00');
  });

  it('reads a non-UTF-8 charset without mangling the numbers', () => {
    const raw = crlf(`From: a@b.test
Subject: Quote
Content-Type: text/plain; charset="iso-8859-1"

Freight: USD 1200.00
`);
    expect(parseEml(raw).bodyText).toContain('USD 1200.00');
  });
});

describe('multipart messages', () => {
  const withAttachment = crlf(`From: Mostafa <m@delta.test>
Subject: Quotation
Content-Type: multipart/mixed; boundary="OUTER"

--OUTER
Content-Type: multipart/alternative; boundary="INNER"

--INNER
Content-Type: text/plain; charset="utf-8"

Please find our rate attached.
--INNER
Content-Type: text/html; charset="utf-8"

<html><body><p>Please find our rate attached.</p></body></html>
--INNER--
--OUTER
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="Rate sheet.xlsx"

${Buffer.from('fake-xlsx-bytes').toString('base64')}
--OUTER--
`);

  it('prefers the plain part and keeps the attachment', () => {
    const m = parseEml(withAttachment);
    expect(m.bodyText).toBe('Please find our rate attached.');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].filename).toBe('Rate sheet.xlsx');
    expect(m.attachments[0].content.toString()).toBe('fake-xlsx-bytes');
  });

  it('falls back to the HTML part when there is no plain one, and says so', () => {
    const raw = crlf(`From: a@b.test
Subject: Quote
Content-Type: text/html; charset="utf-8"

<html><body><p>Ocean freight: USD 1,100.00</p><br><p>Transit: 26 days</p></body></html>
`);
    const m = parseEml(raw);
    expect(m.bodyText).toContain('USD 1,100.00');
    expect(m.bodyText).toContain('Transit: 26 days');
    expect(m.warnings.join(' ')).toMatch(/no plain-text part/i);
  });

  it('reassembles a filename split across RFC 2231 segments', () => {
    const raw = crlf(`From: a@b.test
Subject: Quote
Content-Type: multipart/mixed; boundary="B"

--B
Content-Type: text/plain

See attached.
--B
Content-Type: application/pdf
Content-Transfer-Encoding: base64
Content-Disposition: attachment;
 filename*0*=utf-8''Quotation%20for%20RFQ%2D;
 filename*1*=MPD%2D2026%2D0001.pdf

${Buffer.from('%PDF-1.4 fake').toString('base64')}
--B--
`);
    const m = parseEml(raw);
    expect(m.attachments[0].filename).toBe('Quotation for RFQ-MPD-2026-0001.pdf');
  });
});

describe('html to text', () => {
  it('keeps the line structure a quotation depends on', () => {
    const text = htmlToText('<p>Freight: USD 900</p><p>Transit: 20 days</p>');
    expect(text.split('\n').filter(Boolean)).toEqual(['Freight: USD 900', 'Transit: 20 days']);
  });

  it('drops style and script rather than reading them as content', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Rate</p>')).toBe('Rate');
  });
});

describe('what it refuses', () => {
  it('refuses an empty file', () => {
    expect(() => parseEml('   ')).toThrow(UnreadableEml);
  });

  it('refuses something that is not an email, and names the .msg trap', () => {
    try {
      parseEml('just some text in a file');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(UnreadableEml);
      expect((err as Error).message).toMatch(/\.msg/);
    }
  });

  it('refuses a message with no sender', () => {
    const raw = crlf(`Subject: Quote\nContent-Type: text/plain\n\nFreight: USD 1\n`);
    expect(() => parseEml(raw)).toThrow(UnreadableEml);
  });

  it('reports an encrypted message rather than returning gibberish', () => {
    const raw = crlf(`From: a@b.test
Subject: Quote
Content-Type: multipart/mixed; boundary="B"

--B
Content-Type: text/plain

Encrypted below.
--B
Content-Type: application/pkcs7-mime; smime-type=enveloped-data
Content-Transfer-Encoding: base64

${Buffer.from('nonsense').toString('base64')}
--B--
`);
    const m = parseEml(raw);
    expect(m.warnings.join(' ')).toMatch(/encrypted/i);
  });

  it('notes a Date it cannot read instead of inventing one', () => {
    const raw = crlf(`From: a@b.test
Date: not a date
Subject: Quote
Content-Type: text/plain

Freight: USD 1
`);
    const m = parseEml(raw);
    expect(m.date).toBeNull();
    expect(m.warnings.join(' ')).toMatch(/Date header/i);
  });
});
