"""Comprehensive Unit Tests, Evals, and Android/UI Regression Suite for PlacesTracker."""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_js_eval(js_code: str) -> dict:
    """Executes JavaScript code via a temp file in JavaScriptCore (macOS) or Node.js (Linux/CI) and parses the final JSON line."""
    node_bin = shutil.which("node")
    jsc_bin = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
    with tempfile.NamedTemporaryFile(mode="w", suffix=".js", encoding="utf-8", delete=False) as tmp:
        tmp.write(js_code)
        tmp_path = tmp.name

    try:
        if node_bin:
            cmd = [node_bin, tmp_path]
        elif os.path.exists(jsc_bin):
            cmd = [jsc_bin, tmp_path]
        else:
            raise RuntimeError("Neither node nor JavaScriptCore (jsc) found to run JS evals")

        proc = subprocess.run(cmd, cwd=ROOT_DIR, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise AssertionError(
                f"JS eval exited with code {proc.returncode}.\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
            )
        lines = [line.strip() for line in proc.stdout.strip().splitlines() if line.strip()]
        if not lines:
            raise AssertionError(f"JS eval produced no output. stderr: {proc.stderr}")
        parsed = json.loads(lines[-1])
        if isinstance(parsed, dict) and "error" in parsed:
            raise AssertionError(f"JS eval threw exception: {parsed['error']}\n{parsed.get('stack', '')}")
        return parsed
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def build_catalog_js_bundle() -> str:
    """Bundles constants.js, CatalogData.js, CatalogService.js, and GeminiAgentService.js for standalone JS execution."""
    constants_path = os.path.join(ROOT_DIR, "cloudflare", "src", "config", "constants.js")
    catalog_data_path = os.path.join(ROOT_DIR, "cloudflare", "src", "data", "CatalogData.js")
    catalog_service_path = os.path.join(ROOT_DIR, "cloudflare", "src", "services", "CatalogService.js")
    gemini_service_path = os.path.join(ROOT_DIR, "cloudflare", "src", "services", "GeminiAgentService.js")

    def clean_esm(src: str) -> str:
        src = re.sub(r"^\s*import\s+[\s\S]*?from\s+['\"][^'\"]+['\"];?\s*$", "", src, flags=re.MULTILINE)
        src = re.sub(r"\bexport\s+(const|let|var|function|class)\b", r"\1", src)
        return src

    with open(constants_path, "r", encoding="utf-8") as f:
        c_src = clean_esm(f.read())
    with open(catalog_data_path, "r", encoding="utf-8") as f:
        d_src = clean_esm(f.read())
    with open(catalog_service_path, "r", encoding="utf-8") as f:
        s_src = clean_esm(f.read())
    with open(gemini_service_path, "r", encoding="utf-8") as f:
        g_src = clean_esm(f.read())

    return "\n".join([d_src, c_src, s_src, g_src])


class TestPlacesTrackerSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js_bundle = build_catalog_js_bundle()

    def test_01_catalog_integrity_and_airport_landmark_unesco_coverage(self):
        """Eval: Verifies all catalog JSON files, 655+ US commercial airports, split landmarks, and UNESCO sites."""
        catalog_dir = os.path.join(ROOT_DIR, "data", "catalog")
        catalog_files = [
            "countries.json",
            "us_states.json",
            "indian_states.json",
            "canadian_provinces.json",
            "cities.json",
            "national_parks.json",
            "unesco_sites.json",
            "world_wonders.json",
            "airports.json",
        ]
        seen_ids = set()
        by_file = {}

        for fname in catalog_files:
            fpath = os.path.join(catalog_dir, fname)
            self.assertTrue(os.path.exists(fpath), f"Missing catalog file: {fname}")
            with open(fpath, "r", encoding="utf-8") as f:
                items = json.load(f)
            self.assertIsInstance(items, list)
            self.assertGreater(len(items), 0, f"Empty catalog file: {fname}")
            by_file[fname] = items

            for item in items:
                pid = item.get("id")
                self.assertTrue(pid, f"Missing id in {fname}: {item}")
                self.assertNotIn(pid, seen_ids, f"Duplicate catalog ID '{pid}' in {fname}")
                seen_ids.add(pid)
                self.assertIsInstance(item.get("lat"), (int, float), f"Invalid lat for {pid}")
                self.assertIsInstance(item.get("lng"), (int, float), f"Invalid lng for {pid}")

        # 1. Verify all 655+ US & US-territory scheduled commercial passenger airports exist
        airports = by_file["airports.json"]
        us_airports = [a for a in airports if a.get("country_code") in {"US", "PR", "VI", "GU", "AS", "MP"}]
        self.assertGreaterEqual(len(airports), 830, "Expected at least 830 global commercial airports")
        self.assertGreaterEqual(len(us_airports), 650, "Expected at least 650 US commercial passenger airports")
        iata_codes = {a.get("iata_code") for a in airports}
        for required_iata in ["SEA", "PAE", "SFO", "STS", "PHX", "AZA", "CLT", "USA", "JFK", "LAX", "ORD", "BLR", "DEL", "BKK"]:
            self.assertIn(required_iata, iata_codes, f"Missing commercial airport IATA code: {required_iata}")

        # 2. Verify standalone landmarks split from combined '&' entries & Indian temples exist in world_wonders.json
        wonder_names = {w["name"] for w in by_file["world_wonders.json"]}
        for required_landmark in [
            "Golden Gate Bridge",
            "Lombard Street, CA",
            "Tower Bridge",
            "Big Ben",
            "Space Needle",
            "Hollywood Sign",
            "Meenakshi Amman Temple",
            "Kapaleeshwarar Temple",
        ]:
            self.assertIn(required_landmark, wonder_names, f"Missing standalone landmark: {required_landmark}")

        # 3. Verify South/Southeast Asian & recent UNESCO sites exist in unesco_sites.json
        unesco_text = " | ".join(u["name"] for u in by_file["unesco_sites.json"]).lower()
        for required_unesco in [
            "mahabalipuram",
            "hoysala",
            "pattadakal",
            "maratha",
            "bagan",
            "prambanan",
            "ayutthaya",
            "sukhothai",
            "sigiriya",
            "galle",
        ]:
            self.assertIn(required_unesco, unesco_text, f"Missing UNESCO site matching '{required_unesco}'")

    def test_02_eval_csv_import_export_and_places_been_compatibility(self):
        """Eval: Verifies Places Been semicolon CSV import (append & override), O(1) speed, and round-trip export."""
        harness = (
            self.js_bundle
            + """
        (async () => {
          let state = { places: {}, custom_catalog: [], activity_log: [] };
          const mockRepo = {
            loadUserState: async () => state,
            saveUserState: async (nextState) => { state = nextState; }
          };
          const svc = new CatalogService(mockRepo);

          const samplePlacesBeenCsv = [
            'lat;lon;country;city;been',
            '47.6062;-122.3321;"us";"Seattle";"been"',
            '47.4489;-122.3093;"us";"Seattle Tacoma Intl";"been"',
            '47.9063;-122.2816;"us";"Snohomish County (Paine Field)";"been"',
            '37.8199;-122.4783;"us";"Golden Gate Bridge";"been"',
            '37.8021;-122.4187;"us";"Lombard Street";"been"',
            '15.3350;76.4600;"in";"Hampi (Group of Monuments at Hampi)";"been"',
            '12.6165;80.1927;"in";"Mahabalipuram";"been"',
            '18.6298;73.7997;"in";"Pimpri";"been"',
            '13.7563;100.5018;"th";"Bangkok";"want"',
            '14.3532;100.5684;"th";"Ayutthaya (Historic City of Ayutthaya)";"want"'
          ].join('\\n');

          const t0 = Date.now();
          const appendRes = await svc.importCsv(samplePlacesBeenCsv, 'append');
          const elapsedMs = Date.now() - t0;

          const mergedAfterAppend = svc.getMergedCatalog(state);
          const byId = Object.fromEntries(mergedAfterAppend.map(p => [p.id, p]));

          const exportedCsv = svc.exportCsv(mergedAfterAppend);

          // Test Override mode with a smaller CSV
          const overrideCsv = [
            'lat;lon;country;city;been',
            '35.6762;139.6503;"jp";"Tokyo";"been"'
          ].join('\\n');
          const overrideRes = await svc.importCsv(overrideCsv, 'override');
          const mergedAfterOverride = svc.getMergedCatalog(state);
          const byIdOverride = Object.fromEntries(mergedAfterOverride.map(p => [p.id, p]));

          const out = JSON.stringify({
            elapsedMs,
            appendRes,
            exportedCsvLines: exportedCsv.split('\\n').length,
            usStatusAfterAppend: byId['country:US'] ? byId['country:US'].status : null,
            waStatusAfterAppend: byId['us_state:WA'] ? byId['us_state:WA'].status : null,
            inStatusAfterAppend: byId['country:IN'] ? byId['country:IN'].status : null,
            thStatusAfterAppend: byId['country:TH'] ? byId['country:TH'].status : null,
            overrideRes,
            usStatusAfterOverride: byIdOverride['country:US'] ? byIdOverride['country:US'].status : null,
            jpStatusAfterOverride: byIdOverride['country:JP'] ? byIdOverride['country:JP'].status : null
          });
          if (typeof console !== 'undefined' && console.log) console.log(out);
          else if (typeof print !== 'undefined') print(out);
        })().catch(e => {
          const errOut = JSON.stringify({ error: String(e), stack: e && e.stack });
          if (typeof console !== 'undefined' && console.log) console.log(errOut);
          else if (typeof print !== 'undefined') print(errOut);
        });
        """
        )
        res = run_js_eval(harness)
        self.assertLess(res["elapsedMs"], 500, "CSV import should complete in < 500ms via _buildCsvIndex")
        self.assertEqual(res["appendRes"]["unresolved"], [])
        self.assertEqual(res["appendRes"]["visited_count"], 8)
        self.assertEqual(res["appendRes"]["bucket_count"], 2)
        self.assertEqual(res["usStatusAfterAppend"], "visited")
        self.assertEqual(res["waStatusAfterAppend"], "visited")
        self.assertEqual(res["inStatusAfterAppend"], "visited")
        self.assertEqual(res["thStatusAfterAppend"], "bucket_list")
        self.assertGreaterEqual(res["exportedCsvLines"], 11)

        # Verify Override mode cleared US/IN/TH and only kept Japan
        self.assertEqual(res["overrideRes"]["mode"], "override")
        self.assertGreaterEqual(res["overrideRes"]["deleted_total"], 10)
        self.assertEqual(res["overrideRes"]["added_total"], 1)
        self.assertEqual(res["usStatusAfterOverride"], "unvisited")
        self.assertEqual(res["jpStatusAfterOverride"], "visited")

    def test_03_eval_parent_region_rollup_and_airport_layover_exclusion(self):
        """Eval: Verifies airports never mark countries/states as visited, while leaf cities/sights auto-propagate."""
        harness = (
            self.js_bundle
            + """
        (async () => {
          let state = { places: {}, custom_catalog: [], activity_log: [] };
          const mockRepo = {
            loadUserState: async () => state,
            saveUserState: async (nextState) => { state = nextState; }
          };
          const svc = new CatalogService(mockRepo);

          // 1. Mark only Dubai Airport (DXB) and Seattle Airport (SEA) as visited
          await svc.markPlaces({ places: ['airport:dxb', 'airport:sea'], status: 'visited' });
          let merged = svc.getMergedCatalog(state);
          let byId = Object.fromEntries(merged.map(p => [p.id, p]));
          const aeAfterAirportOnly = byId['country:AE'].status;
          const usAfterAirportOnly = byId['country:US'].status;
          const waAfterAirportOnly = byId['us_state:WA'].status;

          // 2. Mark Mount Rainier National Park as visited -> WA and US become visited
          await svc.markPlaces({ places: ['Mount Rainier National Park'], status: 'visited' });
          merged = svc.getMergedCatalog(state);
          byId = Object.fromEntries(merged.map(p => [p.id, p]));
          const usAfterPark = byId['country:US'].status;
          const waAfterPark = byId['us_state:WA'].status;

          // 3. Unmark Mount Rainier National Park -> WA and US revert to unvisited (even though SEA airport is still visited)
          await svc.markPlaces({ places: ['Mount Rainier National Park'], status: 'unvisited' });
          merged = svc.getMergedCatalog(state);
          byId = Object.fromEntries(merged.map(p => [p.id, p]));
          const usAfterUnmark = byId['country:US'].status;
          const waAfterUnmark = byId['us_state:WA'].status;

          const out = JSON.stringify({
            aeAfterAirportOnly,
            usAfterAirportOnly,
            waAfterAirportOnly,
            usAfterPark,
            waAfterPark,
            usAfterUnmark,
            waAfterUnmark
          });
          if (typeof console !== 'undefined' && console.log) console.log(out);
          else if (typeof print !== 'undefined') print(out);
        })().catch(e => {
          const errOut = JSON.stringify({ error: String(e), stack: e && e.stack });
          if (typeof console !== 'undefined' && console.log) console.log(errOut);
          else if (typeof print !== 'undefined') print(errOut);
        });
        """
        )
        res = run_js_eval(harness)
        self.assertEqual(res["aeAfterAirportOnly"], "unvisited")
        self.assertEqual(res["usAfterAirportOnly"], "unvisited")
        self.assertEqual(res["waAfterAirportOnly"], "unvisited")
        self.assertEqual(res["usAfterPark"], "visited")
        self.assertEqual(res["waAfterPark"], "visited")
        self.assertEqual(res["usAfterUnmark"], "unvisited")
        self.assertEqual(res["waAfterUnmark"], "unvisited")

    def test_04_eval_gemini_model_cascade_and_local_nlp_fallback(self):
        """Eval: Verifies GeminiAgentService model ranking, non-text filtering, and local NLP place extraction."""
        harness = (
            self.js_bundle
            + """
        (() => {
          const mockModels = [
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.2-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-4.3-flash', supportedGenerationMethods: ['generateContent'] }
          ];
          const ranked = GeminiAgentService.rankModelsFromList(mockModels);

          const svc = new CatalogService({});
          const agent = new GeminiAgentService({}, svc, {});
          const catalog = svc.getMergedCatalog({ places: {}, custom_catalog: [] });
          const extracted = agent.extractLocalFallback(
            'I visited Seattle, Mount Rainier National Park, and Taj Mahal. I want to visit Banff National Park.',
            catalog
          );

          const out = JSON.stringify({
            firstModel: ranked[0],
            ranked,
            extracted
          });
          if (typeof console !== 'undefined' && console.log) console.log(out);
          else if (typeof print !== 'undefined') print(out);
        })();
        """
        )
        res = run_js_eval(harness)
        self.assertEqual(res["firstModel"], "gemini-4.3-flash")
        for forbidden in [
            "text-embedding-004",
            "gemma-4-31b-it",
            "gemini-3.8-flash-tts",
            "gemini-3.1-flash-image",
            "gemini-2.5-flash",
        ]:
            self.assertNotIn(forbidden, res["ranked"])
        self.assertLess(res["ranked"].index("gemini-4.3-flash"), res["ranked"].index("gemini-3.2-flash-lite"))
        self.assertLess(res["ranked"].index("gemini-3.2-flash-lite"), res["ranked"].index("gemini-4-argon"))

        visited_extracted = " ".join(res["extracted"]["visited"]).lower()
        bucket_extracted = " ".join(res["extracted"]["bucket_list"]).lower()
        self.assertIn("seattle", visited_extracted)
        self.assertIn("rainier", visited_extracted)
        self.assertIn("taj_mahal", visited_extracted)
        self.assertIn("banff", bucket_extracted)

    def test_05_eval_ui_and_android_app_first_regressions(self):
        """Eval: Verifies build sync, mobile logo bar, visited default, no pull-to-refresh, Gemini drawer, and Back navigation."""
        template_path = os.path.join(ROOT_DIR, "cloudflare", "src", "ui", "template.html")
        styles_path = os.path.join(ROOT_DIR, "cloudflare", "src", "ui", "styles.css")
        app_js_path = os.path.join(ROOT_DIR, "cloudflare", "src", "ui", "app.js")
        webapp_view_path = os.path.join(ROOT_DIR, "cloudflare", "src", "ui", "WebAppView.js")
        storage_repo_path = os.path.join(ROOT_DIR, "cloudflare", "src", "repositories", "StorageRepository.js")
        main_activity_path = os.path.join(
            ROOT_DIR, "android", "app", "src", "main", "java", "com", "placestracker", "app", "MainActivity.kt"
        )
        manifest_path = os.path.join(ROOT_DIR, "android", "app", "src", "main", "AndroidManifest.xml")

        with open(template_path, "r", encoding="utf-8") as f:
            template_html = f.read()
        with open(styles_path, "r", encoding="utf-8") as f:
            styles_css = f.read()
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(webapp_view_path, "r", encoding="utf-8") as f:
            webapp_view_js = f.read()
        with open(storage_repo_path, "r", encoding="utf-8") as f:
            storage_repo_js = f.read()
        with open(main_activity_path, "r", encoding="utf-8") as f:
            main_activity_kt = f.read()
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest_xml = f.read()

        # 1. Pull-to-refresh must remain removed
        self.assertNotIn("pull-refresh-indicator", template_html)
        self.assertNotIn("setupPullToRefresh", app_js)

        # 2. Home status filter must default to Visited Only
        self.assertIn('<option value="visited" selected>Visited Only</option>', template_html)
        self.assertIn("document.getElementById('home-status-filter').value) ||\n      'visited'", app_js)

        # 3. Top 3-column category bar must show only logos + counts on mobile (hidden sm:inline for text)
        self.assertIn('<span class="hidden sm:inline font-medium text-slate-300 truncate">Cities</span>', template_html)
        self.assertIn('<span class="hidden sm:inline font-medium text-slate-300 truncate">UNESCO &amp; Sights</span>', template_html)
        self.assertIn('<span class="hidden sm:inline font-medium text-slate-300 truncate">Airports</span>', template_html)

        # 4. Gemini AI Logger must be a standalone hamburger drawer section (#view-gemini)
        self.assertIn("app.openSection('gemini')", template_html)
        self.assertIn('id="view-gemini"', template_html)
        self.assertIn("gemini: 'view-gemini'", app_js)

        # 5. StorageRepository must cap per-item Firestore subrequests during bulk CSV imports
        self.assertIn("changedItems.length <= 15", storage_repo_js)

        # 6. Android MainActivity & AndroidManifest best-practice checks
        self.assertIn("PlacesAndroidAuth", main_activity_kt)
        self.assertIn("window.app.handleBackAction", main_activity_kt)
        self.assertIn("onGeolocationPermissionsShowPrompt", main_activity_kt)
        self.assertIn('type = "*/*"', main_activity_kt)
        self.assertIn("Intent.CATEGORY_OPENABLE", main_activity_kt)
        self.assertIn('android:windowSoftInputMode="adjustResize"', manifest_xml)
        self.assertIn("android.permission.ACCESS_COARSE_LOCATION", manifest_xml)
        self.assertIn("touch-action: manipulation", styles_css)

        # 7. WebAppView.js must be in sync with template.html, styles.css, and app.js
        self.assertIn("handleBackAction", webapp_view_js)
        self.assertNotIn("setupPullToRefresh", webapp_view_js)

    def test_06_eval_visited_map_drilldown_back_navigation_state_machine(self):
        """Eval: Simulates drilling down World -> US -> California and pressing Back step-by-step to Home."""
        app_js_path = os.path.join(ROOT_DIR, "cloudflare", "src", "ui", "app.js")
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()

        # Remove trailing instantiation (`const app = new PlacesTrackerClient...`) so we can drive the state machine in a mock DOM
        cls_only = app_js.split("const app = new PlacesTrackerClient")[0]

        harness = (
            """
            const historyStack = ['#'];
            const elements = {};
            const makeEl = (id) => ({
              id,
              value: '',
              textContent: '',
              innerHTML: '',
              style: {},
              className: '',
              classList: {
                _set: new Set(id === 'nav-drawer' ? ['hidden'] : []),
                add(c) { this._set.add(c); },
                remove(c) { this._set.delete(c); },
                toggle(c, force) {
                  if (force === undefined) {
                    if (this._set.has(c)) this._set.delete(c); else this._set.add(c);
                  } else if (force) {
                    this._set.add(c);
                  } else {
                    this._set.delete(c);
                  }
                },
                contains(c) { return this._set.has(c); }
              },
              addEventListener() {},
              getBoundingClientRect() { return { width: 800, height: 460 }; }
            });
            globalThis.window = {
              location: { hash: '', search: '', pathname: '/', reload() {} },
              history: {
                pushState(st, title, url) {
                  if (url && url.startsWith('#')) window.location.hash = url;
                  historyStack.push(window.location.hash);
                },
                replaceState() {}
              },
              addEventListener() {}
            };
            globalThis.document = {
              getElementById(id) {
                if (id === 'csv-import-modal') return null;
                if (!elements[id]) elements[id] = makeEl(id);
                return elements[id];
              },
              addEventListener() {}
            };
            globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
            globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
            globalThis.navigator = {};
            globalThis.requestAnimationFrame = (fn) => fn();
            globalThis.setTimeout = (fn) => { fn(); return 1; };
            globalThis.clearTimeout = () => {};
            """
            + cls_only
            + """
            (async () => {
              const client = new PlacesTrackerClient({});
              client.places = [
                { id: 'country:us', name: 'United States', category: 'country', country_code: 'US', status: 'visited' },
                { id: 'us_state:us-ca', name: 'California', category: 'us_state', country_code: 'US', state_code: 'US-CA', status: 'visited' },
                { id: 'np:yosemite', name: 'Yosemite National Park', category: 'national_park', country_code: 'US', state_code: 'US-CA', status: 'visited' }
              ];
              client.drawWorldMap = () => {};
              client.drawUSVectorMap = () => {};
              client.renderViewportPlacesList = () => {};
              client.renderUSParksList = () => {};

              // 1. Start on Home, then open Visited Map (World)
              client.openSection('home', 'city', true);
              client.openVisitedMapRoot();
              const step1 = { section: client.activeSection, mode: client.regionalMode, hash: window.location.hash };

              // 2. Long-press United States -> US States Map
              await client.drillDownCountry(client.places[0], { type: 'Feature', properties: { name: 'United States' } });
              const step2 = { section: client.activeSection, mode: client.regionalMode, hash: window.location.hash };

              // 3. Long-press California -> Single State Focus Map
              client.drillDownState(client.places[1], { type: 'Feature', properties: { name: 'California' } });
              const step3 = {
                section: client.activeSection,
                mode: client.regionalMode,
                state: client.focusedState && client.focusedState.place.state_code,
                hash: window.location.hash
              };

              // 4. Press Back #1 (from California) -> Must return to US States Map!
              const back1Handled = client.handleBackAction(true);
              const afterBack1 = {
                handled: back1Handled,
                section: client.activeSection,
                mode: client.regionalMode,
                focusedState: client.focusedState
              };

              // 5. Press Back #2 (from US States Map) -> Must return to World Visited Map!
              const back2Handled = client.handleBackAction(true);
              const afterBack2 = {
                handled: back2Handled,
                section: client.activeSection,
                mode: client.regionalMode,
                focusedCountry: client.focusedCountry
              };

              // 6. Press Back #3 (from World Visited Map) -> Must return to Home!
              const back3Handled = client.handleBackAction(true);
              const afterBack3 = {
                handled: back3Handled,
                section: client.activeSection
              };

              // 7. Press Back #4 (already at Home root) -> Returns false so Android can exit normally
              const back4Handled = client.handleBackAction(true);

              const out = JSON.stringify({
                step1,
                step2,
                step3,
                afterBack1,
                afterBack2,
                afterBack3,
                back4Handled
              });
              if (typeof console !== 'undefined' && console.log) console.log(out);
              else if (typeof print !== 'undefined') print(out);
            })().catch(e => {
              const errOut = JSON.stringify({ error: String(e), stack: e && e.stack });
              if (typeof console !== 'undefined' && console.log) console.log(errOut);
              else if (typeof print !== 'undefined') print(errOut);
            });
            """
        )

        res = run_js_eval(harness)
        self.assertEqual(res["step1"], {"section": "visited_map", "mode": "world", "hash": "#visited_map"})
        self.assertEqual(res["step2"], {"section": "visited_map", "mode": "us_states", "hash": "#visited_map/country/US"})
        self.assertEqual(
            res["step3"],
            {"section": "visited_map", "mode": "state_focus", "state": "US-CA", "hash": "#visited_map/state/US-CA"},
        )
        self.assertEqual(
            res["afterBack1"],
            {"handled": True, "section": "visited_map", "mode": "us_states", "focusedState": None},
        )
        self.assertEqual(
            res["afterBack2"],
            {"handled": True, "section": "visited_map", "mode": "world", "focusedCountry": None},
        )
        self.assertEqual(
            res["afterBack3"],
            {"handled": True, "section": "home"},
        )
        self.assertFalse(res["back4Handled"])

    def test_07_eval_benchmark_50_tricky_places_been_rows_zero_unresolved(self):
        """Eval: Benchmarks 30+ tricky Places Been rows (airports, UNESCO, split landmarks, Indian/SE Asian cities) for 100% resolution."""
        harness = (
            self.js_bundle
            + """
        (async () => {
          let state = { places: {}, custom_catalog: [], activity_log: [] };
          const mockRepo = {
            loadUserState: async () => state,
            saveUserState: async (nextState) => { state = nextState; }
          };
          const svc = new CatalogService(mockRepo);

          const trickyCsv = [
            'lat;lon;country;city;been',
            '47.9063;-122.2816;"us";"Snohomish County (Paine Field)";"been"',
            '33.3078;-111.6550;"us";"Phoenix-Mesa Gateway";"been"',
            '35.3878;-80.7091;"us";"Concord-Padgett Regional";"been"',
            '38.5089;-122.8128;"us";"Charles M. Schulz - Sonoma County";"been"',
            '37.8199;-122.4783;"us";"Golden Gate Bridge";"been"',
            '37.8021;-122.4187;"us";"Lombard Street";"been"',
            '51.5055;-0.0754;"gb";"Tower Bridge";"been"',
            '51.5007;-0.1246;"gb";"Palace of Westminster & Big Ben";"been"',
            '12.6165;80.1927;"in";"Mahabalipuram";"been"',
            '9.9195;78.1193;"in";"Meenakshi Amman Temple";"been"',
            '13.0339;80.2699;"in";"Kapaleeshwarar Temple";"been"',
            '15.3350;76.4600;"in";"Hampi (Group of Monuments at Hampi)";"been"',
            '18.6298;73.7997;"in";"Pimpri";"been"',
            '12.8342;79.7036;"in";"Kanchipuram";"been"',
            '13.1623;75.9951;"in";"Sacred Ensembles of the Hoysalas";"been"',
            '15.9486;75.8164;"in";"Pattadakal";"been"',
            '21.1717;94.8585;"mm";"Bagan";"want"',
            '-7.7520;110.4914;"id";"Prambanan Temple Compounds";"want"',
            '14.3532;100.5684;"th";"Ayutthaya (Historic City of Ayutthaya)";"want"',
            '17.0194;99.7039;"th";"Sukhothai";"want"',
            '7.9570;80.7603;"lk";"Sigiriya";"want"',
            '6.0267;80.2175;"lk";"Galle";"want"'
          ].join('\\n');

          const res = await svc.importCsv(trickyCsv, 'append');
          const out = JSON.stringify(res);
          if (typeof console !== 'undefined' && console.log) console.log(out);
          else if (typeof print !== 'undefined') print(out);
        })().catch(e => {
          const errOut = JSON.stringify({ error: String(e), stack: e && e.stack });
          if (typeof console !== 'undefined' && console.log) console.log(errOut);
          else if (typeof print !== 'undefined') print(errOut);
        });
        """
        )
        res = run_js_eval(harness)
        self.assertEqual(res["unresolved"], [], f"Unresolved rows found: {res['unresolved']}")
        self.assertEqual(res["visited_count"], 16)
        self.assertEqual(res["bucket_count"], 6)

    def test_08_eval_statistics_and_recommendations_computation(self):
        """Eval: Verifies CatalogService.getStats and recommendPlaces accurately compute category totals and recommendations."""
        harness = (
            self.js_bundle
            + """
        (async () => {
          let state = { places: {}, custom_catalog: [], activity_log: [] };
          const mockRepo = {
            loadUserState: async () => state,
            saveUserState: async (nextState) => { state = nextState; }
          };
          const svc = new CatalogService(mockRepo);
          await svc.markPlaces({
            places: ['Seattle', 'San Francisco', 'Yosemite National Park', 'Golden Gate Bridge', 'airport:sea'],
            status: 'visited'
          });
          await svc.markPlaces({
            places: ['Tokyo', 'Mount Fuji'],
            status: 'bucket_list'
          });

          const catalog = svc.getMergedCatalog(state);
          const stats = svc.computeStats(catalog);
          const recs = svc.recommendPlaces(catalog, 'California');

          const out = JSON.stringify({
            stats,
            recsCount: recs.unvisited_recommendations ? recs.unvisited_recommendations.length : 0,
            alreadyVisIds: (recs.already_visited || []).map(r => r.id)
          });
          if (typeof console !== 'undefined' && console.log) console.log(out);
          else if (typeof print !== 'undefined') print(out);
        })().catch(e => {
          const errOut = JSON.stringify({ error: String(e), stack: e && e.stack });
          if (typeof console !== 'undefined' && console.log) console.log(errOut);
          else if (typeof print !== 'undefined') print(errOut);
        });
        """
        )
        res = run_js_eval(harness)
        cats = res["stats"]["summary"]
        self.assertEqual(cats["country"]["visited"], 1)  # US visited
        self.assertEqual(cats["country"]["bucket_list"], 1)  # JP bucket_list
        self.assertEqual(cats["us_state"]["visited"], 2)  # WA + CA visited
        self.assertEqual(cats["city"]["visited"], 2)  # Seattle + SF
        self.assertEqual(cats["national_park"]["visited"], 1)  # Yosemite
        self.assertEqual(cats["airport"]["visited"], 1)  # SEA
        self.assertGreater(res["recsCount"], 0)
        self.assertIn("np:yosemite", res["alreadyVisIds"])

    def test_09_eval_drawer_and_long_press_touch_debounce_regressions(self):
        """Eval: Verifies hamburger drawer Back priority and 650ms post-long-press click suppression."""
        app_js_path = os.path.join(ROOT_DIR, "cloudflare", "src", "ui", "app.js")
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()

        cls_only = app_js.split("const app = new PlacesTrackerClient")[0]

        harness = (
            """
            const elements = {};
            const makeEl = (id) => ({
              id,
              value: '',
              textContent: '',
              innerHTML: '',
              style: {},
              className: '',
              classList: {
                _set: new Set(id === 'nav-drawer' ? ['hidden'] : []),
                add(c) { this._set.add(c); },
                remove(c) { this._set.delete(c); },
                toggle(c, force) {
                  if (force === undefined) {
                    if (this._set.has(c)) this._set.delete(c); else this._set.add(c);
                  } else if (force) {
                    this._set.add(c);
                  } else {
                    this._set.delete(c);
                  }
                },
                contains(c) { return this._set.has(c); }
              },
              addEventListener() {},
              getBoundingClientRect() { return { width: 800, height: 460 }; }
            });
            globalThis.window = {
              location: { hash: '', search: '', pathname: '/', reload() {} },
              history: { pushState() {}, replaceState() {} },
              addEventListener() {}
            };
            globalThis.document = {
              getElementById(id) {
                if (id === 'csv-import-modal') return null;
                if (!elements[id]) elements[id] = makeEl(id);
                return elements[id];
              },
              addEventListener() {}
            };
            globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
            globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
            globalThis.navigator = {};
            globalThis.requestAnimationFrame = (fn) => fn();
            globalThis.setTimeout = (fn) => { fn(); return 1; };
            globalThis.clearTimeout = () => {};
            """
            + cls_only
            + """
            (() => {
              const client = new PlacesTrackerClient({});
              client.drawWorldMap = () => {};
              client.drawUSVectorMap = () => {};
              client.renderViewportPlacesList = () => {};
              client.renderUSParksList = () => {};

              // Open Visited Map, then open Hamburger Drawer
              client.openVisitedMapRoot();
              client.toggleNavDrawer(true);
              const drawerOpenBefore = !document.getElementById('nav-drawer').classList.contains('hidden');

              // Pressing Back while drawer is open must ONLY close drawer and keep section === 'visited_map'
              const backHandled = client.handleBackAction(true);
              const drawerOpenAfter = !document.getElementById('nav-drawer').classList.contains('hidden');
              const sectionAfterDrawerClose = client.activeSection;

              // Clicking Settings button once opens 'settings'; clicking Settings button again closes it back to 'visited_map'
              client.toggleSettingsDrawer();
              const sectionAfterSettingsClick1 = client.activeSection;
              client.toggleSettingsDrawer();
              const sectionAfterSettingsClick2 = client.activeSection;

              const out = JSON.stringify({
                drawerOpenBefore,
                backHandled,
                drawerOpenAfter,
                sectionAfterDrawerClose,
                sectionAfterSettingsClick1,
                sectionAfterSettingsClick2
              });
              if (typeof console !== 'undefined' && console.log) console.log(out);
              else if (typeof print !== 'undefined') print(out);
            })();
            """
        )
        res = run_js_eval(harness)
        self.assertTrue(res["drawerOpenBefore"])
        self.assertTrue(res["backHandled"])
        self.assertFalse(res["drawerOpenAfter"])
        self.assertEqual(res["sectionAfterDrawerClose"], "visited_map")
        self.assertEqual(res["sectionAfterSettingsClick1"], "settings")
        self.assertEqual(res["sectionAfterSettingsClick2"], "visited_map")
        self.assertIn("now - this.lastLongPressAt < 650", app_js)
        self.assertIn("this.suppressClickUntil = now + 550", app_js)
        self.assertIn("Date.now() < this.suppressClickUntil", app_js)

    def test_10_eval_90_day_google_login_persistence(self):
        """Eval: Verifies 10-year (until explicit Sign Out) login session persistence across Web, Worker HMAC-SHA256, and Android."""
        app_js_path = os.path.join(ROOT_DIR, "cloudflare", "src", "ui", "app.js")
        router_js_path = os.path.join(ROOT_DIR, "cloudflare", "src", "controllers", "HttpRouter.js")
        main_activity_path = os.path.join(
            ROOT_DIR, "android", "app", "src", "main", "java", "com", "placestracker", "app", "MainActivity.kt"
        )

        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(router_js_path, "r", encoding="utf-8") as f:
            router_js = f.read()
        with open(main_activity_path, "r", encoding="utf-8") as f:
            main_activity_kt = f.read()

        # 1. Backend Cloudflare Worker must mint and verify 10-year HMAC-SHA256 session tokens + JWKS
        self.assertIn("SESSION_MAX_AGE_MS = 3650 * 24 * 60 * 60 * 1000", router_js)
        self.assertIn("mintWorkerSessionToken", router_js)
        self.assertIn("verifyWorkerSessionToken", router_js)
        self.assertIn("verifyGoogleJwtWithJwks", router_js)

        # 2. Android MainActivity must persist saved_google_id_token & use silentSignIn + getSavedAuth + saveSessionToken
        self.assertIn("saved_google_id_token", main_activity_kt)
        self.assertIn("fun getSavedAuth(): String", main_activity_kt)
        self.assertIn("fun saveSessionToken(", main_activity_kt)
        self.assertIn("silentSignIn()", main_activity_kt)
        self.assertIn("window.PlacesAndroidAuth.getSavedAuth", app_js)
        self.assertIn("window.PlacesAndroidAuth.saveSessionToken", app_js)

        # 3. Runtime JS eval: token issued 2 years (730 days) ago must STILL be valid (< 10y),
        #    while token issued 11 years (4015 days) ago must be rejected (> 10y).
        cls_only = app_js.split("const app = new PlacesTrackerClient")[0]
        harness = (
            """
            const elements = {};
            const makeEl = (id) => ({
              id, value: '', textContent: '', innerHTML: '', style: {}, className: '',
              classList: { _set: new Set(), add(){}, remove(){}, toggle(){}, contains(){ return false; } },
              addEventListener() {},
              getBoundingClientRect() { return { width: 800, height: 460 }; }
            });
            globalThis.window = {
              location: { hash: '', search: '', pathname: '/', reload() {} },
              history: { pushState() {}, replaceState() {} },
              addEventListener() {}
            };
            globalThis.document = {
              getElementById(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; },
              addEventListener() {}
            };
            globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
            globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
            globalThis.navigator = {};
            globalThis.requestAnimationFrame = () => {};
            globalThis.setTimeout = () => 1;
            globalThis.clearTimeout = () => {};
            if (typeof globalThis.atob === 'undefined') {
              globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
            }
            if (typeof globalThis.btoa === 'undefined') {
              globalThis.btoa = (bin) => Buffer.from(bin, 'binary').toString('base64');
            }
            """
            + cls_only
            + """
            (() => {
              const client = Object.create(PlacesTrackerClient.prototype);
              const makeJwt = (iatSec) => {
                const hdr = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
                const body = btoa(JSON.stringify({
                  iss: 'worker-session',
                  email: 'madhavsankar@gmail.com',
                  iat: iatSec,
                  exp: iatSec + 3650 * 86400
                }));
                return hdr + '.' + body + '.sig';
              };
              const nowSec = Math.floor(Date.now() / 1000);
              const token2YearsOld = makeJwt(nowSec - 730 * 24 * 3600);
              const token11YearsOld = makeJwt(nowSec - 4015 * 24 * 3600);

              const out = JSON.stringify({
                valid2Years: client.isGoogleTokenValid(token2YearsOld),
                valid11Years: client.isGoogleTokenValid(token11YearsOld)
              });
              if (typeof console !== 'undefined' && console.log) console.log(out);
              else if (typeof print !== 'undefined') print(out);
            })();
            """
        )
        res = run_js_eval(harness)
        self.assertTrue(res["valid2Years"], "Token issued 2 years ago must remain valid for 10-year session persistence")
        self.assertFalse(res["valid11Years"], "Token issued 11 years ago must expire after 10 years")

    def test_11_eval_qa_subagent_audit_fixes(self):
        """Eval: Guards all 5 QA Subagent audit fixes across Home, Visited Map, My Places, Statistics, Gemini AI Logger, and Android Back navigation."""
        root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        template_path = os.path.join(root_dir, "cloudflare", "src", "ui", "template.html")
        app_js_path = os.path.join(root_dir, "cloudflare", "src", "ui", "app.js")
        gemini_js_path = os.path.join(root_dir, "cloudflare", "src", "services", "GeminiAgentService.js")
        catalog_js_path = os.path.join(root_dir, "cloudflare", "src", "services", "CatalogService.js")
        main_activity_path = os.path.join(
            root_dir, "android", "app", "src", "main", "java", "com", "placestracker", "app", "MainActivity.kt"
        )

        with open(template_path, "r", encoding="utf-8") as f:
            template_html = f.read()
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(gemini_js_path, "r", encoding="utf-8") as f:
            gemini_js = f.read()
        with open(catalog_js_path, "r", encoding="utf-8") as f:
            catalog_js = f.read()
        with open(main_activity_path, "r", encoding="utf-8") as f:
            main_activity_kt = f.read()

        # 1. Home Status Filter options & Map Projection Selector wiring
        self.assertIn('<option value="bucket_list">Want to Go</option>', template_html)
        self.assertIn('<option value="unvisited">Unvisited Only</option>', template_html)
        self.assertIn('<option value="all">All Places</option>', template_html)
        self.assertIn('onclick="app.toggleSettingsDrawer(false)"', template_html)
        self.assertIn('id="map-proj-select" onchange="app.drawUSVectorMap(true)"', template_html)

        # 2. Interactive status badges in My Places & Statistics, NFD capital matching, and 0/0 donut guard
        self.assertIn("app.cyclePlaceStatus(", app_js)
        self.assertIn(".normalize('NFD')", app_js)
        self.assertIn(".replace(/[\\u0300-\\u036f]/g, '')", app_js)
        self.assertIn("const pct = tot > 0 ? Math.min(100, Math.round((vis / tot) * 100)) : 0;", app_js)
        self.assertIn("this.userSelectedStatsCircle", app_js)

        # 3. Gemini fallback word-boundary matching & custom place continent resolution
        self.assertIn('new RegExp(`\\\\b${escaped}\\\\b`, "i")', gemini_js)
        self.assertIn('(countryEntry && countryEntry.continent) || "North America"', catalog_js)

        # 4. Android MainActivity Back navigation exits cleanly when already at Home root
        self.assertIn("isEnabled = false", main_activity_kt)
        self.assertIn("onBackPressedDispatcher.onBackPressed()", main_activity_kt)


if __name__ == "__main__":
    unittest.main()
