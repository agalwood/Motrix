# Disposable acceptance environment. The tested Node runtime comes from the FPK.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates coreutils passwd util-linux \
    && rm -rf /var/lib/apt/lists/*
