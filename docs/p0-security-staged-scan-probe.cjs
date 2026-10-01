// Probe staged versions with a private index and private object directory.
// Never modifies the repository's real index, refs, objects or tracked files.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const probeDir = fs.mkdtempSync(path.join(__dirname, '.p0-staged-probe-'));
const fixture = path.join(root, 'p0-security-staged-probe-fixture.json');
const env = { ...process.env, LOGTAIL_SOURCE_TOKEN: '', LOGTAIL_INGESTING_HOST: '' };
function git(args, overrides = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, ...overrides });
  if (result.status !== 0) throw new Error(`Probe Git command failed: ${args[0]}`);
  return result.stdout.trim();
}
function scan(label) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import',
    './scripts/alias-register.mjs', 'scripts/verify-p0-security.ts'], {
    cwd: root, encoding: 'utf8', env, maxBuffer: 2 * 1024 * 1024,
  });
  const findings = result.stdout.split(/\r?\n/).filter((line) => /rule=.*status=fail/.test(line));
  return { label, scannerExit: result.status, findings, passedChecks: /Passed \d+ checks/.test(result.stdout) };
}
const results = [];
let ownFixture = false;
try {
  if (fs.existsSync(fixture)) throw new Error('Refusing to overwrite fixture');
  const sourceIndex = path.resolve(root, git(['rev-parse', '--git-path', 'index']));
  const sourceObjects = path.resolve(root, git(['rev-parse', '--git-path', 'objects']));
  const privateIndex = path.join(probeDir, 'index');
  const privateObjects = path.join(probeDir, 'objects');
  fs.mkdirSync(privateObjects);
  fs.copyFileSync(sourceIndex, privateIndex);
  env.GIT_INDEX_FILE = privateIndex;
  env.GIT_OBJECT_DIRECTORY = privateObjects;
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = sourceObjects;
  // Blob is unsafe synthetically, working tree remains clean. Only private storage changes.
  const marker = ['sk', 'live', 'SYNTHETIC_STAGED_PROBE_ONLY'].join('_');
  const blob = git(['hash-object', '-w', '--stdin'], { input: JSON.stringify({ apiKey: marker }) });
  fs.writeFileSync(fixture, JSON.stringify({ syntheticOnly: true, status: 'clean-working-tree' }), { flag: 'wx' });
  ownFixture = true;
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path.basename(fixture)}`]);
  results.push(scan('synthetic key only in staged blob; working tree clean'));
  git(['update-index', '--force-remove', '--', path.basename(fixture)]);
  fs.unlinkSync(fixture);
  ownFixture = false;
  git(['update-index', '--force-remove', '--', 'src/lib/email.ts']);
  results.push(scan('staged deletion of tracked file, real source retained'));
} finally {
  if (ownFixture) fs.unlinkSync(fixture);
  const resolvedProbe = path.resolve(probeDir);
  if (path.dirname(resolvedProbe) !== path.resolve(__dirname) || !path.basename(resolvedProbe).startsWith('.p0-staged-probe-')) {
    throw new Error('Unsafe probe cleanup target');
  }
  fs.rmSync(resolvedProbe, { recursive: true, force: true });
}
const output = { privateIndexUsed: true, realIndexModified: false, productionUsed: false, results };
fs.writeFileSync(path.join(__dirname, 'p0-security-staged-scan-probe.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
