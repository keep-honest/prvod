# ── Base: Debian Bookworm slim with the Remotion runtime libraries ───
# Remotion's official Docker docs (https://www.remotion.dev/docs/docker) forbid
# Alpine because chrome-headless-shell is glibc-linked; on musl the binary
# downloads but silently fails to dlopen its shared libraries. The shared apt
# list is installed exactly once so the deps stage and the runner stage cannot
# drift out of sync — a drift would re-introduce the silent-failure hazard.
FROM node:26-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libnss3 \
      libdbus-1-3 \
      libatk1.0-0 \
      libgbm-dev \
      libasound2 \
      libxrandr2 \
      libxkbcommon-dev \
      libxfixes3 \
      libxcomposite1 \
      libxdamage1 \
      libatk-bridge2.0-0 \
      libpango-1.0-0 \
      libcairo2 \
      libcups2 \
      fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# ── Stage 1: Install production dependencies ─────────────────────────
# This stage produces the node_modules that ship in the final image.
# When VIDEO_COMPOSITOR=ffmpeg (default), Remotion packages are explicitly
# removed to save ~80MB — they are never imported at runtime in the ffmpeg path.
# NOTE: We cannot use --omit=optional because sharp and @node-rs/argon2
# publish their native platform binaries as optionalDependencies.
FROM base AS deps
ARG VIDEO_COMPOSITOR=ffmpeg
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    if [ "$VIDEO_COMPOSITOR" != "remotion" ]; then \
      rm -rf node_modules/@remotion node_modules/remotion; \
    fi

# Pre-bake Chrome Headless Shell when shipping the Remotion compositor so the
# 110 MB download never happens at render time. Skipped when Remotion packages
# were pruned above (the ffmpeg path has no use for the browser). The directory
# probe after the conditional fails the build if the binary was not actually
# baked — protects against silently shipping an image with the original hang.
RUN set -e && \
    echo "VIDEO_COMPOSITOR=${VIDEO_COMPOSITOR}" && \
    if [ "$VIDEO_COMPOSITOR" = "remotion" ]; then \
      npx --no-install remotion browser ensure && \
      test -d node_modules/.remotion/chrome-headless-shell || \
        (echo "FATAL: remotion browser ensure ran but chrome-headless-shell directory is missing" >&2 && exit 1); \
    fi

# ── Stage 2: Build the application ───────────────────────────────────
# Builder always installs ALL packages (including Remotion) because
# next build compiles every source file under src/, and the Remotion
# components have static imports that require the type definitions.
# Uses the bookworm-slim base directly (no chrome libs needed for build).
FROM node:26-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 3: Minimal production runtime ──────────────────────────────
# Inherits the same Remotion apt libs from `base`, then layers ffmpeg for the
# default FFmpegCompositor path. Sharing the base guarantees the runtime libs
# match the binary that was pre-baked into node_modules in the deps stage.
FROM base AS runner
ARG VIDEO_COMPOSITOR=ffmpeg

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
# Bake the build-time compositor choice as the runtime default.
# Prevents mismatch: if Remotion packages were pruned at build time,
# the runtime won't accidentally try to use them.
ENV VIDEO_COMPOSITOR=$VIDEO_COMPOSITOR

# Next.js standalone output includes server.js + traced node_modules subset
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Provide externalized packages (pg, drizzle-orm, remotion if selected, etc.)
# that standalone tracing intentionally excludes. node_modules carries the
# pre-baked chrome-headless-shell under node_modules/.remotion/ for the
# Remotion compositor path.
COPY --from=deps /app/node_modules ./node_modules

COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts/migrate.mjs ./scripts/migrate.mjs
# Remotion bundles its TSX entry point at runtime, so standalone tracing is not
# enough when VIDEO_COMPOSITOR=remotion. Copy only the render source closure
# needed by src/infrastructure/video/RemotionCompositor.ts.
COPY --from=builder /app/src/infrastructure/video/remotion ./src/infrastructure/video/remotion
COPY --from=builder /app/src/infrastructure/video/codeLineMapping.ts ./src/infrastructure/video/codeLineMapping.ts
COPY --from=builder /app/src/lib/narrationText.ts ./src/lib/narrationText.ts
COPY --from=builder /app/src/lib/logger.ts ./src/lib/logger.ts

# Final defence-in-depth check: when shipping the Remotion compositor, the
# pre-baked Chrome binary must be present in the runner image.
RUN if [ "$VIDEO_COMPOSITOR" = "remotion" ]; then \
      test -d node_modules/.remotion/chrome-headless-shell || \
        (echo "FATAL: runner image is missing node_modules/.remotion/chrome-headless-shell" >&2 && exit 1); \
    fi

EXPOSE 3000

CMD ["node", "server.js"]
