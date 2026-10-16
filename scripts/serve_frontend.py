"""Serve the static frontend locally (local demo mode needs no AWS access).

Usage:  python scripts/serve_frontend.py [--port 5173]
Then open http://localhost:5173/
"""

import argparse
import functools
import http.server
import os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")


class Handler(http.server.SimpleHTTPRequestHandler):
    # Explicit types: on some Windows machines the registry maps .js to text/plain,
    # which browsers refuse for ES modules.
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{
        ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
        ".css": "text/css", ".svg": "image/svg+xml", ".html": "text/html",
    })

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    server = http.server.ThreadingHTTPServer((args.host, args.port), functools.partial(Handler, directory=ROOT))
    print("TransitShield frontend: http://localhost:%d/  (Ctrl+C to stop)" % args.port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
