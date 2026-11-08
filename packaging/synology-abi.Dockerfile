FROM rust:1.94.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends qemu-user \
 && rm -rf /var/lib/apt/lists/*
