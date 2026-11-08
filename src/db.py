"""
Object-Oriented SQLite Database Repository for PlacesTracker.
Divided into:
  - `SchemaStatements`: Static SQL DDL and DML statements.
  - `PlacesDB`: Repository class for catalog seeding, smart place resolution,
    parent Country/State auto-propagation, statistics computation, and CSV import/export.
"""

import csv
import datetime
import io
import os
import re
import sqlite3
import unicodedata
from typing import Any, Dict, List, Optional

from catalog import build_all_catalog_items, iso_to_flag, load_aliases


def _strip_accents(text: str) -> str:
    """Normalize Unicode diacritics (e.g., Ambattūr -> ambattur, Montréal -> montreal)."""
    normalized = unicodedata.normalize("NFD", str(text or ""))
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn").lower().strip()

DEFAULT_DB_PATH = os.environ.get(
    "PLACES_TRACKER_DB",
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "data",
        "places_tracker.db",
    ),
)

ALIASES: Dict[str, str] = load_aliases()


class SchemaStatements:
    """Static SQL DDL and DML statements for the SQLite schema."""

    CREATE_PLACES_TABLE = """
        CREATE TABLE IF NOT EXISTS places (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            country_code TEXT DEFAULT '',
            state_code TEXT DEFAULT '',
            continent TEXT DEFAULT '',
            subregion TEXT DEFAULT '',
            lat REAL DEFAULT 0.0,
            lng REAL DEFAULT 0.0,
            flag_emoji TEXT DEFAULT '🌍',
            description TEXT DEFAULT '',
            is_custom INTEGER DEFAULT 0
        )
    """

    CREATE_USER_PLACES_TABLE = """
        CREATE TABLE IF NOT EXISTS user_places (
            place_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'visited',
            is_favorite INTEGER DEFAULT 0,
            visit_date TEXT DEFAULT '',
            rating INTEGER DEFAULT 0,
            trip_name TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            updated_at TEXT NOT NULL,
            FOREIGN KEY (place_id) REFERENCES places(id)
        )
    """

    CREATE_INDEXES = (
        "CREATE INDEX IF NOT EXISTS idx_places_cat ON places(category)",
        "CREATE INDEX IF NOT EXISTS idx_places_country ON places(country_code)",
        "CREATE INDEX IF NOT EXISTS idx_user_status ON user_places(status)",
    )

    SEED_PLACE = """
        INSERT OR REPLACE INTO places
        (id, name, category, country_code, state_code, continent, subregion, lat, lng, flag_emoji, description, is_custom)
        VALUES (:id, :name, :category, :country_code, :state_code, :continent, :subregion, :lat, :lng, :flag_emoji, :description, 0)
    """

    UPSERT_USER_PLACE = """
        INSERT INTO user_places (place_id, status, is_favorite, visit_date, rating, trip_name, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(place_id) DO UPDATE SET
            status = excluded.status,
            is_favorite = excluded.is_favorite,
            visit_date = excluded.visit_date,
            rating = excluded.rating,
            trip_name = excluded.trip_name,
            notes = excluded.notes,
            updated_at = excluded.updated_at
    """

    AUTO_PROPAGATE_PARENT = """
        INSERT INTO user_places (place_id, status, is_favorite, visit_date, rating, trip_name, notes, updated_at)
        VALUES (?, 'visited', 0, ?, 0, ?, ?, ?)
        ON CONFLICT(place_id) DO UPDATE SET status = 'visited', updated_at = excluded.updated_at
    """

    CSV_HEADERS = [
        "place_id",
        "name",
        "category",
        "country_code",
        "state_code",
        "continent",
        "lat",
        "lng",
        "status",
        "is_favorite",
        "visit_date",
        "rating",
        "trip_name",
        "notes",
    ]


class PlacesDB:
    """SQLite database repository managing catalog items and user travel tracking."""

    def __init__(self, db_path: str = DEFAULT_DB_PATH) -> None:
        self.db_path = db_path
        self.aliases = ALIASES
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(SchemaStatements.CREATE_PLACES_TABLE)
            conn.execute(SchemaStatements.CREATE_USER_PLACES_TABLE)
            for idx_sql in SchemaStatements.CREATE_INDEXES:
                conn.execute(idx_sql)

            cur = conn.execute("SELECT COUNT(*) as c FROM places WHERE is_custom = 0")
            count = cur.fetchone()["c"]
            seed_items = build_all_catalog_items()
            if count < len(seed_items):
                conn.executemany(SchemaStatements.SEED_PLACE, seed_items)
            conn.commit()

    def resolve_place(
        self, query: str, category_hint: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Resolve a place ID, name, ISO code, or fuzzy query to a catalog dictionary."""
        q = query.strip()
        if not q:
            return None
        q_lower = q.lower()
        q_norm = _strip_accents(q)

        with self._connect() as conn:
            row = conn.execute("SELECT * FROM places WHERE LOWER(id) = ?", (q_lower,)).fetchone()
            if row:
                return dict(row)

            if (q_lower in self.aliases or q_norm in self.aliases) and not category_hint:
                alias_id = self.aliases.get(q_lower) or self.aliases.get(q_norm)
                row = conn.execute("SELECT * FROM places WHERE id = ?", (alias_id,)).fetchone()
                if row:
                    return dict(row)

            if category_hint:
                row = conn.execute(
                    "SELECT * FROM places WHERE (LOWER(name) = ? OR LOWER(name) = ?) AND category = ?",
                    (q_lower, q_norm, category_hint),
                ).fetchone()
                if row:
                    return dict(row)

            row = conn.execute(
                "SELECT * FROM places WHERE LOWER(name) = ? OR LOWER(name) = ?",
                (q_lower, q_norm),
            ).fetchone()
            if row:
                return dict(row)

            # Match airport names without the "IATA — " prefix
            row = conn.execute(
                "SELECT * FROM places WHERE category = 'airport' AND LOWER(name) LIKE ?",
                (f"% — {q_norm}",),
            ).fetchone()
            if row:
                return dict(row)

            if "," in q:
                parts = [p.strip() for p in q.split(",", 1)]
                city_lower = parts[0].lower()
                reg_lower = parts[1].lower()
                st_row = conn.execute(
                    """
                    SELECT state_code, country_code FROM places
                    WHERE category IN ('us_state', 'indian_state', 'canadian_province')
                      AND (LOWER(name) = ? OR LOWER(state_code) = ? OR LOWER(state_code) = ? OR LOWER(state_code) = ?)
                    LIMIT 1
                    """,
                    (reg_lower, reg_lower, f"in-{reg_lower}", f"ca-{reg_lower}"),
                ).fetchone()
                if st_row:
                    city_row = conn.execute(
                        """
                        SELECT * FROM places
                        WHERE category = 'city' AND state_code = ?
                          AND (LOWER(name) = ? OR LOWER(name) LIKE ?)
                        LIMIT 1
                        """,
                        (st_row["state_code"], city_lower, f"{city_lower},%"),
                    ).fetchone()
                    if city_row:
                        return dict(city_row)

            if len(q) == 2:
                code_match = self._resolve_two_letter_code(conn, q.upper(), category_hint)
                if code_match:
                    return code_match

            if len(q) == 3:
                row = conn.execute(
                    "SELECT * FROM places WHERE category = 'airport' AND LOWER(id) = ?",
                    (f"airport:{q_lower}",),
                ).fetchone()
                if row:
                    return dict(row)

            if category_hint:
                row = conn.execute(
                    "SELECT * FROM places WHERE category = ? AND LOWER(name) LIKE ? ORDER BY LENGTH(name) ASC LIMIT 1",
                    (category_hint, f"%{q_lower}%"),
                ).fetchone()
                if row:
                    return dict(row)

            for pattern in (f"{q_lower}%", f"%{q_lower}%", f"{q_norm}%", f"%{q_norm}%"):
                row = conn.execute(
                    "SELECT * FROM places WHERE LOWER(name) LIKE ? ORDER BY LENGTH(name) ASC LIMIT 1",
                    (pattern,),
                ).fetchone()
                if row:
                    return dict(row)

            # Fallback: Unicode diacritic-insensitive scan across catalog names
            all_rows = conn.execute("SELECT * FROM places").fetchall()
            for r in all_rows:
                if category_hint and r["category"] != category_hint:
                    continue
                if _strip_accents(r["name"]) == q_norm:
                    return dict(r)
            for r in sorted(all_rows, key=lambda x: len(x["name"])):
                if category_hint and r["category"] != category_hint:
                    continue
                if q_norm in _strip_accents(r["name"]):
                    return dict(r)

        return None

    @staticmethod
    def _resolve_two_letter_code(
        conn: sqlite3.Connection, code_upper: str, category_hint: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        if category_hint == "us_state":
            row = conn.execute(
                "SELECT * FROM places WHERE category = 'us_state' AND UPPER(state_code) = ?",
                (code_upper,),
            ).fetchone()
            if row:
                return dict(row)

        for cat, col in (("country", "country_code"), ("us_state", "state_code")):
            row = conn.execute(
                f"SELECT * FROM places WHERE category = ? AND UPPER({col}) = ?",
                (cat, code_upper),
            ).fetchone()
            if row:
                return dict(row)
        return None

    def mark_places(
        self,
        places: List[str],
        status: str = "visited",
        is_favorite: Optional[bool] = None,
        visit_date: str = "",
        rating: int = 0,
        trip_name: str = "",
        notes: str = "",
        category_hint: Optional[str] = None,
        auto_propagate_parents: bool = True,
    ) -> Dict[str, Any]:
        """Mark places as 'visited', 'bucket_list', or 'unvisited' and auto-propagate parents."""
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        updated: List[Dict[str, Any]] = []
        auto_propagated: List[Dict[str, Any]] = []
        unresolved: List[str] = []

        with self._connect() as conn:
            for raw_item in places:
                resolved = self.resolve_place(raw_item, category_hint=category_hint)
                if not resolved:
                    unresolved.append(raw_item)
                    continue

                pid = resolved["id"]
                if status == "unvisited":
                    conn.execute("DELETE FROM user_places WHERE place_id = ?", (pid,))
                    updated.append(
                        {
                            "id": pid,
                            "name": resolved["name"],
                            "category": resolved["category"],
                            "status": "unvisited",
                        }
                    )
                    continue

                existing = conn.execute(
                    "SELECT * FROM user_places WHERE place_id = ?", (pid,)
                ).fetchone()
                fav_val = (
                    int(is_favorite)
                    if is_favorite is not None
                    else (existing["is_favorite"] if existing else 0)
                )
                date_val = visit_date or (existing["visit_date"] if existing else "")
                rating_val = rating or (existing["rating"] if existing else 0)
                trip_val = trip_name or (existing["trip_name"] if existing else "")
                notes_val = notes or (existing["notes"] if existing else "")

                conn.execute(
                    SchemaStatements.UPSERT_USER_PLACE,
                    (pid, status, fav_val, date_val, rating_val, trip_val, notes_val, now),
                )
                updated.append(
                    {
                        "id": pid,
                        "name": resolved["name"],
                        "category": resolved["category"],
                        "flag_emoji": resolved["flag_emoji"],
                        "status": status,
                        "is_favorite": bool(fav_val),
                    }
                )

                if status == "visited" and auto_propagate_parents:
                    self._propagate_parents(
                        conn, resolved, date_val, trip_val, now, auto_propagated
                    )

            conn.commit()

        return {
            "updated": updated,
            "auto_propagated": auto_propagated,
            "unresolved": unresolved,
        }

    @staticmethod
    def _propagate_parents(
        conn: sqlite3.Connection,
        resolved: Dict[str, Any],
        date_val: str,
        trip_val: str,
        now: str,
        auto_propagated: List[Dict[str, Any]],
    ) -> None:
        # Airport layovers must NOT auto-mark the parent country or state as visited
        if resolved.get("category") == "airport":
            return

        cc = resolved.get("country_code", "")
        sc = resolved.get("state_code", "")

        if cc and resolved["category"] not in ("country", "territory"):
            parent_country_id = f"country:{cc}"
            p_exists = conn.execute(
                "SELECT status FROM user_places WHERE place_id = ?", (parent_country_id,)
            ).fetchone()
            if not p_exists or p_exists["status"] != "visited":
                p_info = conn.execute(
                    "SELECT name, category, flag_emoji FROM places WHERE id = ?",
                    (parent_country_id,),
                ).fetchone()
                if p_info:
                    conn.execute(
                        SchemaStatements.AUTO_PROPAGATE_PARENT,
                        (
                            parent_country_id,
                            date_val,
                            trip_val,
                            f"Auto-logged via {resolved['name']}",
                            now,
                        ),
                    )
                    auto_propagated.append(
                        {
                            "id": parent_country_id,
                            "name": p_info["name"],
                            "category": p_info["category"],
                            "flag_emoji": p_info["flag_emoji"],
                            "reason": f"Visited {resolved['name']}",
                        }
                    )

        parent_subdivision_id = None
        if cc == "US" and sc and len(sc) == 2 and resolved["category"] != "us_state":
            parent_subdivision_id = f"us_state:{sc}"
        elif cc == "IN" and sc.startswith("IN-") and resolved["category"] != "indian_state":
            parent_subdivision_id = f"in_state:{sc[3:]}"
        elif cc == "CA" and sc.startswith("CA-") and resolved["category"] != "canadian_province":
            parent_subdivision_id = f"ca_province:{sc[3:]}"

        if parent_subdivision_id:
            s_exists = conn.execute(
                "SELECT status FROM user_places WHERE place_id = ?", (parent_subdivision_id,)
            ).fetchone()
            if not s_exists or s_exists["status"] != "visited":
                s_info = conn.execute(
                    "SELECT name, category, flag_emoji FROM places WHERE id = ?",
                    (parent_subdivision_id,),
                ).fetchone()
                if s_info:
                    conn.execute(
                        SchemaStatements.AUTO_PROPAGATE_PARENT,
                        (
                            parent_subdivision_id,
                            date_val,
                            trip_val,
                            f"Auto-logged via {resolved['name']}",
                            now,
                        ),
                    )
                    auto_propagated.append(
                        {
                            "id": parent_subdivision_id,
                            "name": s_info["name"],
                            "category": s_info["category"],
                            "flag_emoji": s_info["flag_emoji"],
                            "reason": f"Visited {resolved['name']}",
                        }
                    )

    def add_custom_place(
        self,
        name: str,
        category: str,
        country_code: str,
        state_code: str = "",
        lat: float = 0.0,
        lng: float = 0.0,
        description: str = "",
        status: str = "visited",
        is_favorite: bool = False,
        visit_date: str = "",
        notes: str = "",
    ) -> Dict[str, Any]:
        """Add a custom place and mark its status."""
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        pid = f"{category}:{slug}"
        cc = country_code.upper().strip()

        with self._connect() as conn:
            country_row = conn.execute(
                "SELECT continent, subregion FROM places WHERE id = ?", (f"country:{cc}",)
            ).fetchone()
            continent = country_row["continent"] if country_row else "World"
            subregion = state_code or (country_row["subregion"] if country_row else "")

            conn.execute(
                """
                INSERT OR REPLACE INTO places
                (id, name, category, country_code, state_code, continent, subregion, lat, lng, flag_emoji, description, is_custom)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    pid,
                    name.strip(),
                    category,
                    cc,
                    state_code.upper().strip(),
                    continent,
                    subregion,
                    lat,
                    lng,
                    iso_to_flag(cc),
                    description or f"Custom {category} in {cc}",
                ),
            )
            conn.commit()

        if status in ("visited", "bucket_list"):
            res = self.mark_places(
                [pid],
                status=status,
                is_favorite=is_favorite,
                visit_date=visit_date,
                notes=notes,
            )
            return {"place_id": pid, "name": name, "category": category, "mark_result": res}
        return {"place_id": pid, "name": name, "category": category}

    def search_places(
        self,
        query: str = "",
        category: str = "",
        status: str = "",
        country_code: str = "",
        continent: str = "",
        favorites_only: bool = False,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Search catalog & user places with flexible filtering."""
        sql = """
            SELECT
                p.*,
                COALESCE(u.status, 'unvisited') AS status,
                COALESCE(u.is_favorite, 0) AS is_favorite,
                COALESCE(u.visit_date, '') AS visit_date,
                COALESCE(u.rating, 0) AS rating,
                COALESCE(u.trip_name, '') AS trip_name,
                COALESCE(u.notes, '') AS notes
            FROM places p
            LEFT JOIN user_places u ON p.id = u.place_id
            WHERE 1=1
        """
        params: List[Any] = []

        if query:
            sql += " AND (LOWER(p.name) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(p.subregion) LIKE ?)"
            q_like = f"%{query.lower().strip()}%"
            params.extend([q_like, q_like, q_like])
        if category:
            sql += " AND p.category = ?"
            params.append(category)
        if country_code:
            sql += " AND UPPER(p.country_code) = ?"
            params.append(country_code.upper().strip())
        if continent:
            sql += " AND LOWER(p.continent) = ?"
            params.append(continent.lower().strip())
        if status:
            if status == "unvisited":
                sql += " AND u.status IS NULL"
            else:
                sql += " AND u.status = ?"
                params.append(status)
        if favorites_only:
            sql += " AND u.is_favorite = 1"

        sql += " ORDER BY CASE WHEN u.status = 'visited' THEN 0 WHEN u.status = 'bucket_list' THEN 1 ELSE 2 END, p.name ASC LIMIT ?"
        params.append(limit)

        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def get_stats(self) -> Dict[str, Any]:
        """Compute comprehensive 'Places Been' travel statistics and completion metrics."""
        with self._connect() as conn:
            cat_rows = conn.execute(
                """
                SELECT
                    p.category,
                    COUNT(*) AS total,
                    SUM(CASE WHEN u.status = 'visited' THEN 1 ELSE 0 END) AS visited,
                    SUM(CASE WHEN u.status = 'bucket_list' THEN 1 ELSE 0 END) AS bucket_list,
                    SUM(CASE WHEN u.is_favorite = 1 THEN 1 ELSE 0 END) AS favorites
                FROM places p
                LEFT JOIN user_places u ON p.id = u.place_id
                GROUP BY p.category
                """
            ).fetchall()
            by_category: Dict[str, Any] = {}
            for r in cat_rows:
                tot = r["total"] or 1
                vis = r["visited"] or 0
                by_category[r["category"]] = {
                    "total": r["total"],
                    "visited": vis,
                    "bucket_list": r["bucket_list"] or 0,
                    "favorites": r["favorites"] or 0,
                    "percent": round((vis / tot) * 100, 1),
                }

            us_np = conn.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN u.status = 'visited' THEN 1 ELSE 0 END) AS visited,
                    SUM(CASE WHEN u.status = 'bucket_list' THEN 1 ELSE 0 END) AS bucket_list
                FROM places p
                LEFT JOIN user_places u ON p.id = u.place_id
                WHERE p.category = 'national_park' AND p.country_code = 'US'
                  AND (p.name LIKE '%National Park%' OR p.name LIKE '%National and State Parks%')
                """
            ).fetchone()
            us_np_tot = us_np["total"] or 63
            us_np_vis = us_np["visited"] or 0
            by_category["us_national_parks"] = {
                "total": us_np_tot,
                "visited": us_np_vis,
                "bucket_list": us_np["bucket_list"] or 0,
                "percent": round((us_np_vis / us_np_tot) * 100, 1),
            }

            new7 = conn.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN u.status = 'visited' THEN 1 ELSE 0 END) AS visited
                FROM places p
                LEFT JOIN user_places u ON p.id = u.place_id
                WHERE p.category = 'world_wonder' AND p.subregion = 'New 7 Wonders'
                """
            ).fetchone()
            by_category["new_7_wonders"] = {
                "total": new7["total"] or 7,
                "visited": new7["visited"] or 0,
                "percent": round(((new7["visited"] or 0) / (new7["total"] or 7)) * 100, 1),
            }

            cont_rows = conn.execute(
                """
                SELECT
                    p.continent,
                    COUNT(*) AS total_countries,
                    SUM(CASE WHEN u.status = 'visited' THEN 1 ELSE 0 END) AS visited_countries
                FROM places p
                LEFT JOIN user_places u ON p.id = u.place_id
                WHERE p.category = 'country'
                GROUP BY p.continent
                ORDER BY visited_countries DESC, p.continent ASC
                """
            ).fetchall()
            continents: List[Dict[str, Any]] = []
            continents_touched = 0
            for r in cont_rows:
                tot = r["total_countries"] or 1
                vis = r["visited_countries"] or 0
                if vis > 0:
                    continents_touched += 1
                continents.append(
                    {
                        "continent": r["continent"],
                        "visited": vis,
                        "total": r["total_countries"],
                        "percent": round((vis / tot) * 100, 1),
                    }
                )

            visited_countries = conn.execute(
                """
                SELECT p.id, p.name, p.country_code, p.flag_emoji, p.continent, u.visit_date, u.is_favorite
                FROM places p
                JOIN user_places u ON p.id = u.place_id
                WHERE p.category = 'country' AND u.status = 'visited'
                ORDER BY p.name ASC
                """
            ).fetchall()

            tracked_rows = conn.execute(
                """
                SELECT p.id, p.name, p.category, p.country_code, p.state_code, p.continent,
                       p.flag_emoji, p.lat, p.lng, u.status, u.is_favorite, u.visit_date, u.rating, u.trip_name, u.notes
                FROM places p
                JOIN user_places u ON p.id = u.place_id
                ORDER BY u.updated_at DESC
                """
            ).fetchall()

        return {
            "summary": by_category,
            "continents_touched": continents_touched,
            "total_continents": len(continents),
            "continents": continents,
            "flag_belt": " ".join(r["flag_emoji"] for r in visited_countries)
            if visited_countries
            else "None yet",
            "visited_countries": [dict(r) for r in visited_countries],
            "tracked_places": [dict(r) for r in tracked_rows],
        }

    def export_csv(self) -> str:
        """Export user's tracked places as CSV."""
        stats = self.get_stats()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(SchemaStatements.CSV_HEADERS)
        for item in stats["tracked_places"]:
            writer.writerow(
                [
                    item["id"],
                    item["name"],
                    item["category"],
                    item["country_code"],
                    item["state_code"],
                    item["continent"],
                    item["lat"],
                    item["lng"],
                    item["status"],
                    item["is_favorite"],
                    item["visit_date"],
                    item["rating"],
                    item["trip_name"],
                    item["notes"],
                ]
            )
        return output.getvalue()

    def import_csv(self, csv_text: str) -> Dict[str, Any]:
        """Import places from standard comma-separated CSV or Places Been semicolon CSV (lat;lon;country;city;been)."""
        stripped = csv_text.strip()
        if not stripped:
            return {"imported": 0, "visited_count": 0, "bucket_count": 0}
        first_line = stripped.splitlines()[0]
        delimiter = ";" if ";" in first_line else ","
        reader = csv.DictReader(io.StringIO(stripped), delimiter=delimiter)
        visited_count = 0
        bucket_count = 0
        for row in reader:
            name_or_id = (
                row.get("place_id")
                or row.get("name")
                or row.get("Name")
                or row.get("city")
                or row.get("Place")
                or row.get("country")
            )
            if not name_or_id:
                continue
            cc = str(row.get("country_code") or row.get("country") or "").strip().upper()
            raw_status = (
                row.get("status") or row.get("Status") or row.get("been") or "visited"
            ).lower().strip()
            if raw_status in ("want", "bucket_list", "wishlist"):
                status = "bucket_list"
            elif raw_status == "unvisited":
                status = "unvisited"
            else:
                status = "visited"

            resolved = self.resolve_place(f"{name_or_id}, {cc}" if len(cc) == 2 else name_or_id) or self.resolve_place(name_or_id)
            target_key = resolved["id"] if resolved else name_or_id
            fav = str(row.get("is_favorite", "0")).lower() in ("1", "true", "yes")
            res = self.mark_places(
                [target_key],
                status=status,
                is_favorite=fav,
                visit_date=row.get("visit_date", ""),
                notes=row.get("notes", ""),
            )
            if res["updated"]:
                if status == "visited":
                    visited_count += len(res["updated"])
                elif status == "bucket_list":
                    bucket_count += len(res["updated"])
                    # Also auto-mark parent country as bucket_list if currently unvisited
                    r_item = resolved or self.resolve_place(target_key)
                    if r_item and r_item.get("country_code") and r_item.get("category") not in ("country", "territory", "airport"):
                        parent_cc = r_item["country_code"]
                        with self._connect() as conn:
                            p_exists = conn.execute(
                                "SELECT status FROM user_places WHERE place_id = ?",
                                (f"country:{parent_cc}",),
                            ).fetchone()
                        if not p_exists:
                            self.mark_places([f"country:{parent_cc}"], status="bucket_list", auto_propagate_parents=False)
        return {
            "imported": visited_count + bucket_count,
            "visited_count": visited_count,
            "bucket_count": bucket_count,
        }
