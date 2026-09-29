/**
 * PDF text extraction.
 *
 * Only text-based PDFs are supported, which is what the brief asks for. A
 * scanned page contains an image, not characters, and no amount of parsing will
 * recover a rate from it. When that happens the file is reported as unreadable
 * with an explanation, and the quotation is held for manual entry - it is never
 * silently treated as an empty quote.
 */

import { UnreadableFile } from './excel';

export interface PdfText {
  /** One entry per page, in order. */
  pages: string[];
  text: string;
}

/**
 * pdfjs is loaded lazily and by its legacy build, which is the one that runs
 * under Node without a DOM. Importing it at module scope would pull it into
 * every route bundle that merely touches this file.
 */
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // An empty workerSrc does not mean "no worker": pdfjs falls back to a fake
  // worker, which then refuses with `No "GlobalWorkerOptions.workerSrc"
  // specified` and every PDF reads as unreadable. Found against real carrier
  // quotations, where all six PDFs failed for this reason rather than anything
  // to do with their contents.
  //
  // It has to be a file:// URL, not a path: Node's ESM loader rejects a bare
  // Windows path as an unsupported 'c:' protocol.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;

  return pdfjs;
}

/**
 * Where pdfjs finds the metrics for the standard fonts.
 *
 * A PDF that uses Helvetica or Times without embedding it - which plenty of
 * quotation templates do - yields no text without this, and warns about it
 * rather than failing, so the file looks empty instead of broken.
 */
async function standardFontDataUrl(): Promise<string> {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pdfjs-dist/package.json');
  const { dirname, join } = await import('node:path');
  return pathToFileURL(join(dirname(pkg), 'standard_fonts/')).href;
}

export async function extractPdfText(buffer: Buffer, filename: string): Promise<PdfText> {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    throw new UnreadableFile(
      `${filename} could not be read because the PDF reader is not available on this server. Enter the figures by hand, or install the pdfjs-dist dependency.`,
    );
  }

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: await standardFontDataUrl(),
    }).promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/password/i.test(message)) {
      throw new UnreadableFile(`${filename} is password-protected, so its contents cannot be read.`);
    }
    throw new UnreadableFile(
      `${filename} is not a readable PDF${message ? ` (${message})` : ''}. Enter the figures by hand.`,
    );
  }

  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(joinItems(content.items as TextItem[]));
  }

  const text = pages.join('\n');
  if (text.replace(/\s+/g, '').length < 20) {
    throw new UnreadableFile(
      `${filename} contains no selectable text. It is most likely a scan or an image, so the figures cannot be extracted automatically - they have to be entered by hand.`,
    );
  }
  return { pages, text };
}

interface TextItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

/**
 * Rebuilds lines from positioned glyph runs.
 *
 * pdfjs hands back fragments with coordinates, not lines. Fragments sharing a
 * baseline (within a couple of points, to tolerate sub-pixel drift) belong to
 * the same visual line, which is what a label-and-value parser needs.
 */
function joinItems(items: TextItem[]): string {
  const rows = new Map<number, { x: number; str: string }[]>();
  for (const item of items) {
    if (!item.str) continue;
    const y = Math.round((item.transform[5] ?? 0) / 2) * 2;
    const x = item.transform[4] ?? 0;
    const row = rows.get(y) ?? [];
    row.push({ x, str: item.str });
    rows.set(y, row);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF y grows upwards
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((r) => r.str)
        .join(' ')
        .replace(/\s{2,}/g, '  ')
        .trimEnd(),
    )
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

export { UnreadableFile };
