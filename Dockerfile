FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM dependencies AS build
COPY . .
# Next.js can copy build-time env files into the standalone output.
RUN NEXT_STANDALONE_BUILD=1 npm run build \
    && rm -f .next/standalone/.env .next/standalone/.env.* \
    && rm -f .next/standalone/node_modules/.prisma/client/libquery_engine-linux-musl-*.so.node \
             .next/standalone/node_modules/.prisma/client/libquery_engine-rhel-*.so.node

FROM base AS xray
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY scripts/install-allvpn-xray.mjs ./scripts/install-allvpn-xray.mjs
RUN node scripts/install-allvpn-xray.mjs /opt/xray

FROM base AS runtime
ENV NODE_ENV=production PORT=8080 ALLVPN_XRAY_PATH=/opt/xray/xray
COPY --from=xray /opt/xray/xray /opt/xray/xray
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# The launcher runs outside Next's module trace.
COPY --from=build /app/node_modules/dotenv ./node_modules/dotenv
COPY --from=build /app/node_modules/undici ./node_modules/undici
COPY scripts/start-app.mjs scripts/verify-standalone-runtime.mjs ./scripts/
COPY scripts/lib/allvpn-runtime.mjs scripts/lib/character-generation-worker.mjs scripts/lib/memory-worker.mjs scripts/lib/character-translation-worker.mjs ./scripts/lib/
RUN install -d -o node -g node /app/.next/cache
USER node
RUN node scripts/verify-standalone-runtime.mjs
EXPOSE 8080
CMD ["node", "scripts/start-app.mjs", "--standalone"]
