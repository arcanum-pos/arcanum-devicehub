# tresjr-devicehub — the device registry and the live WebSocket hub, self-hosted (SELF_HOSTING.md).
# The same code as the Cloudflare Worker, bundled for Node (npm run build:node).
# The bundle is plain JavaScript: built once, on the build machine's own
# platform; only the image below is per architecture (amd64, arm64).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:node

FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/arcanum-pos/arcanum-devicehub" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.description="tresjr devicehub — the device registry and the live WebSocket hub"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
RUN mkdir -p /data && chown node:node /data
COPY --from=build /src/dist/node.mjs ./dist/node.mjs
USER node
EXPOSE 8080
CMD ["node", "dist/node.mjs"]
