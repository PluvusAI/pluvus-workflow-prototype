# Server image (HARD-A1) — ONE image, three roles.
# The same built code runs as the API, the worker fleet, or the single-leader
# scheduler; PROCESS_ROLE (set per docker-compose service) selects which
# components start. Scale `worker` horizontally; run exactly ONE `scheduler`.
FROM node:20-alpine AS build
WORKDIR /app

# PLU-139: puppeteer's own postinstall downloads a glibc-linked Chromium,
# which does not run on Alpine's musl libc anyway (the runtime stage below
# installs Alpine's own system `chromium` package instead and points
# PUPPETEER_EXECUTABLE_PATH at it). Skipping the download here just saves
# build time/image size on a browser build that would never run.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# node:20-alpine ships npm 10.8.2, which has a real npm-itself bug ("Exit
# handler never called!", npm/cli#7657-class issue): under `npm ci`, npm can
# crash mid-install but still exit 0, so Docker sees the RUN step as
# successful even though node_modules is incomplete (typescript/tsc silently
# missing) — surfaces later as a confusing `sh: tsc: not found` on the build
# step below, not here. Pinning past 10.8.2 avoids it.
RUN npm install -g npm@11

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

# PLU-139 §2: headless-Chrome system libs for Puppeteer's HTML→PDF render
# (server/src/workers/campaignBriefRenderWorker.ts). Alpine's own `chromium`
# package (musl-compatible) is installed instead of puppeteer's bundled
# glibc build (skipped above) — PUPPETEER_EXECUTABLE_PATH points Puppeteer
# at it; every `puppeteer.launch()` call picks it up automatically, no code
# path needs to know whether it's running in dev (bundled Chromium, any OS)
# or here. This runs in EVERY role's image (api/worker/scheduler all share
# one image per the file's own header comment) even though only
# PROCESS_ROLE=worker ever actually launches Chromium — simplest to keep one
# image, and the added size is Alpine's own chromium package, not a second
# bundled browser.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

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
