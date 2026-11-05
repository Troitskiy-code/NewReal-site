import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'node:url';
import localeManifest from './public/locales/manifest.json' with { type: 'json' };

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env['NEXT_STANDALONE_BUILD'] === '1' ? 'standalone' : undefined,
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // Resolve metadata/visibility before streaming so missing characters return HTTP 404
  // to browsers as well as crawlers, rather than a streamed 200 with a noindex tag.
  htmlLimitedBots: /.*/,
  outputFileTracingIncludes: {
    '/*': ['./node_modules/.prisma/client/*engine*.node', './node_modules/tiktoken/tiktoken_bg.wasm'],
    '/api/admin/support/migration': ['./prisma/migrations/20261006120000_support_replies/migration.sql'],
    '/api/admin/compress-avatars': ['./node_modules/@jsquash/webp/codec/dec/webp_dec.wasm'],
  },
  outputFileTracingExcludes: {
    '/*': ['./.env', './.env.*', './.git/**/*'],
  },
  serverExternalPackages: ["tiktoken", "jimp", "sharp", "@jsquash/webp", "@logtail/node", "@logtail/core"],
  async redirects() {
    return [
      // The prototype /gallery duplicated the home catalog; keep indexed links working (query is preserved).
      { source: `/:locale(${Object.keys(localeManifest.locales).filter(code => localeManifest.locales[code].enabled).join("|")})/gallery`, destination: "/:locale", permanent: true },
      { source: "/gallery", destination: "/", permanent: true },
    ];
  },
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
