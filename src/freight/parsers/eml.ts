/**
 * Reading `.eml` files.
 *
 * WHY THIS EXISTS
 * ---------------
 * The mailbox adapter hands us messages already decomposed by Microsoft Graph.
 * A `.eml` file is the raw RFC 5322 message instead: headers, a MIME tree, and
 * attachments encoded inside it. The customer is sending sample quotations as
 * `.eml`, and validating extraction against real replies is the step before
 * anything can be stored in ERPNext, so the format has to be readable.
 *
 * WHAT IT HANDLES
 * ---------------
 * Folded headers, RFC 2047 encoded words in subjects and names, nested
 * multipart trees, base64 and quoted-printable bodies, a few common charsets,
 * `text/html` as a fallback when there is no plain part, and RFC 2231 split
 * filenames. That is the shape real Outlook mail arrives in.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * `.msg` is Outlook's own OLE container, not MIME, and nothing here will read
 * it. S/MIME/PGP encrypted payloads are reported rather than silently returned
 * as gibberish. Neither is guessed at.
 */

export interface EmlAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ParsedEml {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  fromName: string | null;
  to: { name: string | null; email: string }[];
  subject: string;
  date: string | null;
  bodyText: string;
  attachments: EmlAttachment[];
  /** Anything the reader could not make sense of, for the person reviewing. */
  warnings: string[];
}

export class UnreadableEml extends Error {}

/* --------------------------------- Headers ---------------------------------- */

/** Splits the message into its header block and its body. */
function splitHeaders(raw: string): { headers: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { headers: raw, body: '' };
  return { headers: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

/**
 * Parses a header block, unfolding continuation lines.
 *
 * A header may be split across lines with leading whitespace; joining them back
 * is the first thing that has to happen or every long Subject is truncated.
 */
export function parseHeaders(block: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

const header = (h: Map<string, string[]>, name: string): string | null => h.get(name)?.[0] ?? null;

/* ------------------------------ Encoded words -------------------------------- */

function decodeCharset(buf: Buffer, charset: string): string {
  const cs = charset.toLowerCase().replace(/['"]/g, '');
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') return buf.toString('utf8');
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252' || cs === 'cp1252') {
    return buf.toString('latin1');
  }
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    // An unknown charset is better read as UTF-8 than refused: the numbers we
    // are after are ASCII either way.
    return buf.toString('utf8');
  }
}

/**
 * Decodes RFC 2047 encoded words, e.g. `=?UTF-8?B?TcO8bGxlcg==?=`.
 *
 * Adjacent encoded words are joined without the whitespace between them, which
 * is what the specification requires and what splits a name otherwise.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, enc: string, text: string) => {
      try {
        if (enc.toLowerCase() === 'b') return decodeCharset(Buffer.from(text, 'base64'), charset);
        const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
        return decodeCharset(Buffer.from(bytes, 'latin1'), charset);
      } catch {
        return text;
      }
    });
}

/* -------------------------------- Addresses ---------------------------------- */

export function parseAddressList(value: string | null): { name: string | null; email: string }[] {
  if (!value) return [];
  const out: { name: string | null; email: string }[] = [];
  // Split on commas that are not inside quotes.
  for (const part of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const angled = /^(.*?)<([^>]+)>$/.exec(chunk);
    if (angled) {
      const name = decodeEncodedWords(angled[1].trim().replace(/^"|"$/g, '')).trim();
      out.push({ name: name || null, email: angled[2].trim().toLowerCase() });
    } else if (chunk.includes('@')) {
      out.push({ name: null, email: chunk.replace(/^<|>$/g, '').trim().toLowerCase() });
    }
  }
  return out;
}

/* ---------------------------------- Bodies ------------------------------------ */

function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /[0-9A-Fa-f]{2}/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string | null): Buffer {
  const enc = (encoding ?? '7bit').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return Buffer.from(body, 'latin1');
}

/** A very plain HTML-to-text pass, used only when there is no text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* --------------------------------- MIME tree ---------------------------------- */

interface Part {
  headers: Map<string, string[]>;
  body: string;
}

function contentType(h: Map<string, string[]>): { type: string; params: Record<string, string> } {
  const raw = header(h, 'content-type') ?? 'text/plain';
  const [typePart, ...rest] = raw.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { type: typePart.trim().toLowerCase(), params };
}

/** Splits a multipart body on its boundary. */
function splitParts(body: string, boundary: string): Part[] {
  const marker = `--${boundary}`;
  const chunks = body.split(marker);
  const parts: Part[] = [];
  // The first chunk is the preamble and the last is the epilogue after "--".
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith('--')) break;
    const trimmed = chunk.replace(/^\r?\n/, '');
    const { headers, body: partBody } = splitHeaders(trimmed);
    parts.push({ headers: parseHeaders(headers), body: partBody });
  }
  return parts;
}

/**
 * Filenames may be split and percent-encoded across `name*0*`, `name*1*`
 * (RFC 2231). Outlook does this for long names, so reassemble them.
 */
function filenameFrom(h: Map<string, string[]>): string | null {
  const disposition = header(h, 'content-disposition') ?? '';
  const ct = header(h, 'content-type') ?? '';
  const combined = `${disposition};${ct}`;

  const simple = /(?:^|;)\s*(?:file)?name\s*=\s*"?([^";]+)"?/i.exec(combined);
  const extended = /(?:^|;)\s*(?:file)?name\*\s*=\s*(?:([^']*)'[^']*')?([^";]+)/i.exec(combined);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      return extended[2].trim();
    }
  }

  const segments = [...combined.matchAll(/(?:^|;)\s*(?:file)?name\*(\d+)\*?\s*=\s*"?([^";]+)"?/gi)];
  if (segments.length > 0) {
    const joined = segments
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((m) => m[2])
      .join('');
    try {
      return decodeURIComponent(joined.replace(/^[^']*'[^']*'/, ''));
    } catch {
      return joined;
    }
  }
  return simple ? decodeEncodedWords(simple[1].trim()) : null;
}

function isAttachment(h: Map<string, string[]>): boolean {
  const disposition = (header(h, 'content-disposition') ?? '').toLowerCase();
  if (disposition.startsWith('attachment')) return true;
  // An inline part with a filename is still a file worth keeping.
  return disposition.startsWith('inline') && filenameFrom(h) !== null;
}

/* ---------------------------------- Parse ------------------------------------- */

export function parseEml(input: Buffer | string): ParsedEml {
  const raw = typeof input === 'string' ? input : input.toString('latin1');
  if (raw.trim().length === 0) throw new UnreadableEml('That file is empty.');

  const { headers: headerBlock, body } = splitHeaders(raw);
  const h = parseHeaders(headerBlock);

  if (h.size === 0 || (!h.has('from') && !h.has('subject') && !h.has('received'))) {
    throw new UnreadableEml(
      'That does not look like an email file. Export the message as .eml (not .msg, which is an Outlook-only format).',
    );
  }

  const warnings: string[] = [];
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  const attachments: EmlAttachment[] = [];

  const walk = (part: Part, depth: number): void => {
    if (depth > 10) {
      warnings.push('The message is nested more deeply than expected; the deepest parts were skipped.');
      return;
    }
    const { type, params } = contentType(part.headers);

    if (type.startsWith('multipart/')) {
      const boundary = params.boundary;
      if (!boundary) {
        warnings.push('A multipart section had no boundary, so it could not be split.');
        return;
      }
      for (const child of splitParts(part.body, boundary)) walk(child, depth + 1);
      return;
    }

    if (type === 'application/pkcs7-mime' || type === 'multipart/encrypted') {
      warnings.push('This message is encrypted, so its contents cannot be read.');
      return;
    }

    const encoding = header(part.headers, 'content-transfer-encoding');
    const decoded = decodeBody(part.body, encoding);

    if (isAttachment(part.headers)) {
      const filename = filenameFrom(part.headers) ?? `attachment-${attachments.length + 1}`;
      attachments.push({ filename, contentType: type, content: decoded });
      return;
    }

    const text = decodeCharset(decoded, params.charset ?? 'utf-8');
    if (type === 'text/plain') textParts.push(text);
    else if (type === 'text/html') htmlParts.push(text);
    else if (filenameFrom(part.headers)) {
      attachments.push({ filename: filenameFrom(part.headers)!, contentType: type, content: decoded });
    }
  };

  walk({ headers: h, body }, 0);

  let bodyText = textParts.join('\n').trim();
  if (!bodyText && htmlParts.length > 0) {
    bodyText = htmlToText(htmlParts.join('\n'));
    warnings.push('The message had no plain-text part, so the text was taken from the HTML version.');
  }
  if (!bodyText && attachments.length === 0) {
    throw new UnreadableEml('That email has no readable body and no attachments.');
  }

  const from = parseAddressList(decodeEncodedWords(header(h, 'from') ?? ''))[0];
  if (!from) {
    throw new UnreadableEml('That email has no readable sender address.');
  }

  const dateHeader = header(h, 'date');
  let date: string | null = null;
  if (dateHeader) {
    const parsed = Date.parse(dateHeader);
    if (Number.isFinite(parsed)) date = new Date(parsed).toISOString();
    else warnings.push(`The Date header could not be read: "${dateHeader}".`);
  }

  const clean = (v: string | null) => v?.trim().replace(/^<|>$/g, '') || null;

  return {
    messageId: clean(header(h, 'message-id')),
    inReplyTo: clean(header(h, 'in-reply-to')),
    references: (header(h, 'references') ?? '')
      .split(/\s+/)
      .map((r) => r.trim().replace(/^<|>$/g, ''))
      .filter(Boolean),
    fromEmail: from.email,
    fromName: from.name,
    to: parseAddressList(decodeEncodedWords(header(h, 'to') ?? '')),
    subject: decodeEncodedWords(header(h, 'subject') ?? '').trim(),
    date,
    bodyText,
    attachments,
    warnings,
  };
}
