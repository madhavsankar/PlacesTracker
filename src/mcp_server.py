#!/usr/bin/env python3
"""
Object-Oriented Model Context Protocol (MCP) Server for PlacesTracker.
Divided into:
  - `McpToolDispatcher`: Executes the 7 PlacesTracker tools against `PlacesDB` and `DashboardGenerator`.
  - `McpJsonRpcProcessor`: Handles JSON-RPC 2.0 protocol framing (`initialize`, `ping`, `tools/*`, `resources/*`).
  - `StdioMcpServer`: Manages `stdin` / `stdout` message streaming.
"""

import json
import os
import sys
from typing import Any, Dict, List, Optional

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from catalog import CatalogLoader, load_app_metadata, load_mcp_tools_schema
from db import PlacesDB
from map_generator import DashboardGenerator

REPO_ROOT = os.path.dirname(SRC_DIR)
DEFAULT_DASHBOARD_PATH = os.path.join(REPO_ROOT, "data", "dashboard.html")

TOOLS: List[Dict[str, Any]] = load_mcp_tools_schema()
APP_METADATA: Dict[str, Any] = load_app_metadata()


class McpToolDispatcher:
    """Dispatches MCP tool invocations (`tools/call`) to strongly-typed handler methods."""

    def __init__(
        self,
        db: PlacesDB,
        dashboard_generator: Optional[DashboardGenerator] = None,
        catalog_loader: Optional[CatalogLoader] = None,
    ) -> None:
        self.db = db
        self.dashboard_generator = dashboard_generator or DashboardGenerator()
        self.catalog_loader = catalog_loader or CatalogLoader()
        self._continents_lower = {
            c.lower() for c in self.catalog_loader.load_app_metadata().get("continents", [])
        }

    def dispatch(self, tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        handlers = {
            "places_mark": self._handle_mark,
            "places_stats": self._handle_stats,
            "places_search": self._handle_search,
            "places_recommend": self._handle_recommend,
            "places_add_custom": self._handle_add_custom,
            "places_render_dashboard": self._handle_render_dashboard,
            "places_csv": self._handle_csv,
        }
        handler = handlers.get(tool_name)
        if not handler:
            raise ValueError(f"Unknown tool: {tool_name}")
        return handler(args)

    def _handle_mark(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return self.db.mark_places(
            places=args.get("places", []),
            status=args.get("status", "visited"),
            is_favorite=args.get("is_favorite"),
            visit_date=args.get("visit_date", ""),
            rating=int(args.get("rating", 0) or 0),
            trip_name=args.get("trip_name", ""),
            notes=args.get("notes", ""),
            category_hint=args.get("category_hint"),
        )

    def _handle_stats(self, _args: Dict[str, Any]) -> Dict[str, Any]:
        return self.db.get_stats()

    def _handle_search(self, args: Dict[str, Any]) -> Dict[str, Any]:
        results = self.db.search_places(
            query=args.get("query", ""),
            category=args.get("category", ""),
            status=args.get("status", ""),
            country_code=args.get("country_code", ""),
            continent=args.get("continent", ""),
            favorites_only=bool(args.get("favorites_only", False)),
            limit=int(args.get("limit", 50) or 50),
        )
        return {"count": len(results), "places": results}

    def _handle_recommend(self, args: Dict[str, Any]) -> Dict[str, Any]:
        dest = args.get("destination", "").strip()
        resolved = self.db.resolve_place(dest)
        country_code = ""
        state_code = ""
        continent = ""

        if resolved:
            if resolved["category"] == "country":
                country_code = resolved["country_code"]
            elif resolved["category"] == "us_state":
                country_code = "US"
                state_code = resolved["state_code"]
            else:
                country_code = resolved["country_code"]

        if not country_code and dest.lower() in self._continents_lower:
            continent = dest

        all_matches = self.db.search_places(
            country_code=country_code,
            continent=continent,
            query="" if (country_code or continent) else dest,
            limit=200,
        )
        if state_code:
            all_matches = [m for m in all_matches if m.get("state_code") == state_code]

        unvisited = [
            m
            for m in all_matches
            if m["status"] in ("bucket_list", "unvisited") and m["category"] != "country"
        ]
        visited = [
            m for m in all_matches if m["status"] == "visited" and m["category"] != "country"
        ]
        return {
            "destination": dest,
            "resolved_country": country_code,
            "already_visited_count": len(visited),
            "already_visited": [
                {"id": x["id"], "name": x["name"], "category": x["category"]} for x in visited
            ],
            "recommended_unvisited": [
                {
                    "id": x["id"],
                    "name": x["name"],
                    "category": x["category"],
                    "status": x["status"],
                    "flag_emoji": x["flag_emoji"],
                    "description": x["description"],
                }
                for x in unvisited
            ],
        }

    def _handle_add_custom(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return self.db.add_custom_place(
            name=args["name"],
            category=args.get("category", "city"),
            country_code=args["country_code"],
            state_code=args.get("state_code", ""),
            lat=float(args.get("lat", 0.0) or 0.0),
            lng=float(args.get("lng", 0.0) or 0.0),
            description=args.get("description", ""),
            status=args.get("status", "visited"),
            is_favorite=bool(args.get("is_favorite", False)),
            visit_date=args.get("visit_date", ""),
            notes=args.get("notes", ""),
        )

    def _handle_render_dashboard(self, args: Dict[str, Any]) -> Dict[str, Any]:
        out_path = args.get("output_path") or DEFAULT_DASHBOARD_PATH
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        html = self.dashboard_generator.render_html(self.db)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        stats = self.db.get_stats()
        return {
            "dashboard_path": os.path.abspath(out_path),
            "countries_visited": stats["summary"].get("country", {}).get("visited", 0),
            "us_states_visited": stats["summary"].get("us_state", {}).get("visited", 0),
            "us_national_parks_visited": stats["summary"]
            .get("us_national_parks", {})
            .get("visited", 0),
            "flag_belt": stats["flag_belt"],
        }

    def _handle_csv(self, args: Dict[str, Any]) -> Dict[str, Any]:
        action = args.get("action", "export")
        if action == "export":
            return {"csv": self.db.export_csv()}
        return self.db.import_csv(args.get("csv_text", ""))


class McpJsonRpcProcessor:
    """Processes JSON-RPC 2.0 requests according to the Model Context Protocol specification."""

    def __init__(self, db: PlacesDB, dispatcher: Optional[McpToolDispatcher] = None) -> None:
        self.db = db
        self.dispatcher = dispatcher or McpToolDispatcher(db)
        self.tools = TOOLS
        self.metadata = APP_METADATA

    def process_message(self, msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        method = msg.get("method")
        msg_id = msg.get("id")
        params = msg.get("params") or {}

        if msg_id is None:
            return None

        try:
            if method == "initialize":
                client_proto = params.get(
                    "protocolVersion",
                    self.metadata.get("default_protocol_version", "2024-11-05"),
                )
                result = {
                    "protocolVersion": client_proto,
                    "capabilities": {
                        "tools": {"listChanged": False},
                        "resources": {"subscribe": False, "listChanged": False},
                    },
                    "serverInfo": self.metadata.get(
                        "server_info", {"name": "places-tracker-mcp", "version": "1.0.0"}
                    ),
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": self.tools}
            elif method == "tools/call":
                tool_name = params.get("name", "")
                tool_args = params.get("arguments") or {}
                tool_out = self.dispatcher.dispatch(tool_name, tool_args)
                result = {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(tool_out, ensure_ascii=False, indent=2),
                        }
                    ],
                    "isError": False,
                }
            elif method == "resources/list":
                result = {"resources": self.metadata.get("mcp_resources", [])}
            elif method == "resources/read":
                uri = params.get("uri", "")
                if uri == "places://stats":
                    result = {
                        "contents": [
                            {
                                "uri": uri,
                                "mimeType": "application/json",
                                "text": json.dumps(
                                    self.db.get_stats(), ensure_ascii=False, indent=2
                                ),
                            }
                        ]
                    }
                else:
                    raise ValueError(f"Unknown resource URI: {uri}")
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }

            return {"jsonrpc": "2.0", "id": msg_id, "result": result}

        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {exc}"}],
                    "isError": True,
                },
            }


class StdioMcpServer:
    """Runs the standard input/output MCP transport supporting both Content-Length and line-delimited JSON-RPC."""

    def __init__(self, processor: Optional[McpJsonRpcProcessor] = None) -> None:
        self.db = PlacesDB()
        self.processor = processor or McpJsonRpcProcessor(self.db)

    def serve_forever(self) -> None:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            stripped = line.strip()
            if not stripped:
                continue

            if stripped.lower().startswith("content-length:"):
                length = int(stripped.split(":", 1)[1].strip())
                while True:
                    hdr = sys.stdin.readline()
                    if not hdr or hdr.strip() == "":
                        break
                body = sys.stdin.read(length)
                msg = json.loads(body)
                resp = self.processor.process_message(msg)
                if resp is not None:
                    out_bytes = json.dumps(resp, ensure_ascii=False).encode("utf-8")
                    sys.stdout.write(f"Content-Length: {len(out_bytes)}\r\n\r\n")
                    sys.stdout.write(out_bytes.decode("utf-8"))
                    sys.stdout.flush()
            else:
                try:
                    msg = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                resp = self.processor.process_message(msg)
                if resp is not None:
                    sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                    sys.stdout.flush()


def handle_tool_call(db: PlacesDB, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Backward-compatible helper delegating to McpToolDispatcher."""
    return McpToolDispatcher(db).dispatch(name, args)


def process_jsonrpc_message(db: PlacesDB, msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Backward-compatible helper delegating to McpJsonRpcProcessor."""
    return McpJsonRpcProcessor(db).process_message(msg)


def main() -> None:
    StdioMcpServer().serve_forever()


if __name__ == "__main__":
    main()
