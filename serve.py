#!/usr/bin/env python3
"""Threaded static server. The stdlib one-liner is single threaded, and a page
with several scripts plus keep-alive connections will stall it."""
import functools, http.server, os, socketserver, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8900
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    os.chdir(ROOT)
    with Server(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)) as s:
        print("serving %s on http://127.0.0.1:%d/" % (ROOT, PORT))
        s.serve_forever()
