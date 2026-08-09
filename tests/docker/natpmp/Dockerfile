FROM motrix-test/upnp-v1:latest

# Override config to serve ONLY NAT-PMP (disable UPnP/SSDP).
COPY natpmpd.conf /etc/miniupnpd/miniupnpd.conf

EXPOSE 5351/udp
