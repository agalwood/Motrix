FROM alpine:3.19 AS build

# NOTE: Spec deviations from plan —
#  1. Plan pinned 2.3.7 via miniupnp.tuxfamily.org; bumped to 2.3.10 via
#     miniupnp.free.fr for consistency with upnp-v1 and to match the
#     currently canonical mirror.
#  2. Alpine's musl libc does not ship sys/queue.h, so we add the
#     bsd-compat-headers package (ships /usr/include/sys/queue.h).
ARG MINIUPNPD_VERSION=2.3.10

RUN apk add --no-cache \
        build-base \
        linux-headers \
        bsd-compat-headers \
        iptables-dev \
        libnfnetlink-dev \
        libnetfilter_conntrack-dev \
        bash \
        curl

WORKDIR /build
RUN curl -LO http://miniupnp.free.fr/files/miniupnpd-${MINIUPNPD_VERSION}.tar.gz \
 && tar -xzf miniupnpd-${MINIUPNPD_VERSION}.tar.gz \
 && cd miniupnpd-${MINIUPNPD_VERSION} \
 && ./configure --firewall=iptables --igd2 --vendorcfg \
 && make \
 && make install

FROM alpine:3.19
RUN apk add --no-cache iptables libip4tc libip6tc libnfnetlink libnetfilter_conntrack bash
COPY --from=build /usr/sbin/miniupnpd /usr/sbin/miniupnpd
COPY miniupnpd.conf /etc/miniupnpd/miniupnpd.conf

EXPOSE 1900/udp 49153/tcp

CMD ["miniupnpd", "-f", "/etc/miniupnpd/miniupnpd.conf", "-d"]
