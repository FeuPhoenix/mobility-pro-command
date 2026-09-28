/**
 * Writes an approved email out as a `.eml` file.
 *
 * This is the other half of reading `.eml` replies: it lets a team run the
 * whole workflow before Microsoft Graph exists. They download the approved
 * message, open it in Outlook, send it themselves, and tell the application it
 * has gone. The approval, the recipients and the attachments are exactly the
 * reviewed ones, because they are read from storage rather than rebuilt.
 *
 * Deliberately no `From` header: whoever opens the file sends it from their own
 * mailbox, and a From we invented would either be wrong or look like a forgery.
 *
 * The output is RFC 5322 with MIME. Bodies and filenames go out encoded rather
 * than raw, because a quotation routinely carries non-ASCII - Arabic company
 * names, an em dash, a degree sign - and a raw 8-bit header is what makes a
 * message arrive as mojibake.
 */

import type { EmailAttachment, EmailDraft, Recipient } from '../types';

/** CRLF: RFC 5322 line endings are not the platform's. */
const CRLF = '\r\n';

/** RFC 2047 for a header value, only when it needs it. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function address(r: Recipient): string {
  if (!r.name) return r.email;
  // A display name with a comma or a quote would break the address list.
  const name = encodeHeaderValue(r.name);
  return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}" <${r.email}>` : `${name} <${r.email}>`;
}

function addressList(list: Recipient[]): string {
  return list.map(address).join(', ');
}

/** Base64 in 76-character lines, as MIME requires. */
function base64Lines(buf: Buffer): string {
  const b64 = buf.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

/** RFC 2231 for a filename, so a non-ASCII attachment name survives. */
function filenameParams(filename: string): string {
  if (/^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename)) {
    return `; filename="${filename}"`;
  }
  return `; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface EmlAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * The message as a `.eml` file.
 *
 * `sentAt` is not set here. Nothing about this file claims the message was
 * sent; it is a draft until a person says otherwise.
 */
export function toEml(
  email: Pick<EmailDraft, 'to' | 'cc' | 'subject' | 'bodyText'> & { attachments?: EmailAttachment[] },
  attachments: EmlAttachment[] = [],
  now: Date = new Date(),
): string {
  const boundary = `----freight-${Buffer.from(`${now.getTime()}`).toString('hex').slice(0, 16)}`;

  const headers = [
    'MIME-Version: 1.0',
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `To: ${addressList(email.to)}`,
    ...(email.cc.length > 0 ? [`Cc: ${addressList(email.cc)}`] : []),
    `Subject: ${encodeHeaderValue(email.subject)}`,
    // Outlook opens a message with this header as an editable draft rather than
    // a received item, which is the whole point of the file.
    'X-Unsent: 1',
  ];

  const body = base64Lines(Buffer.from(email.bodyText, 'utf8'));

  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
      '',
    ].join(CRLF);
  }

  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ];

  for (const a of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}${filenameParams(a.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment${filenameParams(a.filename)}`,
      '',
      base64Lines(a.content),
    );
  }

  parts.push(`--${boundary}--`, '');
  return parts.join(CRLF);
}

/** A filename for the download, safe on Windows as well as everywhere else. */
export function emlFilename(subject: string): string {
  const base = subject.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'message'}.eml`;
}
