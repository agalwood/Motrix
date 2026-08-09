"""Smoke tests for the fake PCP server. Run with: python3 -m unittest test_pcp_server."""
import socket
import struct
import threading
import time
import unittest
from pcp_server import PcpServer, PCP_VERSION, PCP_OPCODE_MAP

class PcpServerTests(unittest.TestCase):
    def setUp(self):
        self.server = PcpServer(bind="127.0.0.1", port=0)  # ephemeral port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        time.sleep(0.05)

    def tearDown(self):
        self.server.shutdown()

    def test_map_request_success(self):
        # Build minimal PCP MAP request (60 bytes)
        req = bytearray(60)
        req[0] = PCP_VERSION
        req[1] = PCP_OPCODE_MAP
        struct.pack_into("!I", req, 4, 7200)           # lifetime
        # client IP bytes 8..24 — IPv4-mapped IPv6 for 127.0.0.1
        req[8:24] = b"\x00" * 10 + b"\xff\xff" + b"\x7f\x00\x00\x01"
        nonce = b"\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c"
        req[24:36] = nonce
        req[36] = 6                                     # TCP
        struct.pack_into("!H", req, 40, 6881)
        struct.pack_into("!H", req, 42, 6881)

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(bytes(req), ("127.0.0.1", self.server.port))
        sock.settimeout(1.0)
        data, _ = sock.recvfrom(1500)

        self.assertEqual(data[0], PCP_VERSION)
        self.assertEqual(data[1] & 0x80, 0x80)  # response bit
        self.assertEqual(data[1] & 0x7f, PCP_OPCODE_MAP)
        self.assertEqual(data[24:36], nonce)    # nonce echoed back
        self.assertEqual(data[3], 0)            # success

if __name__ == "__main__":
    unittest.main()
