#!/usr/bin/python3
"""Kernel NAT metadata interoperability lab; all interfaces live in a container."""

import argparse
import json
import os
import pathlib
import signal
import subprocess
import time
import urllib.request

ROOT = pathlib.Path("/work")


def run(*args, **kw):
    return subprocess.run(args, check=True, text=True, **kw)


def ns(name, *args, **kw):
    return run("ip", "netns", "exec", name, *args, **kw)


def spawn(name, args, logfile):
    return subprocess.Popen(
        ["ip", "netns", "exec", name, *args],
        stdout=open(logfile, "w"),
        stderr=subprocess.STDOUT,
    )


def setup():
    if os.environ.get("MOTRIX_NAT_LAB") != "1":
        raise RuntimeError("Run this lab through node tests/nat/run.mjs")
    for name in ["client", "rc", "seed", "rs", "relay", "holder"]:
        subprocess.run(["ip", "netns", "del", name], stderr=subprocess.DEVNULL)
    for name in ["w-rc", "w-rs", "w-relay", "br-lab"]:
        subprocess.run(["ip", "link", "del", name], stderr=subprocess.DEVNULL)
    run("ip", "link", "add", "br-lab", "type", "bridge")
    run("ip", "addr", "add", "10.77.0.1/24", "dev", "br-lab")
    run("ip", "link", "set", "br-lab", "up")
    for name in ["client", "rc", "seed", "rs", "relay", "holder"]:
        run("ip", "netns", "add", name)
        ns(name, "ip", "link", "set", "lo", "up")
    for name, ip in [("rc", "10.77.0.2"), ("rs", "10.77.0.3"), ("relay", "10.77.0.4")]:
        run(
            "ip",
            "link",
            "add",
            f"w-{name}",
            "type",
            "veth",
            "peer",
            "name",
            "wan",
            "netns",
            name,
        )
        run("ip", "link", "set", f"w-{name}", "master", "br-lab")
        run("ip", "link", "set", f"w-{name}", "up")
        ns(name, "ip", "addr", "add", ip + "/24", "dev", "wan")
        ns(name, "ip", "link", "set", "wan", "up")
    for host, router, lan, wan in [
        ("client", "rc", "10.77.1", "10.77.0.2"),
        ("seed", "rs", "10.77.2", "10.77.0.3"),
    ]:
        run(
            "ip",
            "link",
            "add",
            "eth0",
            "netns",
            host,
            "type",
            "veth",
            "peer",
            "name",
            "lan",
            "netns",
            router,
        )
        ns(host, "ip", "addr", "add", lan + ".2/24", "dev", "eth0")
        ns(host, "ip", "link", "set", "eth0", "up")
        ns(host, "ip", "route", "add", "default", "via", lan + ".1")
        ns(router, "ip", "addr", "add", lan + ".1/24", "dev", "lan")
        ns(router, "ip", "link", "set", "lan", "up")
        ns(router, "sysctl", "-qw", "net.ipv4.ip_forward=1")
        ns(router, "iptables", "-P", "FORWARD", "DROP")
        ns(
            router,
            "iptables",
            "-A",
            "INPUT",
            "-m",
            "conntrack",
            "--ctstate",
            "ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        )
        ns(router, "iptables", "-A", "INPUT", "-i", "wan", "-j", "DROP")
        ns(
            router,
            "iptables",
            "-A",
            "FORWARD",
            "-m",
            "conntrack",
            "--ctstate",
            "ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        )
        ns(
            router,
            "iptables",
            "-A",
            "FORWARD",
            "-i",
            "lan",
            "-o",
            "wan",
            "-j",
            "ACCEPT",
        )
        ns(router, "iptables", "-A", "FORWARD", "-j", "DROP")
        ns(
            router,
            "iptables",
            "-t",
            "nat",
            "-A",
            "POSTROUTING",
            "-o",
            "wan",
            "-j",
            "SNAT",
            "--to-source",
            wan,
        )


def reference(role, dest):
    import libtorrent as lt

    out = pathlib.Path(dest)
    out.mkdir(parents=True, exist_ok=True)
    settings = {
        "listen_interfaces": (
            "10.77.2.2:50000" if role == "seed" else "10.77.0.4:41000"
        ),
        "enable_dht": False,
        "enable_lsd": False,
        "enable_upnp": False,
        "enable_natpmp": False,
        "enable_outgoing_tcp": role != "seed",
        "enable_incoming_tcp": role != "seed",
        "enable_outgoing_utp": True,
        "enable_incoming_utp": True,
        "out_enc_policy": 2,
        "in_enc_policy": 2,
        "alert_mask": lt.alert.category_t.all_categories,
        "allow_multiple_connections_per_ip": True,
    }
    sess = lt.session(settings, flags=0 if role == "relay" else 1)
    if role == "relay":
        sess.add_extension(lt.create_ut_pex_plugin)
    data = (ROOT / "fixture.torrent").read_bytes()
    ti = lt.torrent_info(data)
    params = lt.add_torrent_params()
    params.save_path = str(out)
    if role == "seed":
        (out / "payload.bin").write_bytes(b"Motrix NAT metadata fixture\n" * 1024)
        params.ti = ti
        params.flags |= lt.torrent_flags.seed_mode | lt.torrent_flags.disable_pex
    else:
        params.info_hashes = ti.info_hashes()
    params.flags &= ~(lt.torrent_flags.paused | lt.torrent_flags.auto_managed)
    h = sess.add_torrent(params)
    begin = time.monotonic()
    last = 0
    while time.monotonic() - begin < 180:
        if role == "seed" and time.monotonic() - last > 3 and not h.get_peer_info():
            if os.environ.get("NAT_MAPPING_TEST"):
                target = out.parent / "tracker-port.json"
                ready = out.parent / "fetch" / "renewed.json"
                if target.exists() and (
                    ready.exists() or os.environ.get("NAT_MAPPING_TEST") == "negative"
                ):
                    h.connect_peer(
                        ("10.77.0.2", json.loads(target.read_text())["port"])
                    )
            else:
                h.connect_peer(("10.77.0.4", 41000))
            last = time.monotonic()
        for a in sess.pop_alerts():
            msg = a.message()
            if any(
                k in msg.lower()
                for k in [
                    "holepunch",
                    "pex",
                    "metadata",
                    "connect",
                    "disconnect",
                    "error",
                ]
            ):
                print(msg, flush=True)
        status = h.status()
        (out / "status.json").write_text(
            json.dumps(
                {
                    "metadata": status.has_metadata,
                    "peers": [
                        {"ip": p.ip, "flags": int(p.flags)} for p in h.get_peer_info()
                    ],
                }
            )
        )
        time.sleep(0.1)


def rpc(method, params=[]):
    data = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "taiji." + method,
            "params": ["token:nat-lab", *params],
        }
    ).encode()
    with urllib.request.urlopen(
        urllib.request.Request(
            "http://127.0.0.1:16880/jsonrpc", data, {"Content-Type": "application/json"}
        ),
        timeout=3,
    ) as r:
        v = json.load(r)
    if "error" in v:
        raise RuntimeError(v)
    return v["result"]


def fetch(hp, dest, policy):
    out = pathlib.Path(dest)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise RuntimeError("Fetcher output must be empty")
    cmd = [
        "/work/target/debug/taiji",
        "--enable-rpc",
        "--rpc-secret=nat-lab",
        "--rpc-listen-port=16880",
        "--listen-port=40000",
        "--enable-dht=false",
        "--enable-dht6=false",
        "--bt-lsd=false",
        "--bt-enable-upnp=false",
        "--bt-enable-nat-pmp=false",
        "--bt-peer-connection-type=" + policy,
        "--sqlite3-db-path=" + str(out / "taiji.sqlite3"),
        "--dir=" + str(out),
        "--log-level=debug",
    ]
    proc = subprocess.Popen(
        cmd, stdout=open(out / "taiji.log", "w"), stderr=subprocess.STDOUT
    )
    agent = None
    try:
        for _ in range(100):
            try:
                rpc("getVersion")
                break
            except Exception:
                if proc.poll() is not None:
                    raise RuntimeError("taiji exited")
                time.sleep(0.1)
        info = json.loads((ROOT / "fixture.json").read_text())
        uri = "magnet:?xt=urn:btih:" + info["hash"] + "&x.pe=10.77.0.4:41000"
        if os.environ.get("NAT_MAPPING_TEST"):
            uri = (
                "magnet:?xt=urn:btih:"
                + info["hash"]
                + "&tr=http%3A%2F%2F10.77.0.4%3A42000%2Fannounce"
            )
        if os.environ.get("NAT_MAPPING_TEST") == "positive":
            agent = subprocess.Popen(
                ["node", "/work/mapping-agent.cjs", str(out)],
                stdout=open(out / "mapping-agent.log", "w"),
                stderr=subprocess.STDOUT,
            )
        gid = rpc(
            "addUri",
            [
                [uri],
                {
                    "dir": str(out),
                    "bt-metadata-only": "true",
                    "bt-save-metadata": "true",
                    "motrix-metadata-holepunch": hp,
                },
            ],
        )
        start = time.monotonic()
        last = {}
        duration = 75 if hp == "true" else 40
        renew_requested = False
        while time.monotonic() - start < duration:
            if agent and not renew_requested and (out / "mapping-status.json").exists():
                states = json.loads((out / "mapping-status.json").read_text())
                if any(len(st.get("activeMappings", [])) == 2 for st in states):
                    agent.send_signal(signal.SIGUSR1)
                    renew_requested = True
            last = rpc("tellStatus", [gid])
            if last["status"] in ["complete", "error"]:
                break
            time.sleep(0.5)
        torrents = list(out.glob("*.torrent"))
        import libtorrent as lt

        verified = any(
            str(lt.torrent_info(str(p)).info_hashes().v1) == info["hash"]
            for p in torrents
        )
        result = {
            "holepunch": hp,
            "policy": policy,
            "seconds": round(time.monotonic() - start, 2),
            "status": last.get("status"),
            "verifiedMetadata": verified,
            "torrentBytes": [p.stat().st_size for p in torrents],
        }
        (out / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    finally:
        if agent:
            agent.terminate()
            try:
                agent.wait(timeout=15)
            except subprocess.TimeoutExpired:
                agent.kill()
                agent.wait()
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def main():
    import libtorrent as lt

    ap = argparse.ArgumentParser()
    ap.add_argument("--role", choices=["lab", "seed", "relay", "fetch"], default="lab")
    ap.add_argument("--hp", default="true")
    ap.add_argument("--policy", default="prefer-tcp")
    ap.add_argument("--dest", default="/work/run")
    a = ap.parse_args()
    if a.role in ["seed", "relay"]:
        return reference(a.role, a.dest)
    if a.role == "fetch":
        return fetch(a.hp, a.dest, a.policy)
    fixture = ROOT / "fixture-data"
    fixture.mkdir(exist_ok=True)
    (fixture / "payload.bin").write_bytes(b"Motrix NAT metadata fixture\n" * 1024)
    fs = lt.file_storage()
    lt.add_files(fs, str(fixture / "payload.bin"))
    ct = lt.create_torrent(fs, 16384, flags=lt.create_torrent.v1_only)
    lt.set_piece_hashes(ct, str(fixture))
    data = lt.bencode(ct.generate())
    (ROOT / "fixture.torrent").write_bytes(data)
    (ROOT / "fixture.json").write_text(
        json.dumps({"hash": str(lt.torrent_info(data).info_hashes().v1)})
    )
    setup()
    out = pathlib.Path(a.dest)
    out.mkdir(parents=True, exist_ok=True)
    ps = []
    capture = subprocess.Popen(
        ["tcpdump", "-U", "-n", "-i", "br-lab", "-w", str(out / "wan.pcap")],
        stdout=subprocess.DEVNULL,
        stderr=open(out / "tcpdump.log", "w"),
    )
    try:
        for role in ["relay", "seed"]:
            ps.append(
                spawn(
                    role,
                    [
                        "/usr/bin/python3",
                        "/work/fetching_lab.py",
                        "--role",
                        role,
                        "--dest",
                        str(out / role),
                    ],
                    out / (role + ".log"),
                )
            )
        time.sleep(5)
        ns(
            "client",
            "/usr/bin/python3",
            "/work/fetching_lab.py",
            "--role",
            "fetch",
            "--hp",
            a.hp,
            "--policy",
            a.policy,
            "--dest",
            str(out / "fetch"),
        )
        relay_state = json.loads((out / "relay" / "status.json").read_text())
        assert (
            relay_state["metadata"] is False
        ), "Introducer must never acquire metadata"
        assert (
            json.loads((out / "seed" / "status.json").read_text())["metadata"] is True
        )
        result = json.loads((out / "fetch" / "result.json").read_text())
        assert result["verifiedMetadata"] == (a.hp == "true"), result
        assert not (
            out / "fetch" / "payload.bin"
        ).exists(), "Metadata test downloaded payload"
        for router in ["rc", "rs"]:
            with open(out / (router + "-iptables.txt"), "w") as f:
                ns(router, "iptables-save", "-c", stdout=f)
            with open(out / (router + "-conntrack.txt"), "w") as f:
                ns(router, "conntrack", "-L", stdout=f, stderr=subprocess.STDOUT)
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
