# Server image (HARD-A1) — ONE image, three roles.
# The same built code runs as the API, the worker fleet, or the single-leader
# scheduler; PROCESS_ROLE (set per docker-compose service) selects which
# components start. Scale `worker` horizontally; run exactly ONE `scheduler`.
FROM node:20-alpine AS build
WORKDIR /app

# Install workspace deps (root + server). The repo is an npm workspace, so the
# root package.json + lockfile drive install; the server package is a workspace.
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json ./server/
RUN npm ci --workspace server --include-workspace-root

COPY server ./server
# M1 removed Prisma — there is no `db:generate` script anymore; `npm run build`
# (tsc) is the whole build. The Drizzle client is code, not a generated artifact.
RUN npm run build --workspace server

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/
# The migration SQL is still owned by prisma/migrations/ (the Prisma *runtime* is
# gone; the .sql files remain the live-Neon schema source). Ship them + the
# apply-migration.ts runner and its source imports so a deploy can run migrations
# from this same image
# (`npx tsx prisma/apply-migration.ts prisma/migrations/<dir>/migration.sql`).
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/server/src ./server/src
# The shared classifier spec (MED-A2) is read at runtime from <repo>/shared.
COPY shared ./shared

WORKDIR /app/server
# Default role is "all"; docker-compose overrides PROCESS_ROLE per service.
CMD ["node", "dist/index.js"]
