#!/usr/bin/env python3
"""Dev server for the OrbitScore MIDI monitor.

Serves the static page AND accepts `POST /events` from the page (enabled via
`index.html?report=1`), printing each reported event to stdout. This lets a
collaborating agent — or a simple `tail` — observe what the browser received in
real time, so MIDI testing can be done jointly (human drives the browser /
audio / IAC; the observer reads the event stream).

Usage:
    python3 dev-server.py [port]   # default 8137
"""

import datetime
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/events":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8", "replace")
            ts = datetime.datetime.now().strftime("%H:%M:%S")
            sys.stdout.write(f"{ts} {body}\n")
            sys.stdout.flush()
            self.send_response(204)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def end_headers(self):
        # Avoid stale index.html during iterative editing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        # Silence the default GET access logs; only events go to stdout.
        pass


with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving http://localhost:{PORT} (POST /events → stdout)", flush=True)
    httpd.serve_forever()
