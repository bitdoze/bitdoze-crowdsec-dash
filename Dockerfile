# syntax=docker/dockerfile:1

# Build the SvelteKit app (adapter-node output in /app/build)
FROM node:25-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production dependencies only (@libsql/client, drizzle-orm, better-auth
# + transitive deps — the bundled server externals).
# --legacy-peer-deps skips auto-installing better-auth's *optional* peers
# (svelte, vite, vitest, drizzle-kit...): dev installs use package.json
# `overrides` and plain `npm ci` — the flag exists here only to keep the
# runtime image minimal (74M vs 190M of node_modules).
FROM node:25-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps --ignore-scripts

# Runtime
FROM node:25-slim AS runtime
ENV NODE_ENV=production \
	DATA_DIR=/data \
	HOST=0.0.0.0 \
	PORT=3000 \
	ORIGIN=http://localhost:3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY server ./server
COPY drizzle ./drizzle
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.source="https://github.com/bitdoze/bitdoze-crowdsec-dash" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.description="Self-hosted CrowdSec dashboard"

CMD ["node", "server/index.js"]
