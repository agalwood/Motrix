"""Hostile router — returns crafted malicious responses to exercise codec defenses."""
import argparse
import socketserver
from http.server import BaseHTTPRequestHandler

XXE_PAYLOAD = b"""<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<root>&xxe;</root>"""

BILLION_LAUGHS = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<root>&lol3;</root>"""

REDIRECT_TO_EXTERNAL = None   # signals 302 handler

class HostileHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Route by path suffix so a single image can serve multiple attack modes.
        if self.path.endswith("/xxe"):
            body = XXE_PAYLOAD
        elif self.path.endswith("/bomb"):
            body = BILLION_LAUGHS
        elif self.path.endswith("/huge"):
            body = b"x" * (200 * 1024)   # 200KB, exceeds SOAP + device-desc caps
        elif self.path.endswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "http://8.8.8.8/evil")
            self.end_headers()
            return
        elif self.path.endswith("/crlf"):
            # Attempt CRLF injection in controlURL. The codec should reject,
            # but we test that here too.
            body = b"<?xml version=\"1.0\"?><root><controlURL>/ctl\r\nInjected: x</controlURL></root>"
        else:
            body = b"<?xml version=\"1.0\"?><root/>"
        self.send_response(200)
        self.send_header("Content-Type", "text/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Quiet logs during tests
        pass

class HostileServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=49154)
    args = parser.parse_args()
    with HostileServer((args.bind, args.port), HostileHandler) as server:
        print(f"Hostile server listening on {args.bind}:{args.port}", flush=True)
        server.serve_forever()
