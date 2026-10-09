/**
 * Behaviour checks for semantic dedup on the real project functions (synthetic vectors,
 * no network). Replaces the former copy-of-algorithm and source-string checks.
 * Run: node scripts/verify-memory-semantic.cjs
 */
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const result = spawnSync(process.execPath, [join(__dirname, "verify-memory-context.mjs"), "--group", "dedup"], { stdio: "inherit" });
process.exit(result.status ?? 1);
