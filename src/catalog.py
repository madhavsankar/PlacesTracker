"""
CatalogLoader & Geographic Metadata Provider for PlacesTracker.
Encapsulates all static JSON datasets stored under `data/catalog/`.
"""

import json
import os
from typing import Any, Dict, List

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG_DIR = os.path.join(REPO_ROOT, "data", "catalog")


class FlagFormatter:
    """Utility class for converting ISO-3166 alpha-2 country codes to Unicode flag emojis."""

    UNICODE_OFFSET = 127397
    DEFAULT_EMOJI = "🌍"

    @classmethod
    def from_iso2(cls, iso2: str) -> str:
        if not iso2 or len(iso2) != 2:
            return cls.DEFAULT_EMOJI
        upper = iso2.upper()
        return chr(ord(upper[0]) + cls.UNICODE_OFFSET) + chr(ord(upper[1]) + cls.UNICODE_OFFSET)


class CatalogLoader:
    """Loads and caches static JSON datasets, schemas, and configurations from `data/catalog/`."""

    CATEGORY_FILES = (
        "countries.json",
        "territories.json",
        "us_states.json",
        "indian_states.json",
        "canadian_provinces.json",
        "world_wonders.json",
        "national_parks.json",
        "unesco_sites.json",
        "cities.json",
        "airports.json",
    )

    def __init__(self, catalog_dir: str = CATALOG_DIR) -> None:
        self.catalog_dir = catalog_dir
        self._cache: Dict[str, Any] = {}

    def _read_json(self, filename: str) -> Any:
        if filename not in self._cache:
            file_path = os.path.join(self.catalog_dir, filename)
            with open(file_path, "r", encoding="utf-8") as f:
                self._cache[filename] = json.load(f)
        return self._cache[filename]

    def load_all_places(self) -> List[Dict[str, Any]]:
        """Return all pre-seeded places across all categories."""
        items: List[Dict[str, Any]] = []
        for filename in self.CATEGORY_FILES:
            items.extend(self._read_json(filename))
        return items

    def load_aliases(self) -> Dict[str, str]:
        return self._read_json("aliases.json")

    def load_natural_earth_map(self) -> Dict[str, str]:
        return self._read_json("natural_earth_map.json")

    def load_us_state_grid(self) -> List[List[Any]]:
        return self._read_json("us_state_grid.json")

    def load_mcp_tools_schema(self) -> List[Dict[str, Any]]:
        return self._read_json("mcp_tools_schema.json")

    def load_app_metadata(self) -> Dict[str, Any]:
        return self._read_json("app_metadata.json")

    def load_gemini_prompt_schema(self) -> Dict[str, Any]:
        return self._read_json("gemini_prompt_schema.json")

    def load_pwa_manifest(self) -> Dict[str, Any]:
        return self._read_json("pwa_manifest.json")


_DEFAULT_LOADER = CatalogLoader()


def iso_to_flag(iso2: str) -> str:
    return FlagFormatter.from_iso2(iso2)


def build_all_catalog_items() -> List[Dict[str, Any]]:
    return _DEFAULT_LOADER.load_all_places()


def load_aliases() -> Dict[str, str]:
    return _DEFAULT_LOADER.load_aliases()


def load_natural_earth_map() -> Dict[str, str]:
    return _DEFAULT_LOADER.load_natural_earth_map()


def load_us_state_grid() -> List[List[Any]]:
    return _DEFAULT_LOADER.load_us_state_grid()


def load_mcp_tools_schema() -> List[Dict[str, Any]]:
    return _DEFAULT_LOADER.load_mcp_tools_schema()


def load_app_metadata() -> Dict[str, Any]:
    return _DEFAULT_LOADER.load_app_metadata()
