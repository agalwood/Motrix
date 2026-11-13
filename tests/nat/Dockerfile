FROM node:24-bookworm-slim AS node
FROM rust:1.94.1
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iproute2 iptables nftables conntrack tcpdump miniupnpd python3 python3-libtorrent ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /work
CMD ["sleep", "infinity"]
