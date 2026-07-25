# Shared image for both the Next.js server and the worker; they differ only in
# the command they run, which keeps the Prisma client and lib/ identical
# between them.
FROM node:20-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# openssl is required by Prisma's query engine; ffmpeg by the media pipeline;
# adb by the Android driver, which also runs the shared adb server container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg curl adb \
 && rm -rf /var/lib/apt/lists/*

# The Docker CLI only — the worker talks to the host's daemon over the mounted
# socket and never runs one of its own. Only the client binary is extracted, so
# this adds a few MB rather than the whole engine.
ARG TARGETARCH
ARG DOCKER_CLI_VERSION=27.3.1
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) docker_arch=x86_64 ;; \
      arm64) docker_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /usr/local/bin --strip-components=1 docker/docker; \
    docker --version


FROM base AS deps
COPY package.json package-lock.json ./
# The schema comes along because `npm ci` now runs `prisma generate` as a
# postinstall hook; without it here the install fails inside the image while
# working fine on a developer's machine.
COPY prisma ./prisma
RUN npm ci


FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` runs `prisma generate` first (see package.json), so the generated
# client is baked into the image rather than produced at container start.
RUN npm run build


FROM base AS runtime
ENV NODE_ENV=production

# Migrations run from the image, so the Prisma CLI and schema must be present.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next

# Both halves of the generated client are required. @prisma/client is the thin
# entry point; the code and query engine it loads live in node_modules/.prisma,
# which `npm ci` alone does not produce. Copying only the former fails at
# runtime with "Cannot find module '.prisma/client/default'".
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json prisma.config.ts tsconfig.json next.config.mjs* ./
COPY prisma ./prisma
COPY public ./public
COPY app ./app
COPY lib ./lib
COPY worker ./worker

# Media staging happens under a non-root user; give it a writable storage root.
RUN useradd --system --create-home --uid 10001 appuser \
 && mkdir -p /app/.storage \
 && chown -R appuser:appuser /app/.storage
USER appuser

EXPOSE 3000
CMD ["npm", "run", "start"]
