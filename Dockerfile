# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY assets ./assets
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN mkdir -p /data \
  && chown node:node /data

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY README.md LICENSE ./

ENV NODE_ENV=production \
    ERU_HOST=0.0.0.0 \
    ERU_PORT=3000 \
    ERU_SQLITE_PATH=/data/eru.sqlite

USER node
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
