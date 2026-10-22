# ODATANO ASTRA – analytics for Cardano and Midnight
# Build from the repo root:  docker build -f docker/Dockerfile -t ghcr.io/odatano/astra:local .
FROM node:22.23.4-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx tsc --noEmit

FROM node:22.23.4-slim
ENV NODE_ENV=production \
    PORT=4004 \
    CDS_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/db ./db
COPY --from=build /app/srv ./srv
COPY --from=build /app/app ./app
COPY --from=build /app/source-models ./source-models
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/docker/entrypoint.sh /app/docker/cds-config.mjs ./docker/
RUN chmod +x docker/entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 4004
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/odata/v4/analytics/SyncStatus?\$top=1" > /dev/null || exit 1
ENTRYPOINT ["docker/entrypoint.sh"]
CMD ["serve"]
