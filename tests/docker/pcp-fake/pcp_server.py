"""Minimal PCP (RFC 6887) server implementing the MAP opcode.

This is test infrastructure — NOT a production server. It accepts any MAP
request and echoes back success with the suggested port as the external port.

Usage:
    python3 pcp_server.py [--bind=0.0.0.0] [--port=5351]
"""
import argparse
import socket
import socketserver
import struct
import sys
import time

PCP_VERSION = 2
PCP_OPCODE_MAP = 1
PCP_RESULT_SUCCESS = 0
EPOCH_START = int(time.time())

class PcpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        if len(data) < 60 or len(data) > 1100:
            return
        if data[0] != PCP_VERSION:
            return
        if data[1] != PCP_OPCODE_MAP:
            return

        lifetime = struct.unpack("!I", data[4:8])[0]
        nonce = data[24:36]
        protocol = data[36]
        internal_port = struct.unpack("!H", data[40:42])[0]
        suggested_external = struct.unpack("!H", data[42:44])[0]

        resp = bytearray(60)
        resp[0] = PCP_VERSION
        resp[1] = 0x80 | PCP_OPCODE_MAP
        resp[3] = PCP_RESULT_SUCCESS
        # lifetime — echo back (or clamp to 86400)
        struct.pack_into("!I", resp, 4, min(lifetime, 86400))
        # epoch seconds
        struct.pack_into("!I", resp, 8, int(time.time()) - EPOCH_START)
        resp[24:36] = nonce
        resp[36] = protocol
        struct.pack_into("!H", resp, 40, internal_port)
        struct.pack_into("!H", resp, 42, suggested_external or internal_port)
        # External IP bytes 44..60 — return 203.0.113.42 as v4-mapped IPv6
        resp[44:60] = b"\x00" * 10 + b"\xff\xff" + bytes([203, 0, 113, 42])

        sock.sendto(bytes(resp), self.client_address)

class PcpServer(socketserver.ThreadingUDPServer):
    allow_reuse_address = True

    def __init__(self, bind="0.0.0.0", port=5351):
        super().__init__((bind, port), PcpHandler)
        self.port = self.server_address[1]

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5351)
    args = parser.parse_args()
    server = PcpServer(args.bind, args.port)
    print(f"Fake PCP server listening on {args.bind}:{server.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", flush=True)
        server.shutdown()
        sys.exit(0)
