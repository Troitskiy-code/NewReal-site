import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Resolve metadata/visibility before streaming so missing characters return HTTP 404
  // to browsers as well as crawlers, rather than a streamed 200 with a noindex tag.
  htmlLimitedBots: /.*/,
  outputFileTracingIncludes: {
    '/api/admin/support/migration': ['./prisma/migrations/20261006120000_support_replies/migration.sql'],
  },
  outputFileTracingExcludes: {
    '/*': ['./.env', './.env.*', './.git/**/*'],
  },
  serverExternalPackages: ["tiktoken", "jimp", "sharp", "@jsquash/webp", "@logtail/node", "@logtail/core"],
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/:all*(svg|jpg|jpeg|png|gif|ico|webp|avif|woff|woff2)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
