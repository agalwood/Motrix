"""Broken router — emits truncated / misformed responses."""
import argparse
import os
import random
import socket
import threading

def udp_garbage(port):
    """UDP responder that sends random bytes to any request on NAT-PMP/PCP port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))
    while True:
        _, addr = sock.recvfrom(1500)
        # Random length 0..200 of random bytes — should exercise parser length checks
        length = random.randint(0, 200)
        sock.sendto(os.urandom(length), addr)

def tcp_garbage(port):
    """TCP server that sends a malformed HTTP-like response."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.listen(32)
    while True:
        conn, _ = sock.accept()
        try:
            conn.recv(4096)
            # Missing status line
            conn.sendall(b"NotHTTP/1.0 garbage\r\n\r\n<?xml?>NotXML")
        finally:
            conn.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--udp-port", type=int, default=5353)
    parser.add_argument("--tcp-port", type=int, default=49155)
    args = parser.parse_args()
    threading.Thread(target=udp_garbage, args=(args.udp_port,), daemon=True).start()
    print(f"Broken UDP on {args.udp_port}, TCP on {args.tcp_port}", flush=True)
    tcp_garbage(args.tcp_port)
