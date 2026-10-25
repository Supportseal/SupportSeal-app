# syntax=docker/dockerfile:1

# Production image for self-hosting / container hosts.
# Health: GET /api/health
#
# Build:
#   docker build --build-arg NEXT_PUBLIC_APP_URL=https://support.example.com \
#     --build-arg NEXT_PUBLIC_APP_NAME=SupportSeal -t supportseal .
# Run migrations once (or let docker compose do it via the migrate target):
#   docker run --rm --env-file .env supportseal-migrate
# Run:
#   docker run --rm -p 3000:3000 --env-file .env supportseal

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src/lib/database-url.ts ./src/lib/database-url.ts
RUN npm ci

FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_NAME=SupportSeal
# Inlined into client bundles at build time; the runtime env cannot change it.
ARG NEXT_PUBLIC_MARKETING_URL=https://supportseal.app
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_PUBLIC_MARKETING_URL=$NEXT_PUBLIC_MARKETING_URL \
    DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?sslmode=disable"
RUN npm run build

# One-shot migration runner for `docker compose` (prisma migrate deploy).
FROM deps AS migrate
COPY . .
ENTRYPOINT ["npx", "prisma", "migrate", "deploy"]

FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# The local attachment adapter writes to /app/.dev-data/uploads as the non-root
# user. Create it owned by nextjs so a brand-new named volume mounted there
# inherits that ownership (Docker copies image-path ownership on first use).
RUN mkdir -p /app/.dev-data/uploads \
  && chown -R nextjs:nodejs /app/.dev-data
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
