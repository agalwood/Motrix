# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG NODE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
FROM ${NODE_IMAGE} AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/native-host/package.json ./packages/native-host/package.json
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY scripts/fetch-engine.mjs ./scripts/fetch-engine.mjs
# The Server build fetches its target-specific aria2_motrix release explicitly.
# Electron's locked install script is invoked in the build stage because the
# legal inventory requires its license payload.
ENV MOTRIX_SKIP_ELECTRON_REBUILD=1 \
    MOTRIX_SKIP_ENGINE_FETCH=1
RUN --mount=type=cache,id=motrix-pnpm-store,target=/pnpm/store \
    corepack enable \
 && corepack prepare pnpm@11.22.0 --activate \
 && pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

FROM ${NODE_IMAGE} AS full-root-production-deps
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
 && corepack prepare pnpm@11.22.0 --activate \
 && pnpm config set store-dir /pnpm/store \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM deps AS build
ARG TARGETARCH
WORKDIR /app
COPY . .
RUN node node_modules/electron/install.js
RUN --mount=type=cache,id=motrix-builtins,target=/app/node_modules/.cache/motrix-builtins \
    case "${TARGETARCH}" in \
      amd64) engine_arch=x64 ;; \
      arm64) engine_arch=arm64 ;; \
      *) echo "unsupported Docker target architecture: ${TARGETARCH}" >&2; exit 2 ;; \
    esac \
 && node scripts/fetch-engine.mjs --platform linux --arch "${engine_arch}" \
 && pnpm run check:third-party-notices \
 && pnpm run build:server \
 && node scripts/stage-server-app.mjs --platform linux --arch "${TARGETARCH}" --libc musl --strict \
 && node scripts/verify-server-package.mjs --app-dir dist/server-app --platform linux --arch "${TARGETARCH}" --libc musl

FROM scratch AS server-size-report
COPY --from=build /app/release/size-reports/ /

FROM ${NODE_IMAGE} AS server-full-root-baseline
RUN apk add --no-cache ca-certificates \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /opt/yarn-v1.22.22 \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/pnpm /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && printf '%s\n' '#!/bin/sh' 'exec node /app/dist/server/motrix-admin.mjs "$@"' > /usr/local/bin/motrix-admin \
 && chmod 0755 /usr/local/bin/motrix-admin \
 && mkdir -p /data/home /data/tmp /downloads \
 && chown -R node:node /data /downloads
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/dist/core/plugin/host ./dist/core/plugin/host
COPY --from=build --chown=node:node /app/dist/renderer-web ./dist/renderer-web
COPY --from=build --chown=node:node /app/dist/server-app/bin/aria2c ./bin/aria2c
COPY --from=full-root-production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/extra/aria2.conf ./extra/aria2.conf
COPY --from=build --chown=node:node /app/dist/builtin-plugins ./builtin-plugins
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE
COPY --from=build --chown=node:node /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=build --chown=node:node /app/THIRD_PARTY_NOTICES.zh-CN.md ./THIRD_PARTY_NOTICES.zh-CN.md
COPY --from=build --chown=node:node /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=build --chown=node:node /app/build/legal/THIRD_PARTY_DEPENDENCIES.md ./legal/THIRD_PARTY_DEPENDENCIES.md
COPY --from=build --chown=node:node /app/build/legal/THIRD_PARTY_LICENSES.txt ./legal/THIRD_PARTY_LICENSES.txt
COPY --from=build --chown=node:node /app/build/legal/sbom.spdx.json ./legal/sbom.spdx.json
ENV YARN_VERSION= \
    PATH=/app/bin:${PATH} \
    NODE_ENV=production \
    MOTRIX_DATA_DIR=/data \
    MOTRIX_TEMP_DIR=/data/tmp \
    MOTRIX_PLUGIN_DIR=/data/plugins \
    MOTRIX_EXTRA_DIR=/app/extra \
    MOTRIX_ARIA2_BIN=/app/bin/aria2c \
    MOTRIX_DEFAULT_SAVE_DIR=/downloads \
    MOTRIX_ALLOWED_SAVE_DIRS=/downloads \
    MOTRIX_RENDERER_DIR=/app/dist/renderer-web \
    MOTRIX_BUILTIN_PLUGIN_DIR=/app/builtin-plugins \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    HOME=/data/home \
    TMPDIR=/data/tmp \
    PORT=8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.mjs"]

FROM ${NODE_IMAGE} AS runtime
ARG OCI_REVISION=unknown
ARG OCI_VERSION=0.0.0-local
RUN apk add --no-cache ca-certificates \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /opt/yarn-v1.22.22 \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/pnpm /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && printf '%s\n' '#!/bin/sh' 'exec node /app/dist/server/motrix-admin.mjs "$@"' > /usr/local/bin/motrix-admin \
 && chmod 0755 /usr/local/bin/motrix-admin \
 && mkdir -p /data/home /data/tmp /downloads \
 && chown -R node:node /data /downloads
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/server-app/ ./
LABEL org.opencontainers.image.title="Motrix Server" \
      org.opencontainers.image.description="Motrix Server web download manager for persistent NAS deployments" \
      org.opencontainers.image.url="https://motrix.app" \
      org.opencontainers.image.documentation="https://github.com/agalwood/Motrix/blob/main/docs/docker-server.md" \
      org.opencontainers.image.source="https://github.com/agalwood/Motrix" \
      org.opencontainers.image.revision="${OCI_REVISION}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.licenses="MIT"
ENV YARN_VERSION= \
    PATH=/app/bin:${PATH} \
    NODE_ENV=production \
    MOTRIX_DATA_DIR=/data \
    MOTRIX_TEMP_DIR=/data/tmp \
    MOTRIX_PLUGIN_DIR=/data/plugins \
    MOTRIX_EXTRA_DIR=/app/extra \
    MOTRIX_ARIA2_BIN=/app/bin/aria2c \
    MOTRIX_DEFAULT_SAVE_DIR=/downloads \
    MOTRIX_ALLOWED_SAVE_DIRS=/downloads \
    MOTRIX_RENDERER_DIR=/app/dist/renderer-web \
    MOTRIX_BUILTIN_PLUGIN_DIR=/app/builtin-plugins \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    HOME=/data/home \
    TMPDIR=/data/tmp \
    PORT=8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.mjs"]
