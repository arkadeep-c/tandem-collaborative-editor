# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Dummy values satisfy import-time checks during `next build`;
# every page/route is dynamic, so nothing connects at build time.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    SESSION_SECRET=build-time-only-not-a-real-secret
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/.next ./.next
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

EXPOSE 3000
# Apply Tandem's idempotent SQL migrations before starting when PostgreSQL is configured.
# Local containers can still use the explicit SQLite fallback without DATABASE_URL.
# Vercel deployments should run npm run db:migrate as an explicit deploy step.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then npm run db:migrate; else echo 'DATABASE_URL not set; skipping PostgreSQL migrations (local SQLite fallback only).'; fi && npx next start"]
