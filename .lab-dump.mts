import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEml } from './src/freight/parsers/eml';
const dir = process.env.SAMPLES!;
const files = readdirSync(dir).filter((f) => f.endsWith('.eml')).sort();
let shown = 0;
for (const f of files) {
  let p; try { p = parseEml(readFileSync(path.join(dir, f))); } catch { continue; }
  const lines = p.bodyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Lines that look like they carry a rate or a basis.
  const interesting = lines.filter((l) =>
    /(\b(USD|EUR)\b.*\d)|(\d.*\b(USD|EUR)\b)|(\b40\s*(HC|HQ|GP)\b)|(\b20\s*(GP|DC|ST)\b)|transit|validity|valid till|valid until|free time|detention/i.test(l),
  );
  if (!interesting.length) continue;
  if (shown++ >= Number(process.env.N ?? 6)) break;
  console.log(`\n=== ${f.slice(0, 60)}`);
  for (const l of interesting.slice(0, 12)) console.log('   ', l.slice(0, 150));
}
