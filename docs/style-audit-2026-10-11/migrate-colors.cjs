// One-off migration of hard-coded accent colors in src/ to palette A tokens.
// Usage: node docs/style-audit-2026-10-11/migrate-colors.cjs [--dry]
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const dry = process.argv.includes('--dry');
const B = '(?<![\\w-])';
const E = '(?![\\w-])';

const rules = [
  // text on dark surfaces -> readable shades
  [new RegExp(`${B}text-wd-secondary${E}`, 'g'), 'text-wd-secondary-text'],
  [new RegExp(`${B}text-wd-primary${E}`, 'g'), 'text-wd-primary-soft'],
  [new RegExp(`${B}text-primary${E}`, 'g'), 'text-primary-soft'],
  [/text-\[#(6C63FF|B9AEFF|C8C4FF)\]/gi, 'text-wd-secondary-text'],
  [/(border|outline)-\[#B9AEFF\]/gi, '$1-wd-secondary-text'],
  [/text-\[#FF2D55\]/gi, 'text-wd-primary-soft'],
  // fills, borders, rings, accents
  [/hover:bg-\[#5a52e0\]/gi, 'hover:bg-wd-secondary-hover'],
  [/hover:bg-\[#e0264b\]/gi, 'hover:bg-wd-primary-hover'],
  [/-\[#6C63FF\]/gi, '-wd-secondary'],
  [/-\[#FF2D55\]/gi, '-wd-primary'],
];

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
  }
})(path.join(root, 'src'));

let total = 0;
for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  let count = 0;
  for (const [re, to] of rules) {
    after = after.replace(re, (...args) => {
      count++;
      return args[0].replace(new RegExp(re.source, re.flags.replace('g', '')), to);
    });
  }
  if (count) {
    total += count;
    console.log(String(count).padStart(4), path.relative(root, file));
    if (!dry) fs.writeFileSync(file, after);
  }
}
console.log('total', total, dry ? '(dry run)' : '');
