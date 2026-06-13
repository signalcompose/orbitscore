#!/usr/bin/env python3
"""Dev server for the OrbitScore MIDI monitor.

Serves the static page plus two small endpoints so MIDI testing can be done
jointly (human drives the browser / audio / IAC; an observer reads the stream):

  POST /events    — the page (with ?report=1) reports each received MIDI event;
                    printed to stdout so a `tail` or a collaborating agent sees
                    what the browser received in real time.

  POST /pattern   — the *sender* (a CLI script, or later the engine's eval path)
                    reports the DSL pattern currently being played, as JSON
                    {"source": "...", "label": "..."}. Stored as the latest.
  GET  /pattern   — returns the latest reported pattern (the page polls this and
                    shows "Now playing (DSL)").

Usage:
    python3 dev-server.py [port]   # default 8137
"""

import datetime
import http.server
import json
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137

# Latest DSL pattern reported by a sender. Single-threaded server, so a plain
# dict is fine without locking.
latest_pattern = {"source": "", "label": "", "t": 0}


class Handler(http.server.SimpleHTTPRequestHandler):
    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length).decode("utf-8", "replace")

    def _send_json(self, obj, code=200):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        global latest_pattern
        if self.path == "/events":
            body = self._read_body()
            ts = datetime.datetime.now().strftime("%H:%M:%S")
            sys.stdout.write(f"{ts} {body}\n")
            sys.stdout.flush()
            self.send_response(204)
            self.end_headers()
        elif self.path == "/pattern":
            body = self._read_body()
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {"source": body}
            now = datetime.datetime.now()
            latest_pattern = {
                "source": data.get("source", ""),
                "label": data.get("label", ""),
                "t": int(now.timestamp() * 1000),
            }
            ts = now.strftime("%H:%M:%S")
            label = latest_pattern["label"]
            first = latest_pattern["source"].splitlines()[0] if latest_pattern["source"] else ""
            sys.stdout.write(f"{ts} [pattern{(' ' + label) if label else ''}] {first}\n")
            sys.stdout.flush()
            self.send_response(204)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path.startswith("/pattern"):
            self._send_json(latest_pattern)
            return
        super().do_GET()

    def end_headers(self):
        # Avoid stale index.html during iterative editing. Called once per
        # response, so this adds exactly one Cache-Control header.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        # Silence default access logs; only events / patterns go to stdout.
        pass


with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving http://localhost:{PORT} (POST /events, POST|GET /pattern)", flush=True)
    httpd.serve_forever()
