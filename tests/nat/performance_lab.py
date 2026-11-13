#!/usr/bin/python3
"""Metadata latency/fault matrix against real peers inside the NAT lab container."""

import argparse
import asyncio
import hashlib
import json
import pathlib
import signal
import socket
import struct
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import quote

import libtorrent as lt
from fetching_lab import ROOT, ns, setup, spawn, rpc


def fixture(directory, padding):
    directory.mkdir(parents=True, exist_ok=True)
    payload = b"Motrix metadata performance fixture\n" * 128
    info = {
        b"length": len(payload),
        b"name": b"payload.bin",
        b"piece length": 16384,
        b"pieces": hashlib.sha1(payload).digest(),
        b"padding": b"m" * padding,
    }
    metadata = lt.bencode(info)
    (directory / "info.bin").write_bytes(metadata)
    (directory / "fixture.torrent").write_bytes(lt.bencode({b"info": info}))
    (directory / "payload.bin").write_bytes(payload)
    return hashlib.sha1(metadata).hexdigest()


def seed(directory, port):
    settings = {
        "listen_interfaces": f"10.77.0.4:{port}",
        "enable_dht": False,
        "enable_lsd": False,
        "enable_upnp": False,
        "enable_natpmp": False,
        "out_enc_policy": 2,
        "in_enc_policy": 2,
        "alert_mask": lt.alert.category_t.all_categories,
    }
    session = lt.session(settings)
    handles = []
    for source in directory.glob("fixture*.torrent"):
        params = lt.add_torrent_params()
        params.ti = lt.torrent_info(str(source))
        params.save_path = str(directory)
        params.flags |= lt.torrent_flags.seed_mode | lt.torrent_flags.disable_pex
        params.flags &= ~(lt.torrent_flags.paused | lt.torrent_flags.auto_managed)
        handles.append(session.add_torrent(params))
    while True:
        for alert in session.pop_alerts():
            message = alert.message()
            if "metadata" in message.lower() or "disconnect" in message.lower():
                print(message, flush=True)
        assert all(handle.is_valid() for handle in handles)
        time.sleep(0.1)


def tracker(ports):
    peers = b"".join(
        socket.inet_aton("10.77.0.4") + struct.pack("!H", port) for port in ports
    )

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(lt.bencode({b"interval": 2, b"peers": peers}))

        def log_message(self, *_):
            pass

    HTTPServer(("10.77.0.4", 42000), Handler).serve_forever()


async def faulty(directory, port, mode):
    metadata = (directory / "info.bin").read_bytes()
    info_hash = hashlib.sha1(metadata).digest()
    peer_id = (f"-MF0001-{port:012}".encode())[:20]

    async def connection(reader, writer):
        try:
            handshake = await asyncio.wait_for(reader.readexactly(68), 8)
            if handshake[28:48] != info_hash:
                return
            writer.write(
                b"\x13BitTorrent protocol" + b"\0\0\0\0\0\x10\0\0" + info_hash + peer_id
            )
            fields = {b"m": {b"ut_metadata": 3}}
            if mode != "no-size":
                fields[b"metadata_size"] = len(metadata)

            def send(extension, payload):
                frame = b"\x14" + bytes([extension]) + payload
                writer.write(struct.pack("!I", len(frame)) + frame)

            send(0, lt.bencode(fields))
            await writer.drain()
            remote_id = 2
            while True:
                size = struct.unpack("!I", await reader.readexactly(4))[0]
                if size > 2 * 1024 * 1024:
                    return
                frame = await reader.readexactly(size)
                if len(frame) < 2 or frame[0] != 20:
                    continue
                message = lt.bdecode(frame[2:])
                if frame[1] == 0:
                    remote_id = message.get(b"m", {}).get(b"ut_metadata", remote_id)
                    continue
                if frame[1] != 3 or message.get(b"msg_type") != 0:
                    continue
                index = message[b"piece"]
                if mode == "stall":
                    continue
                reject = (mode == "even" and index % 2 == 1) or (
                    mode == "odd" and index % 2 == 0
                )
                if reject:
                    send(remote_id, lt.bencode({b"msg_type": 2, b"piece": index}))
                else:
                    block = metadata[index * 16384 : (index + 1) * 16384]
                    if mode == "corrupt" and block:
                        block = bytes([block[0] ^ 1]) + block[1:]
                    send(
                        remote_id,
                        lt.bencode(
                            {
                                b"msg_type": 1,
                                b"piece": index,
                                b"total_size": len(metadata),
                            }
                        )
                        + block,
                    )
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, TimeoutError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass

    server = await asyncio.start_server(connection, "10.77.0.4", port)
    async with server:
        await server.serve_forever()


def fetch(directory, engine, budget, repeats, policy, dht=False):
    process = subprocess.Popen(
        [
            engine,
            "--enable-rpc",
            "--rpc-secret=nat-lab",
            "--rpc-listen-port=16880",
            "--listen-port=40000",
            "--enable-dht=true" if dht else "--enable-dht=false",
            "--dht-entry-point=10.77.0.4:49000",
            "--enable-dht6=false",
            "--bt-lsd=false",
            "--bt-enable-upnp=false",
            "--bt-enable-nat-pmp=false",
            f"--bt-peer-connection-type={policy}",
            f"--sqlite3-db-path={directory}/taiji.sqlite3",
            f"--dir={directory}",
            "--log-level=debug",
        ],
        stdout=open(directory / "engine.log", "w"),
        stderr=subprocess.STDOUT,
    )
    results = []
    try:
        for _ in range(100):
            try:
                rpc("getVersion")
                break
            except Exception:
                if process.poll() is not None:
                    raise RuntimeError("Engine exited before RPC became ready")
                time.sleep(0.05)
        for index in range(repeats):
            source = directory / ("info-second.bin" if dht and index else "info.bin")
            info_hash = hashlib.sha1(source.read_bytes()).hexdigest()
            uri = f"magnet:?xt=urn:btih:{info_hash}"
            if not dht:
                uri += "&tr=" + quote("http://10.77.0.4:42000/announce", safe="")
            output = directory / f"download-{index}"
            output.mkdir()
            started = time.monotonic()
            gid = rpc(
                "addUri",
                [
                    [uri],
                    {
                        "dir": str(output),
                        "bt-metadata-only": "true",
                        "bt-save-metadata": "true",
                    },
                ],
            )
            status = {}
            while time.monotonic() - started < budget:
                status = rpc("tellStatus", [gid])
                if status["status"] in ("complete", "error"):
                    break
                time.sleep(0.02)
            artifacts = list(output.glob("*.torrent"))
            verified = any(
                str(lt.torrent_info(str(p)).info_hashes().v1) == info_hash
                for p in artifacts
            )
            assert not (
                output / "payload.bin"
            ).exists(), "metadata fetch downloaded payload"
            results.append(
                {
                    "seconds": round(time.monotonic() - started, 3),
                    "status": status.get("status"),
                    "verified": verified,
                }
            )
            if status.get("status") == "active":
                rpc("forceRemove", [gid])
                for _ in range(50):
                    if rpc("tellStatus", [gid])["status"] in (
                        "removed",
                        "error",
                        "complete",
                    ):
                        break
                    time.sleep(0.02)
            rpc("removeDownloadResult", [gid])
        (directory / "result.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(results), flush=True)
    finally:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def run_case(
    root,
    label,
    engine,
    padding,
    delay,
    modes,
    policy="tcp",
    loss=0,
    budget=45,
    repeats=1,
    dht=False,
):
    output = root / label
    fixture(output, padding)
    if dht:
        second = lt.bdecode((output / "fixture.torrent").read_bytes())
        original_hash = hashlib.sha1((output / "info.bin").read_bytes()).digest()
        for nonce in range(10000):
            second[b"info"][b"benchmark nonce"] = nonce
            candidate = hashlib.sha1(lt.bencode(second[b"info"])).digest()
            if candidate != original_hash and candidate[-1] == original_hash[-1]:
                break
        else:
            raise AssertionError("Could not construct comparable DHT target")
        (output / "fixture-second.torrent").write_bytes(lt.bencode(second))
        (output / "info-second.bin").write_bytes(lt.bencode(second[b"info"]))
    setup()
    if dht:
        ns(
            "relay",
            "iptables",
            "-A",
            "INPUT",
            "-p",
            "udp",
            "--dport",
            "49001:49005",
            "-j",
            "DROP",
        )
    for name, interface in [("client", "eth0"), ("relay", "wan")]:
        args = [
            "tc",
            "qdisc",
            "add",
            "dev",
            interface,
            "root",
            "netem",
            "delay",
            f"{delay}ms",
        ]
        if loss:
            args += ["loss", f"{loss}%"]
        ns(name, *args)
    processes = []
    try:
        ports = []
        for index, mode in enumerate(modes):
            port = 41000 + index
            ports.append(port)
            processes.append(
                spawn(
                    "relay",
                    [
                        "python3",
                        "/work/performance_lab.py",
                        "--role",
                        "seed" if mode == "reference" else "faulty",
                        "--directory",
                        str(output),
                        "--port",
                        str(port),
                        "--mode",
                        mode,
                    ],
                    output / f"peer-{index}.log",
                )
            )
        processes.append(
            spawn(
                "relay",
                [
                    "python3",
                    "/work/performance_lab.py",
                    "--role",
                    "tracker",
                    "--ports",
                    ",".join(map(str, ports)),
                ],
                output / "tracker.log",
            )
        )
        if dht:
            processes.append(
                spawn(
                    "relay",
                    [
                        "python3",
                        "/work/performance_lab.py",
                        "--role",
                        "dht",
                        "--directory",
                        str(output),
                    ],
                    output / "dht.log",
                )
            )
        time.sleep(1)
        ns(
            "client",
            "python3",
            "/work/performance_lab.py",
            "--role",
            "fetch",
            "--directory",
            str(output),
            "--engine",
            engine,
            "--budget",
            str(budget),
            "--repeats",
            str(repeats),
            "--policy",
            policy,
            *(["--dht"] if dht else []),
        )
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    return json.loads((output / "result.json").read_text())


async def dht_router(directory):
    target = hashlib.sha1((directory / "info.bin").read_bytes()).digest()

    def node_id(distance):
        return target[:-1] + bytes([target[-1] ^ distance])

    nodes = b"".join(
        node_id(index)
        + socket.inet_aton("10.77.0.4")
        + struct.pack("!H", 49000 + index)
        for index in range(1, 7)
    )
    peer = socket.inet_aton("10.77.0.4") + struct.pack("!H", 41000)

    class Router(asyncio.DatagramProtocol):
        def __init__(self, good):
            self.good = good

        def connection_made(self, transport):
            self.transport = transport

        def datagram_received(self, data, address):
            query = lt.bdecode(data)
            method = query.get(b"q")
            reply = {b"id": node_id(6 if self.good else 255)}
            if method == b"find_node":
                reply[b"nodes"] = b""
            elif method == b"get_peers":
                reply[b"token"] = b"lab"
                if self.good:
                    reply[b"values"] = [peer]
                else:
                    reply[b"nodes"] = nodes
            self.transport.sendto(
                lt.bencode({b"t": query[b"t"], b"y": b"r", b"r": reply}), address
            )
            print(
                json.dumps(
                    {
                        "query": method.decode() if method else "unknown",
                        "good": self.good,
                    }
                ),
                flush=True,
            )

    loop = asyncio.get_running_loop()
    transports = []
    for port, good in [(49000, False), (49006, True)]:
        transport, _ = await loop.create_datagram_endpoint(
            lambda good=good: Router(good), local_addr=("10.77.0.4", port)
        )
        transports.append(transport)
    try:
        await asyncio.Future()
    finally:
        for transport in transports:
            transport.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--role",
        default="matrix",
        choices=["matrix", "seed", "tracker", "faulty", "fetch", "dht"],
    )
    parser.add_argument("--directory", type=pathlib.Path, default=ROOT / "performance")
    parser.add_argument("--port", type=int, default=41000)
    parser.add_argument("--ports", default="41000")
    parser.add_argument("--mode", default="stall")
    parser.add_argument("--engine", default="/work/target/debug/taiji")
    parser.add_argument("--baseline")
    parser.add_argument("--budget", type=float, default=45)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--policy", default="tcp")
    parser.add_argument("--dht", action="store_true")
    parser.add_argument("--cases", default="")
    parser.add_argument("--samples", type=int, default=1)
    args = parser.parse_args()
    if args.role == "seed":
        return seed(args.directory, args.port)
    if args.role == "tracker":
        return tracker([int(port) for port in args.ports.split(",")])
    if args.role == "faulty":
        return asyncio.run(faulty(args.directory, args.port, args.mode))
    if args.role == "dht":
        return asyncio.run(dht_router(args.directory))
    if args.role == "fetch":
        return fetch(
            args.directory,
            args.engine,
            args.budget,
            args.repeats,
            args.policy,
            args.dht,
        )
    root = args.directory
    root.mkdir(parents=True, exist_ok=True)
    cases = [
        ("small-rtt300", 1000, 150, ["reference", "reference"], "prefer-tcp", 0, 20, 1),
        ("large-rtt300", 1024 * 1024, 150, ["reference", "reference"], "tcp", 0, 45, 1),
        ("large-rtt500", 1024 * 1024, 250, ["reference", "reference"], "tcp", 0, 45, 1),
        (
            "loss-rtt100",
            512 * 1024,
            50,
            ["reference", "reference"],
            "prefer-tcp",
            1,
            45,
            1,
        ),
        ("stalled-peer", 512 * 1024, 50, ["stall", "reference"], "tcp", 0, 30, 1),
        ("selective-peers", 256 * 1024, 50, ["even", "odd"], "tcp", 0, 20, 1),
        ("corrupt-peer", 256 * 1024, 50, ["corrupt", "reference"], "tcp", 0, 30, 1),
        ("missing-size", 128 * 1024, 50, ["no-size"], "tcp", 0, 12, 1),
        ("verified-cache", 512 * 1024, 50, ["reference"], "tcp", 0, 30, 2),
    ]
    cases.append(("dht-cold-warm", 1024, 50, ["reference"], "tcp", 0, 30, 2))
    if args.cases:
        requested = set(args.cases.split(","))
        if requested - {case[0] for case in cases}:
            parser.error("Unknown performance case")
        cases = [case for case in cases if case[0] in requested]
    if not 1 <= args.samples <= 10:
        parser.error("samples must be between 1 and 10")
    report = {"reference": lt.version, "samples": args.samples, "cases": {}}
    engines = [("optimized", args.engine)]
    if args.baseline:
        engines.insert(0, ("baseline", args.baseline))
    digests = {
        variant: hashlib.sha256(pathlib.Path(engine).read_bytes()).hexdigest()
        for variant, engine in engines
    }
    report["engines"] = digests
    for name, padding, delay, modes, policy, loss, budget, repeats in cases:
        report["cases"][name] = {variant: [] for variant, _ in engines}
        for sample in range(args.samples):
            # Alternate order to reduce bias from background load or warm caches.
            order = engines if sample % 2 == 0 else list(reversed(engines))
            for variant, engine in order:
                assert (
                    hashlib.sha256(pathlib.Path(engine).read_bytes()).hexdigest()
                    == digests[variant]
                ), "Engine changed during measurement"
                values = run_case(
                    root,
                    f"{name}-{variant}-{sample}",
                    engine,
                    padding,
                    delay,
                    modes,
                    policy,
                    loss,
                    budget,
                    repeats,
                    dht=name == "dht-cold-warm",
                )
                report["cases"][name][variant].extend(
                    {**value, "sample": sample, "repeat": index}
                    for index, value in enumerate(values)
                )
                (root / "report.json").write_text(json.dumps(report, indent=2))
                print(
                    json.dumps(
                        {
                            "case": name,
                            "variant": variant,
                            "sample": sample,
                            "results": values,
                        }
                    ),
                    flush=True,
                )
    for name, values in report["cases"].items():
        assert all(result["verified"] for result in values["optimized"]), name
    print("Metadata performance and fault matrix passed", flush=True)


if __name__ == "__main__":
    main()
