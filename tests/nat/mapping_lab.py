#!/usr/bin/python3
import json
import os
import pathlib
import signal
import socket
import struct
import subprocess
import sys
import time
from fetching_lab import ROOT, run, ns, spawn, setup


def reserve():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("10.77.1.3", 0))
    sock.settimeout(3)
    results = []
    for opcode in [1, 2]:
        sock.sendto(
            struct.pack("!BBHHHI", 0, opcode, 0, 40000, 40000, 7200),
            ("10.77.1.1", 5351),
        )
        data, _ = sock.recvfrom(1024)
        value = struct.unpack("!BBHIHHI", data)
        assert value[2] == 0 and value[5] == 40000, value
        results.append(value)
    print(json.dumps(results), flush=True)


def tracker(dest):
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from urllib.parse import urlparse, parse_qs
    import libtorrent as lt

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            query = parse_qs(urlparse(self.path).query)
            if urlparse(self.path).path == "/scrape":
                data = lt.bencode({b"files": {}})
                self.send_response(200)
                self.end_headers()
                self.wfile.write(data)
                return
            port = int(query["port"][0])
            print(json.dumps({"port": port}), flush=True)
            (pathlib.Path(dest) / "tracker-port.json").write_text(
                json.dumps({"port": port})
            )
            data = lt.bencode({b"interval": 10, b"peers": b""})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(data)

    HTTPServer(("10.77.0.4", 42000), Handler).serve_forever()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "reserve":
        return reserve()
    if len(sys.argv) > 1 and sys.argv[1] == "tracker":
        return tracker(sys.argv[2])
    mode = sys.argv[1] if len(sys.argv) > 1 else "positive"
    if mode == "positive" and not (ROOT / "mapping-agent.cjs").is_file():
        raise RuntimeError("Build mapping-agent.cjs through tests/nat/run.mjs first")
    out = ROOT / (sys.argv[2] if len(sys.argv) > 2 else "mapping-" + mode)
    out.mkdir(exist_ok=True)
    setup()
    ns("rc", "ip", "addr", "del", "10.77.1.1/24", "dev", "lan")
    ns("rc", "ip", "link", "set", "lan", "name", "client-lan")
    ns("rc", "ip", "link", "add", "lan", "type", "bridge")
    ns("rc", "ip", "link", "set", "client-lan", "master", "lan")
    ns("rc", "ip", "addr", "add", "10.77.1.1/24", "dev", "lan")
    ns("rc", "ip", "link", "set", "lan", "up")
    run(
        "ip",
        "link",
        "add",
        "eth0",
        "netns",
        "holder",
        "type",
        "veth",
        "peer",
        "name",
        "holder-lan",
        "netns",
        "rc",
    )
    ns("rc", "ip", "link", "set", "holder-lan", "master", "lan")
    ns("rc", "ip", "link", "set", "holder-lan", "up")
    ns("holder", "ip", "addr", "add", "10.77.1.3/24", "dev", "eth0")
    ns("holder", "ip", "link", "set", "eth0", "up")
    ns("holder", "ip", "route", "add", "default", "via", "10.77.1.1")
    ns(
        "rc",
        "iptables",
        "-I",
        "FORWARD",
        "1",
        "-m",
        "conntrack",
        "--ctstate",
        "DNAT",
        "-j",
        "ACCEPT",
    )
    rules = """table inet miniupnpd {
      chain forward { type filter hook forward priority -1; policy accept; jump miniupnpd; }
      chain miniupnpd { }
      chain prerouting { type nat hook prerouting priority -101; policy accept; jump prerouting_miniupnpd; }
      chain prerouting_miniupnpd { }
      chain postrouting { type nat hook postrouting priority 99; policy accept; jump postrouting_miniupnpd; }
      chain postrouting_miniupnpd { }
    }"""
    ns("rc", "nft", "-f", "-", input=rules)
    conf = out / "miniupnpd.conf"
    conf.write_text("""ext_ifname=wan
listening_ip=lan
ext_allow_private_ipv4=yes
enable_upnp=no
enable_pcp_pmp=yes
ipv6_disable=yes
upnp_table_name=miniupnpd
upnp_nat_table_name=miniupnpd
allow 1024-65535 10.77.1.0/24 1024-65535
deny 0-65535 0.0.0.0/0 0-65535
""")
    ps = []
    os.environ["NAT_MAPPING_TEST"] = mode
    capture = subprocess.Popen(
        ["tcpdump", "-U", "-n", "-i", "br-lab", "-w", str(out / "wan.pcap")],
        stdout=subprocess.DEVNULL,
        stderr=open(out / "tcpdump.log", "w"),
    )
    try:
        ps.append(
            spawn(
                "rc",
                ["miniupnpd", "-d", "-f", str(conf), "-P", str(out / "miniupnpd.pid")],
                out / "miniupnpd.log",
            )
        )
        time.sleep(1)
        with open(out / "reserved.json", "w") as f:
            ns("holder", "python3", "/work/mapping_lab.py", "reserve", stdout=f)
        ps.append(
            spawn(
                "relay",
                ["python3", "/work/mapping_lab.py", "tracker", str(out)],
                out / "tracker.log",
            )
        )
        ps.append(
            spawn(
                "seed",
                [
                    "python3",
                    "/work/fetching_lab.py",
                    "--role",
                    "seed",
                    "--dest",
                    str(out / "seed"),
                ],
                out / "seed.log",
            )
        )
        time.sleep(1)
        ns(
            "client",
            "python3",
            "/work/fetching_lab.py",
            "--role",
            "fetch",
            "--hp",
            "false",
            "--dest",
            str(out / "fetch"),
        )
        result = json.loads((out / "fetch" / "result.json").read_text())
        assert result["verifiedMetadata"] == (mode == "positive"), result
        if mode == "positive":
            updates = json.loads((out / "fetch" / "mapping-updates.json").read_text())
            assert any(
                any(m["tcp"] == 40001 and m["udp"] == 40001 for m in update)
                for update in updates
            )
            assert json.loads((out / "tracker-port.json").read_text())["port"] == 40001
            renewed = json.loads((out / "fetch" / "renewed.json").read_text())
            assert all(len(m["activeMappings"]) == 2 for m in renewed)
            stopped = json.loads((out / "fetch" / "mapping-stopped.json").read_text())
            assert all(
                m["state"] == "stopped" and not m["activeMappings"] for m in stopped
            )
        with open(out / "rc-nft-after-stop.txt", "w") as f:
            ns("rc", "nft", "list", "table", "inet", "miniupnpd", stdout=f)
        for router in ["rc", "rs"]:
            with open(out / (router + "-iptables.txt"), "w") as f:
                ns(router, "iptables-save", "-c", stdout=f)
    finally:
        for p in ps:
            p.terminate()
        for p in ps:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        capture.send_signal(signal.SIGINT)
        capture.wait(timeout=5)


if __name__ == "__main__":
    main()
