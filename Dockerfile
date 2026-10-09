# FLOWOS production image: one process serves the API, the built client and the
# background worker. Build:  docker build -t flowos .
# Base images can be mirrored with --build-arg NODE_IMAGE=… (e.g. public.ecr.aws/docker/library/node:22-bookworm-slim).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Client bundle + server bundles (index, migrate, seed, flags); then drop dev dependencies.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/data/storage
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# Document storage lives on a mounted volume; never inside the image.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 3000
# Liveness only; route load-balancer traffic on /api/ready (checks the database).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are a release step:  node dist/server/migrate.js
CMD ["node", "dist/server/index.js"]
