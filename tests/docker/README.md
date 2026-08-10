# NAT Manager Docker Test Matrix

Six virtual routers for integration testing. See
`docs/superpowers/specs/2026-04-13-nat-manager-design.md` §"Testing Strategy"
for the design context.

## Images

| Name      | Binds                      | Purpose                                        |
|-----------|----------------------------|------------------------------------------------|
| upnp-v1   | tcp/49152 (host mode)      | miniupnpd 2.0 — IGD v1 behavior                |
| upnp-v2   | tcp/49153 (host mode)      | miniupnpd latest — IGD v2 behavior             |
| natpmp    | udp/5351 (host mode)       | natpmpd reference NAT-PMP                      |
| pcp-fake  | udp/5351 (bridge)          | Self-developed Python PCP server (MAP opcode)  |
| hostile   | tcp/49154 (bridge)         | Returns XXE / billion-laughs on HTTP GET       |
| broken    | tcp/49155 udp/5353 (bridge)| Returns malformed / truncated payloads         |

SSDP multicast (udp/1900) uses `network_mode: host` on Linux. The miniupnpd
confs set `listening_ip=eth0` (GitHub runners' primary NIC) because miniupnpd
ignores any sender outside its LAN subnet. On macOS and Windows, the UPnP
images publish their device description on the bound TCP port and the
integration harness sends synthetic M-SEARCH packets directly.

Bridge-network services are addressed by their container IP (see
`containerIp()` in `tests/integration/helpers/docker-harness.ts`), never via
`127.0.0.1:published-port`: the NAT clients' SSRF guards reject loopback, and
pcp-fake can only own the client's hardcoded PCP port 5351 inside its own
network namespace.

## Quick start

```bash
cd tests/docker
make build       # build all six images
make up          # docker compose up -d
make test        # run integration tests against the matrix
make down        # tear down
make clean       # remove built images
```

## CI

Linux CI runs the full matrix in `.github/workflows/nat-integration.yml`.
macOS / Windows CI runs the unit + codec tests only.

## Manual fallback

If Docker is unavailable, run the harness against a single Python fake
server locally:

```bash
python3 tests/docker/pcp-fake/pcp_server.py &
pnpm exec vitest run tests/integration/nat-docker.test.ts -t "pcp-fake"
```
