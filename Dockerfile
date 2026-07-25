# Shared image for both the Next.js server and the worker; they differ only in
# the command they run, which keeps the Prisma client and lib/ identical
# between them.
FROM node:20-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# openssl is required by Prisma's query engine; ffmpeg by the media pipeline.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*


FROM base AS deps
COPY package.json package-lock.json ./
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
