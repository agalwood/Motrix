# NAT Manager Docker Test Matrix

Six virtual routers for integration testing. See
`docs/superpowers/specs/2026-04-13-nat-manager-design.md` §"Testing Strategy"
for the design context.

## Images

| Name      | Binds             | Purpose                                        |
|-----------|-------------------|------------------------------------------------|
| upnp-v1   | tcp/49152         | miniupnpd 2.0 — IGD v1 behavior                |
| upnp-v2   | tcp/49153         | miniupnpd latest — IGD v2 behavior             |
| natpmp    | udp/5351          | natpmpd reference NAT-PMP                      |
| pcp-fake  | udp/5352          | Self-developed Python PCP server (MAP opcode)  |
| hostile   | tcp/49154         | Returns XXE / billion-laughs on HTTP GET       |
| broken    | tcp/49155 udp/5353| Returns malformed / truncated payloads         |

SSDP multicast (udp/1900) uses `network_mode: host` on Linux. On macOS and
Windows, the UPnP images publish their device description on the bound TCP
port and the integration harness sends synthetic M-SEARCH packets directly.

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
