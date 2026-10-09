/**
 * Behaviour checks for summary chunking, section parsing and Core normalization on the real
 * project functions. Replaces the former local copy of the post-processing algorithm.
 * Mocked-AI post-processing (semantic dedup, consolidation) lives in verify-memory-scenarios.mjs.
 * Run: node scripts/verify-summary-postprocess.cjs
 */
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const result = spawnSync(process.execPath, [join(__dirname, "verify-memory-context.mjs"), "--group", "summary"], { stdio: "inherit" });
process.exit(result.status ?? 1);
