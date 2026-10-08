import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKodikCostExport } from './lib/kodik-cost-export.mjs';
import { rubUnits, rubString } from './lib/ai-cost-report.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length % 2 || args.some((value, index) => index % 2 === 0 && !['--input','--output','--naive-timezone'].includes(value))) {
    throw new Error('Expected --input, --output and optional --naive-timezone UTC');
  }
  const options = Object.fromEntries(args.reduce((pairs, value, index) => index % 2 ? pairs : [...pairs, [value,args[index+1]]], []));
  if (!options['--input'] || !options['--output']) throw new Error('Input/output paths required');
  const output = resolve(options['--output']);
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const inside = relative(repo, output);
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) {
    throw new Error('Raw exports must be outside the repository');
  }
  const rows = loadKodikCostExport(resolve(options['--input']), { naiveTimezone: options['--naive-timezone'] });
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, sourceTimezone: options['--naive-timezone'] ?? 'explicit_offsets', rows }) + '\n', { flag: 'wx', mode: 0o600 });
  const total = rows.reduce((sum,row) => sum + (rubUnits(row.cost_rub) ?? 0n), 0n);
  console.log(JSON.stringify({ rows: rows.length, costRubExact: rubString(total), written: true }));
} catch {
  console.error(JSON.stringify({ category: 'kodik_export_import_failed' })); process.exitCode = 1;
}
