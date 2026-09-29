/**
 * Reading a PDF at all.
 *
 * There was no test here, and the reader was broken: `workerSrc = ''` does not
 * mean "no worker", it makes pdfjs fall back to a fake worker that refuses with
 * `No "GlobalWorkerOptions.workerSrc" specified`. Every PDF came back
 * unreadable. Six real carrier quotations proved it; nothing in the suite did.
 *
 * The fixture is built here rather than committed, because the PDFs we have are
 * real customer quotations and this repository is public.
 */

import { describe, expect, it } from 'vitest';
import { extractPdfText } from '@/freight/parsers/pdf';

/**
 * The smallest PDF that holds a line of text.
 *
 * Written out by hand: a catalogue, a page, a font and a content stream, with
 * the cross-reference table byte offsets computed as it is assembled.
 */
function pdfWithText(lines: string[]): Buffer {
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '14 TL',
    ...lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

describe('the PDF reader', () => {
  it('reads the text out of a PDF', async () => {
    const pdf = pdfWithText(['Ocean freight USD 1850.00 per 40HC', 'Transit time 26 days']);

    const { text } = await extractPdfText(pdf, 'quotation.pdf');

    expect(text).toContain('Ocean freight');
    expect(text).toContain('1850.00');
    expect(text).toContain('Transit time 26 days');
  });

  it('keeps the lines apart, so a charge is not glued to the next one', async () => {
    const { text } = await extractPdfText(pdfWithText(['BAF USD 185.00', 'THC USD 120.00']), 'q.pdf');

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain('BAF USD 185.00');
    expect(lines).toContain('THC USD 120.00');
  });

  it('says so plainly when the file is not a PDF', async () => {
    await expect(extractPdfText(Buffer.from('this is not a pdf'), 'notes.txt')).rejects.toThrow(
      /not a readable PDF/i,
    );
  });
});
