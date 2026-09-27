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
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

EXPOSE 3000
# drizzle-kit push is idempotent; on a fresh volume it creates the schema.
CMD ["sh", "-c", "npx drizzle-kit push --force && npx next start"]
