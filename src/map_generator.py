"""
DashboardGenerator — Renders the Interactive Vector Scratch Map, Flag Map, and US 50-States Map.
Reuses the modular frontend template (`cloudflare/src/ui/template.html`), stylesheet (`styles.css`),
and client controller (`app.js`), eliminating duplicated inline HTML/JS.
"""

import json
import os
from typing import Any, List

from catalog import CatalogLoader, load_us_state_grid
from db import PlacesDB

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_DIR = os.path.join(REPO_ROOT, "cloudflare", "src", "ui")

US_STATE_GRID: List[List[Any]] = load_us_state_grid()


class DashboardGenerator:
    """Assembles the standalone HTML dashboard from modular UI assets and live database state."""

    def __init__(self, ui_dir: str = UI_DIR, catalog_loader: CatalogLoader = None) -> None:
        self.ui_dir = ui_dir
        self.catalog_loader = catalog_loader or CatalogLoader()

    def _read_asset(self, filename: str) -> str:
        path = os.path.join(self.ui_dir, filename)
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def render_html(self, db: PlacesDB) -> str:
        """Render the complete interactive HTML dashboard pre-seeded with the user's SQLite state."""
        template_html = self._read_asset("template.html")
        styles_css = self._read_asset("styles.css")
        client_js = self._read_asset("app.js")
        ne_map_json = json.dumps(self.catalog_loader.load_natural_earth_map(), ensure_ascii=False)

        places_snapshot = json.dumps(db.search_places(limit=1000), ensure_ascii=False)
        us_grid_snapshot = json.dumps(self.catalog_loader.load_us_state_grid(), ensure_ascii=False)

        # Pre-seed localStorage fallback so standalone file:// HTML renders offline immediately
        offline_seed_script = (
            f"if (!localStorage.getItem('places_backup_v1')) {{\n"
            f"  localStorage.setItem('places_backup_v1', JSON.stringify({places_snapshot}));\n"
            f"}}\n"
            f"window.__INITIAL_US_GRID__ = {us_grid_snapshot};\n"
        )

        return (
            template_html.replace("{{STYLES}}", styles_css)
            .replace("{{NATURAL_EARTH_MAP_JSON}}", ne_map_json)
            .replace("{{CLIENT_SCRIPT}}", offline_seed_script + client_js)
        )


_DEFAULT_GENERATOR = DashboardGenerator()


def generate_dashboard_html(db: PlacesDB) -> str:
    """Backward-compatible helper delegating to DashboardGenerator."""
    return _DEFAULT_GENERATOR.render_html(db)
