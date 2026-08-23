const MIRROR =
  process.env.PRISMA_ENGINES_MIRROR ||
  process.env.PRISMA_BINARIES_MIRROR ||
  "https://registry.npmmirror.com/-/binary/prisma";

process.env.PRISMA_ENGINES_MIRROR = MIRROR;
process.env.PRISMA_BINARIES_MIRROR = MIRROR;
