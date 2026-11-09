#!/usr/bin/env python3
"""
Object-Oriented Build Pipeline (`WorkerBuilder`) for the PlacesTracker Cloudflare Worker.
Assembles:
  1. `data/catalog/*.json` -> `cloudflare/src/data/CatalogData.js` (pure ES module exports, zero bundler path issues)
  2. `cloudflare/src/ui/{template.html,styles.css,app.js}` -> `cloudflare/src/ui/WebAppView.js`
  3. `cloudflare/worker.js` entrypoint
"""

import json
import os
import sys
from typing import Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(REPO_ROOT, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from catalog import CatalogLoader


class WorkerBuilder:
    """Encapsulates assembly of the static JSON catalog module, frontend UI module, and Worker entrypoint."""

    WORKER_ENTRYPOINT_TEMPLATE = """/**
 * PlacesTracker — Modular Cloudflare Worker Entrypoint.
 * Architecture:
 *   - `data/catalog/*.json`                              -> Static geographic & POI JSON datasets
 *   - `cloudflare/src/config/constants.js`               -> Environment & API constants (`FlagFormatter`)
 *   - `cloudflare/src/data/CatalogData.js`               -> Pure ES module exports compiled from `data/catalog/*.json`
 *   - `cloudflare/src/repositories/StorageRepository.js` -> Firebase Cloud Firestore NoSQL + KV repository
 *   - `cloudflare/src/services/CatalogService.js`        -> Place resolution, parent propagation, stats, CSV
 *   - `cloudflare/src/services/GeminiAgentService.js`    -> Gemini 3.8 Flash Interactions API + local fallback
 *   - `cloudflare/src/mcp/McpRouter.js`                  -> Streamable HTTP MCP Server (`/mcp`)
 *   - `cloudflare/src/controllers/HttpRouter.js`         -> HTTP & REST API controller
 *   - `cloudflare/src/ui/`                               -> Modular HTML template, CSS, and `PlacesTrackerClient` class
 */

import { HttpRouter } from "./src/controllers/HttpRouter.js";

export default {
  async fetch(request, env) {
    const router = new HttpRouter(env);
    return router.handle(request);
  },
};
"""

    def __init__(self, repo_root: str = REPO_ROOT) -> None:
        self.repo_root = repo_root
        self.ui_dir = os.path.join(repo_root, "cloudflare", "src", "ui")
        self.data_js_dir = os.path.join(repo_root, "cloudflare", "src", "data")
        self.worker_entry_path = os.path.join(repo_root, "cloudflare", "worker.js")
        self.catalog_loader = CatalogLoader()

    @staticmethod
    def _read_text(path: str) -> str:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    @staticmethod
    def _write_text(path: str, content: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    @staticmethod
    def _to_js_json(data: object) -> str:
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False)

    def build_catalog_data_module(self) -> str:
        """Compile `data/catalog/*.json` into pure ES module exports in `cloudflare/src/data/CatalogData.js`."""
        base_catalog = self._to_js_json(self.catalog_loader.load_all_places())
        aliases = self._to_js_json(self.catalog_loader.load_aliases())
        ne_map = self._to_js_json(self.catalog_loader.load_natural_earth_map())
        us_grid = self._to_js_json(self.catalog_loader.load_us_state_grid())
        mcp_tools = self._to_js_json(self.catalog_loader.load_mcp_tools_schema())
        app_meta = self._to_js_json(self.catalog_loader.load_app_metadata())
        gemini_cfg = self._to_js_json(self.catalog_loader.load_gemini_prompt_schema())
        pwa_manifest = self._to_js_json(self.catalog_loader.load_pwa_manifest())

        catalog_js = (
            "/**\n"
            " * Auto-compiled from `data/catalog/*.json` by `scripts/build_worker.py`.\n"
            " * Provides pure ES module exports for Cloudflare Workers Builds without cross-directory JSON loader issues.\n"
            " */\n\n"
            f"export const BASE_CATALOG = {base_catalog};\n"
            f"export const ALIASES = {aliases};\n"
            f"export const NATURAL_EARTH_NAME_MAP = {ne_map};\n"
            f"export const US_STATE_GRID = {us_grid};\n"
            f"export const MCP_TOOLS = {mcp_tools};\n"
            f"export const APP_METADATA = {app_meta};\n"
            f"export const GEMINI_CONFIG = {gemini_cfg};\n"
            f"export const PWA_MANIFEST = {pwa_manifest};\n"
        )
        out_path = os.path.join(self.data_js_dir, "CatalogData.js")
        self._write_text(out_path, catalog_js)
        return out_path

    def build_web_app_view(self) -> str:
        template_html = self._read_text(os.path.join(self.ui_dir, "template.html"))
        styles_css = self._read_text(os.path.join(self.ui_dir, "styles.css"))
        client_js = self._read_text(os.path.join(self.ui_dir, "app.js"))
        ne_map_json = json.dumps(self.catalog_loader.load_natural_earth_map(), ensure_ascii=False)

        assembled_html = (
            template_html.replace("{{STYLES}}", styles_css)
            .replace("{{NATURAL_EARTH_MAP_JSON}}", ne_map_json)
            .replace("{{CLIENT_SCRIPT}}", client_js)
        )
        html_literal = json.dumps(assembled_html, ensure_ascii=False)

        view_js = (
            "/**\n"
            " * Auto-assembled from `cloudflare/src/ui/template.html`, `styles.css`, and `app.js`.\n"
            " * Run `python3 scripts/build_worker.py` after editing UI source files.\n"
            " */\n\n"
            f"const WEB_APP_HTML = {html_literal};\n\n"
            "export function renderWebAppHtml() {\n"
            "  return WEB_APP_HTML;\n"
            "}\n"
        )
        out_path = os.path.join(self.ui_dir, "WebAppView.js")
        self._write_text(out_path, view_js)
        return out_path

    def write_worker_entrypoint(self) -> str:
        self._write_text(self.worker_entry_path, self.WORKER_ENTRYPOINT_TEMPLATE)
        return self.worker_entry_path

    def build_all(self) -> Tuple[str, str, str]:
        data_path = self.build_catalog_data_module()
        view_path = self.build_web_app_view()
        worker_path = self.write_worker_entrypoint()
        return data_path, view_path, worker_path


def main() -> None:
    builder = WorkerBuilder()
    data_path, view_path, worker_path = builder.build_all()
    print(f"Built:\n  - {data_path}\n  - {view_path}\n  - {worker_path}")
    if "--skip-tests" not in sys.argv:
        import unittest

        suite = unittest.defaultTestLoader.discover(os.path.join(REPO_ROOT, "tests"))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        if not result.wasSuccessful():
            sys.exit(1)


if __name__ == "__main__":
    main()
