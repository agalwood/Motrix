"""Exercise the real pinned HTTP client against local response-header fixtures."""

import hashlib
import sys
import tempfile
import threading
import unittest
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import aiohttp
from flatpak_node_generator.cache import Cache, FilesystemBasedCache
from flatpak_node_generator.requests import Requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from run_flatpak_node_generator import HeaderLimitedRequests, MAX_HEADER_FIELD_SIZE


BODY = b"unchanged locked source bytes\x00\xff\n"
REQUESTS = Counter()


class HeaderFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        REQUESTS[self.path] += 1
        if self.path == "/retry" and REQUESTS[self.path] == 1:
            self.send_response(503)
            self.end_headers()
            return
        self.send_response(302 if self.path == "/redirect" else 200)
        size = MAX_HEADER_FIELD_SIZE + 1 if self.path == "/oversized" else 10000
        self.send_header("Content-Security-Policy", "x" * size)
        if self.path == "/redirect":
            self.send_header("Location", "/payload")
            self.end_headers()
            return
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        try:
            self.wfile.write(BODY)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Expected when the client rejects a response header.

    def log_message(self, *_args):
        pass


class HeaderLimitTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), HeaderFixture)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        REQUESTS.clear()
        self.previous_retries = Requests.retries
        self.previous_cache = Cache.instance
        self.cache = tempfile.TemporaryDirectory()
        Requests.retries = 2
        Cache.instance = FilesystemBasedCache(Path(self.cache.name))

    def tearDown(self):
        Requests.retries = self.previous_retries
        Cache.instance = self.previous_cache
        self.cache.cleanup()

    async def test_fixture_exceeds_the_unmodified_client_limit(self):
        with self.assertRaises(aiohttp.ClientResponseError):
            await Requests().read_all(f"{self.base_url}/payload")

    async def test_larger_redirect_and_payload_headers_preserve_source_bytes(self):
        body = await HeaderLimitedRequests().read_all(f"{self.base_url}/redirect")
        self.assertEqual(body, BODY)
        self.assertEqual(hashlib.sha256(body).digest(), hashlib.sha256(BODY).digest())
        self.assertEqual(REQUESTS, {"/redirect": 1, "/payload": 1})

    async def test_headers_above_the_bound_still_fail_after_upstream_retries(self):
        with self.assertRaises(aiohttp.ClientResponseError):
            await HeaderLimitedRequests().read_all(f"{self.base_url}/oversized")
        self.assertEqual(REQUESTS["/oversized"], 2)

    async def test_status_retries_and_source_cache_remain_active(self):
        client = HeaderLimitedRequests()
        url = f"{self.base_url}/retry"
        self.assertEqual(await client.read_all(url, cachable=True), BODY)
        self.assertEqual(REQUESTS["/retry"], 2)
        with Cache.instance.get(f"requests:{url}").open_read() as cached:
            self.assertEqual(cached.read_all(), BODY)
        self.assertEqual(REQUESTS["/retry"], 2)


if __name__ == "__main__":
    unittest.main()
