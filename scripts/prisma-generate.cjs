const { spawnSync } = require("child_process");

const mirrors = [
  process.env.PRISMA_ENGINES_MIRROR,
  "https://registry.npmmirror.com/-/binary/prisma",
  "https://cdn.npmmirror.com/binaries/prisma",
  "https://binaries.prisma.sh",
].filter(Boolean);

const attempts = 5;

for (let i = 0; i < attempts; i += 1) {
  const mirror = mirrors[i % mirrors.length];
  const result = spawnSync("npx", ["prisma", "generate"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      PRISMA_ENGINES_MIRROR: mirror,
      PRISMA_BINARIES_MIRROR: mirror,
    },
  });

  if (result.status === 0) {
    process.exit(0);
  }

  console.warn(`prisma generate failed (attempt ${i + 1}/${attempts}), retrying...`);
}

process.exit(1);
