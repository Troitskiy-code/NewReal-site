const fs = require("fs");
const path = require("path");
const os = require("os");

const MIRROR = "https://registry.npmmirror.com/-/binary/prisma";

function isDockerBuild() {
  if (process.platform === "win32") return false;
  if (process.env.CI === "true") return true;
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

function writeDockerNpmrc() {
  const envModule = path.join(__dirname, "prisma-env.cjs");
  const npmrc = [
    "fetch-retries=10",
    "fetch-retry-mintimeout=20000",
    "fetch-retry-maxtimeout=120000",
    "fetch-timeout=300000",
    `node-options=--require=${envModule}`,
    "",
  ].join("\n");

  try {
    fs.writeFileSync(path.join(process.cwd(), ".npmrc"), npmrc);
  } catch {
    // ignore
  }

  try {
    fs.writeFileSync(path.join(os.homedir(), ".npmrc"), npmrc);
  } catch {
    // ignore
  }
}

function wrapNodeWithMirror() {
  const nodePath = process.execPath;
  const realPath = `${nodePath}.real`;

  if (!nodePath || fs.existsSync(realPath)) return;
  if (path.basename(nodePath) !== "node") return;

  try {
    fs.accessSync(nodePath, fs.constants.W_OK);
    fs.renameSync(nodePath, realPath);
    fs.writeFileSync(
      nodePath,
      `#!/bin/sh
export PRISMA_ENGINES_MIRROR="\${PRISMA_ENGINES_MIRROR:-${MIRROR}}"
export PRISMA_BINARIES_MIRROR="\${PRISMA_BINARIES_MIRROR:-${MIRROR}}"
exec "${realPath}" "$@"
`
    );
    fs.chmodSync(nodePath, 0o755);
    console.log("Prisma engines mirror enabled for Docker install");
  } catch (error) {
    console.warn("Could not wrap node for Prisma mirror:", error.message);
  }
}

if (isDockerBuild()) {
  writeDockerNpmrc();
  wrapNodeWithMirror();
}
