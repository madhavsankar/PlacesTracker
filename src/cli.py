#!/usr/bin/env python3
"""
Object-Oriented CLI & Local HTTP/MCP Server for PlacesTracker.
Divided into:
  - `LocalHttpServer`: Serves the interactive Web UI, REST API (`/api/*`), and HTTP MCP (`/mcp`).
  - `PlacesTrackerCLI`: Command-line interface for stats, marking, searching, recommending, and serving.
"""

import argparse
import http.server
import json
import os
import sys
from typing import Any, Dict, List

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from catalog import load_app_metadata, load_us_state_grid
from db import PlacesDB
from map_generator import DashboardGenerator
from mcp_server import McpJsonRpcProcessor, McpToolDispatcher


class LocalHttpServer:
    """Encapsulates the local HTTP + Streamable MCP server matching the Cloudflare Worker routes."""

    def __init__(self, db: PlacesDB, host: str = "127.0.0.1", port: int = 8765) -> None:
        self.db = db
        self.host = host
        self.port = port
        self.dispatcher = McpToolDispatcher(db)
        self.rpc_processor = McpJsonRpcProcessor(db, self.dispatcher)
        self.dashboard_generator = DashboardGenerator()
        self.us_state_grid = load_us_state_grid()
        self.server_info = load_app_metadata().get(
            "server_info", {"name": "places-tracker-mcp", "version": "1.0.0"}
        )

    def _build_handler_class(self):
        parent = self

        class RequestHandler(http.server.BaseHTTPRequestHandler):
            def _send_cors(self) -> None:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header(
                    "Access-Control-Allow-Headers",
                    "Content-Type, Authorization, Mcp-Session-Id",
                )

            def _send_json(self, payload: Any, status: int = 200) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                self._send_cors()
                self.end_headers()

            def do_GET(self) -> None:
                if self.path in ("/", "/index.html", "/dashboard.html"):
                    html = parent.dashboard_generator.render_html(parent.db).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self._send_cors()
                    self.end_headers()
                    self.wfile.write(html)
                elif self.path == "/api/state":
                    self._send_json(
                        {
                            "places": parent.db.search_places(limit=1000),
                            "stats": parent.db.get_stats(),
                            "us_grid": parent.us_state_grid,
                        }
                    )
                elif self.path == "/api/export.csv":
                    csv_bytes = parent.db.export_csv().encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header(
                        "Content-Disposition",
                        "attachment; filename=places_tracker_export.csv",
                    )
                    self._send_cors()
                    self.end_headers()
                    self.wfile.write(csv_bytes)
                elif self.path == "/mcp":
                    self._send_json({**parent.server_info, "status": "ok"})
                else:
                    self.send_error(404)

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
                payload = json.loads(raw)

                if self.path == "/api/mark":
                    res = parent.dispatcher.dispatch("places_mark", payload)
                    self._send_json(res)
                elif self.path == "/mcp":
                    resp = parent.rpc_processor.process_message(payload)
                    if resp is None:
                        self.send_response(202)
                        self._send_cors()
                        self.end_headers()
                    else:
                        self._send_json(resp)
                else:
                    self.send_error(404)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        return RequestHandler

    def serve_forever(self) -> None:
        handler_cls = self._build_handler_class()
        server = http.server.HTTPServer((self.host, self.port), handler_cls)
        print(
            f"PlacesTracker HTTP + MCP server running at http://{self.host}:{self.port} "
            f"(MCP: http://{self.host}:{self.port}/mcp)"
        )
        server.serve_forever()


class PlacesTrackerCLI:
    """Command-Line Interface controller for PlacesTracker."""

    def __init__(self) -> None:
        self.db = PlacesDB()
        self.dispatcher = McpToolDispatcher(self.db)
        self.parser = self._build_parser()

    @staticmethod
    def _build_parser() -> argparse.ArgumentParser:
        parser = argparse.ArgumentParser(description="PlacesTracker CLI")
        sub = parser.add_subparsers(dest="cmd")

        sub.add_parser("stats", help="Show Places Been completion statistics")

        p_mark = sub.add_parser("mark", help="Mark places as visited, bucket_list, or unvisited")
        p_mark.add_argument("places", nargs="+", help="Place names, ISO codes, or IDs")
        p_mark.add_argument(
            "--status", default="visited", choices=["visited", "bucket_list", "unvisited"]
        )
        p_mark.add_argument("--favorite", action="store_true", help="Mark as favorite")
        p_mark.add_argument("--date", default="", help="Visit date (e.g. 2024-05)")
        p_mark.add_argument("--trip", default="", help="Trip name")
        p_mark.add_argument("--notes", default="", help="Notes")
        p_mark.add_argument("--category", default=None, help="Category hint")

        p_search = sub.add_parser("search", help="Search places catalog")
        p_search.add_argument("--query", default="")
        p_search.add_argument("--category", default="")
        p_search.add_argument("--status", default="")
        p_search.add_argument("--country", default="")
        p_search.add_argument("--continent", default="")
        p_search.add_argument("--limit", type=int, default=50)

        p_rec = sub.add_parser("recommend", help="Recommend unvisited sights in a destination")
        p_rec.add_argument("destination", help="Country name, ISO code, US state, or continent")

        p_render = sub.add_parser(
            "render", help="Render interactive HTML Scratch & Flag Map dashboard"
        )
        p_render.add_argument("--output", default="", help="Output HTML file path")

        p_serve = sub.add_parser("serve", help="Run local HTTP + Remote MCP server")
        p_serve.add_argument("--port", type=int, default=8765)

        return parser

    def run(self, argv: List[str] = None) -> None:
        args = self.parser.parse_args(argv)

        if args.cmd == "stats":
            self._print_json(self.db.get_stats())
        elif args.cmd == "mark":
            res = self.dispatcher.dispatch(
                "places_mark",
                {
                    "places": args.places,
                    "status": args.status,
                    "is_favorite": True if args.favorite else None,
                    "visit_date": args.date,
                    "trip_name": args.trip,
                    "notes": args.notes,
                    "category_hint": args.category,
                },
            )
            self._print_json(res)
        elif args.cmd == "search":
            res = self.dispatcher.dispatch(
                "places_search",
                {
                    "query": args.query,
                    "category": args.category,
                    "status": args.status,
                    "country_code": args.country,
                    "continent": args.continent,
                    "limit": args.limit,
                },
            )
            self._print_json(res)
        elif args.cmd == "recommend":
            res = self.dispatcher.dispatch(
                "places_recommend", {"destination": args.destination}
            )
            self._print_json(res)
        elif args.cmd == "render":
            res = self.dispatcher.dispatch(
                "places_render_dashboard", {"output_path": args.output}
            )
            self._print_json(res)
        elif args.cmd == "serve":
            LocalHttpServer(self.db, port=args.port).serve_forever()
        else:
            self.parser.print_help()

    @staticmethod
    def _print_json(data: Any) -> None:
        print(json.dumps(data, indent=2, ensure_ascii=False))


def main() -> None:
    PlacesTrackerCLI().run()


if __name__ == "__main__":
    main()
