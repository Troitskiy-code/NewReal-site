// Read filenames only; never opens env files or contacts a service.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

assert.ok(existsSync('.next/BUILD_ID'), 'Run the production build before inspecting its artifact');
const root = resolve('.next/server');
let traces = 0;
let migrationIncluded = false;
const forbidden = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) inspect(file);
    else if (entry.name.endsWith('.nft.json')) {
      traces++;
      for (const name of JSON.parse(readFileSync(file, 'utf8')).files || []) {
        const parts = resolve(directory, name).split(sep);
        if (parts.some(part => part === '.git' || part === '.env' || part.startsWith('.env.'))) {
          forbidden.push(relative(process.cwd(), file));
        }
        if (name.replaceAll('\\', '/').endsWith('prisma/migrations/20261006120000_support_replies/migration.sql')) {
          migrationIncluded = true;
        }
      }
    }
  }
}
inspect(root);
assert.ok(traces > 0, 'No server file traces found; artifact inspection cannot be claimed');
assert.deepEqual(forbidden, [], 'Secret files or Git history appear in server traces');
assert.ok(migrationIncluded, 'Required support migration SQL remains included');
console.log(`Security artifact: ${traces} server traces; no env/Git files; support migration included`);
