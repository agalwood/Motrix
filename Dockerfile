# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/native-host/package.json ./packages/native-host/package.json
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY scripts/fetch-engine.mjs ./scripts/fetch-engine.mjs
# The Server image uses system aria2 and never rebuilds for Electron. Electron's
# locked install script is invoked explicitly in the build stage because the
# legal inventory requires its license payload.
ENV MOTRIX_SKIP_ELECTRON_REBUILD=1 \
    MOTRIX_SKIP_ENGINE_FETCH=1
RUN --mount=type=cache,id=motrix-pnpm-store,target=/pnpm/store \
    corepack enable \
 && corepack prepare pnpm@11.18.0 --activate \
 && pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

FROM node:24-alpine AS full-root-production-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/native-host/package.json ./packages/native-host/package.json
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY scripts/fetch-engine.mjs ./scripts/fetch-engine.mjs
ENV CI=true \
    MOTRIX_SKIP_ELECTRON_REBUILD=1 \
    MOTRIX_SKIP_ENGINE_FETCH=1
RUN --mount=type=cache,id=motrix-pnpm-store,target=/pnpm/store \
    corepack enable \
 && corepack prepare pnpm@11.18.0 --activate \
 && pnpm config set store-dir /pnpm/store \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM deps AS build
ARG TARGETARCH
WORKDIR /app
COPY . .
RUN node node_modules/electron/install.js
RUN --mount=type=cache,id=motrix-builtins,target=/app/node_modules/.cache/motrix-builtins \
    pnpm run check:third-party-notices \
 && pnpm run build:server \
 && node scripts/stage-server-app.mjs --platform linux --arch "${TARGETARCH}" --libc musl --strict \
 && node scripts/verify-server-package.mjs --app-dir dist/server-app --platform linux --arch "${TARGETARCH}" --libc musl

FROM scratch AS server-size-report
COPY --from=build /app/release/size-reports/ /

FROM node:24-alpine AS server-full-root-baseline
RUN apk add --no-cache aria2 ca-certificates \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /opt/yarn-v1.22.22 \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/pnpm /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data /downloads \
 && chown node:node /data /downloads
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/dist/core/plugin/host ./dist/core/plugin/host
COPY --from=build --chown=node:node /app/dist/renderer-web ./dist/renderer-web
COPY --from=full-root-production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/extra/aria2.conf ./extra/aria2.conf
COPY --from=build --chown=node:node /app/dist/builtin-plugins ./builtin-plugins
COPY --from=build --chown=node:node /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=build --chown=node:node /app/THIRD_PARTY_NOTICES.zh-CN.md ./THIRD_PARTY_NOTICES.zh-CN.md
COPY --from=build --chown=node:node /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=build --chown=node:node /app/build/legal/THIRD_PARTY_DEPENDENCIES.md ./legal/THIRD_PARTY_DEPENDENCIES.md
COPY --from=build --chown=node:node /app/build/legal/THIRD_PARTY_LICENSES.txt ./legal/THIRD_PARTY_LICENSES.txt
COPY --from=build --chown=node:node /app/build/legal/sbom.spdx.json ./legal/sbom.spdx.json
ENV YARN_VERSION= \
    NODE_ENV=production \
    MOTRIX_DATA_DIR=/data \
    MOTRIX_EXTRA_DIR=/app/extra \
    MOTRIX_ARIA2_BIN=/usr/bin/aria2c \
    MOTRIX_DEFAULT_SAVE_DIR=/downloads \
    MOTRIX_ALLOWED_SAVE_DIRS=/downloads \
    MOTRIX_RENDERER_DIR=/app/dist/renderer-web \
    MOTRIX_BUILTIN_PLUGIN_DIR=/app/builtin-plugins \
    PORT=8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
USER node
CMD ["node", "dist/server/index.mjs"]

FROM node:24-alpine AS runtime
RUN apk add --no-cache aria2 ca-certificates \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /opt/yarn-v1.22.22 \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/pnpm /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data /downloads \
 && chown node:node /data /downloads
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/server-app/ ./
ENV YARN_VERSION= \
    NODE_ENV=production \
    MOTRIX_DATA_DIR=/data \
    MOTRIX_EXTRA_DIR=/app/extra \
    MOTRIX_ARIA2_BIN=/usr/bin/aria2c \
    MOTRIX_DEFAULT_SAVE_DIR=/downloads \
    MOTRIX_ALLOWED_SAVE_DIRS=/downloads \
    MOTRIX_RENDERER_DIR=/app/dist/renderer-web \
    MOTRIX_BUILTIN_PLUGIN_DIR=/app/builtin-plugins \
    PORT=8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
USER node
CMD ["node", "dist/server/index.mjs"]
