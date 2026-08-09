# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY scripts/fetch-engine.mjs ./scripts/fetch-engine.mjs
# Server/Node image: no Electron rebuild, and no bundled aria2 either — the
# runtime stage installs system aria2 (apk) and points MOTRIX_ARIA2_BIN at it,
# so postinstall must skip BOTH stages (keeps the deps layer offline/hermetic).
ENV MOTRIX_SKIP_ELECTRON_REBUILD=1 \
    MOTRIX_SKIP_ENGINE_FETCH=1
RUN corepack enable \
 && corepack prepare pnpm@11.18.0 --activate \
 && pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm rebuild better-sqlite3 \
 && pnpm run check:third-party-notices \
 && pnpm build:server

FROM build AS runtime-deps
RUN pnpm prune --prod --ignore-scripts

FROM node:22-alpine AS runtime
RUN apk add --no-cache aria2 ca-certificates
WORKDIR /app
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/renderer-web ./dist/renderer-web
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/extra/aria2.conf ./extra/aria2.conf
COPY --from=build /app/dist/builtin-plugins ./builtin-plugins
COPY --from=build /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=build /app/THIRD_PARTY_NOTICES.zh-CN.md ./THIRD_PARTY_NOTICES.zh-CN.md
COPY --from=build /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=build /app/build/legal/THIRD_PARTY_DEPENDENCIES.md ./legal/THIRD_PARTY_DEPENDENCIES.md
COPY --from=build /app/build/legal/THIRD_PARTY_LICENSES.txt ./legal/THIRD_PARTY_LICENSES.txt
COPY --from=build /app/build/legal/sbom.spdx.json ./legal/sbom.spdx.json
ENV NODE_ENV=production \
    MOTRIX_DATA_DIR=/data \
    MOTRIX_EXTRA_DIR=/app/extra \
    MOTRIX_ARIA2_BIN=/usr/bin/aria2c \
    MOTRIX_RENDERER_DIR=/app/dist/renderer-web \
    MOTRIX_BUILTIN_PLUGIN_DIR=/app/builtin-plugins \
    PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/server/index.mjs"]
