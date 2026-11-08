# 🌍 PlacesTracker

<p align="left">
  <img src="assets/app_icon.svg" width="96" height="96" alt="PlacesTracker App Icon" />
</p>

An open-source, AI-powered travel tracker and interactive **Scratch & Flag Map** backed by **Google Gemini** (`v1beta/interactions`), **Firebase Cloud Firestore**, **Cloudflare Workers**, and a **Model Context Protocol (MCP) Server**.

---

## Features

- **2,398+ Pre-Seeded Places (+ Live Town Geocoding):**
  - **195** Countries + **20** Territories & Dependencies
  - **51** US States + D.C., **36** Indian States & UTs, **13** Canadian Provinces & Territories
  - **252** Commercial & Regional Airports (logging airport layovers does **not** auto-mark the parent country/state)
  - **168** National Parks, National Monuments & Wildlife Sanctuaries (all 63 US National Parks, 41 US National Monuments/Seashores, 44 Indian National Parks/Sanctuaries, plus global parks)
  - **139** UNESCO World Heritage Sites (100% of India's 43 & USA's 26 UNESCO sites + global icons)
  - **15** World Wonders
  - **1,524** US, Indian & International Cities, Suburbs & Landmarks + automatic live geocoding for 30,000+ towns worldwide
- **Derived Parent Region Auto-Propagation:** Parent **Countries** and **States/Provinces** are strictly derived from leaf places — marking any city, National Park, UNESCO site, or World Wonder as `visited` or `bucket_list` automatically updates its parent Country and State/Province.
- **✨ Gemini AI Travel Logger (Home & CSV Import Page):** Log trips in plain English, dictate via microphone, or use the **Gemini AI Travel Logger** card on the Import/Export CSV page to extract and mark places in bulk with 1-tap **✕ Remove / ↩️ Restore** undo controls and smart suffix/landmark resolution (e.g., *"Space Needle Visitor Centre"* → `Space Needle`).
- **Self-Discovering Gemini Model Cascade:** Dynamically discovers live models via `GET /v1beta/models` (cached 1h), filters out non-text modalities, and ranks general text models (`gemini-flash-latest` → `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-4-argon`) with automatic failover to the local catalog NLP parser.
- **Interactive Vector Maps & 3D Globe:** Switch between **World Map**, **Visited Regional Map** (with long-press country/state drill-down), **3D Interactive Globe**, and **My Places** category checklists.
- **Google Sign-In & Email Allowlist Security:** Built-in Google OAuth Sign-In (`GOOGLE_CLIENT_ID`) with server-side JWT verification (`oauth2.googleapis.com/tokeninfo`) and `ALLOWED_EMAILS` allowlist enforcement across `/api/*` and `/mcp`.
- **CSV Import & Export:** 1-click CSV backup (`Append` or `Override` mode) and native compatibility with *Places Been* exports (`lat;lon;country;city;been`).

---

## High-Level Design (HLD) & Architecture

### 1. System Architecture

```mermaid
flowchart TB
    subgraph Clients["User Touchpoints and Clients"]
        PWA["Web and Mobile PWA (D3 Vector Scratch and Flag Map)"]
        AndroidApp["Native Android App (WebView, Share Target, Offline Cache)"]
        ExternalMCP["External MCP Clients (Gemini CLI, Claude, IDE Agents)"]
    end

    subgraph Edge["Cloudflare Worker Edge Runtime (cloudflare/worker.js)"]
        Router["HttpRouter (cloudflare/src/controllers/HttpRouter.js)"]
        WebView["WebAppView + PlacesTrackerClient (cloudflare/src/ui/)"]
        GeminiSvc["GeminiAgentService (cloudflare/src/services/GeminiAgentService.js)"]
        McpSrv["McpRouter JSON-RPC 2.0 (cloudflare/src/mcp/McpRouter.js)"]
        CatSvc["CatalogService (cloudflare/src/services/CatalogService.js)"]
        StoreRepo["StorageRepository (cloudflare/src/repositories/StorageRepository.js)"]
        StaticData["Modular JSON Catalog 2,398+ Places (data/catalog/*.json)"]
    end

    subgraph AI["Google Gemini Interactions API (v1beta/interactions)"]
        G1["Stage 1: gemini-3.8-flash"]
        G2["Stage 2: gemini-3.5-flash-lite"]
        G3["Stage 3: gemini-3.1-flash-lite"]
        G4["Stage 4: Local Catalog and Alias NLP Parser"]
        G1 -->|"HTTP 503 Failover"| G2
        G2 -->|"HTTP 503 Failover"| G3
        G3 -->|"HTTP 503 Failover"| G4
    end

    subgraph Database["Firebase Cloud Firestore NoSQL DB"]
        DocState["Document: places_tracker/user_state_{userId} (Per-User Snapshot)"]
        ColPlaces["Collection: user_places/{userId}__{docId} (Per-Place Documents)"]
    end

    PWA -->|"GET / , GET /api/state , POST /api/mark , POST /api/gemini"| Router
    AndroidApp -->|"ACTION_SEND (?text=...) + Offline Cache"| Router
    ExternalMCP -->|"POST /mcp (JSON-RPC 2.0)"| Router

    Router --> WebView
    Router -->|"/api/gemini , /api/gemini-vision"| GeminiSvc
    Router -->|"/mcp"| McpSrv
    Router -->|"/api/state , /api/mark , /api/export.csv , /api/import.csv"| CatSvc

    GeminiSvc -->|"Structured JSON Extraction"| G1
    GeminiSvc -->|"markPlaces()"| CatSvc
    McpSrv -->|"tools/list and tools/call"| CatSvc

    CatSvc -->|"Read Catalog and Aliases"| StaticData
    CatSvc -->|"loadUserState() / saveUserState()"| StoreRepo
    StoreRepo <-->|"REST PATCH / GET"| DocState
    StoreRepo <-->|"REST PATCH"| ColPlaces
```

### 2. End-to-End Request & Smart Auto-Propagation Sequence

```mermaid
sequenceDiagram
    actor User
    participant UI as PlacesTrackerClient (Web / Android)
    participant Router as HttpRouter
    participant Gemini as GeminiAgentService
    participant Catalog as CatalogService
    participant DB as StorageRepository (Firestore)

    User->>UI: "Visited Kyoto, Zion National Park, and flew through DOH"
    UI->>Router: POST /api/gemini (X-User-Id: user_xxxx)
    Router->>Gemini: processPrompt(text)
    Gemini->>Gemini: Call v1beta/interactions (gemini-3.8-flash)
    Gemini-->>Catalog: markPlaces(["Kyoto", "Zion National Park", "DOH"], status="visited")
    Catalog->>Catalog: Resolve places + strip diacritics + geocode if new town
    Catalog->>Catalog: Auto-propagate parents: Japan (JP), Utah (UT), United States (US)
    Catalog->>Catalog: Skip parent country auto-propagation for airport layover (DOH)
    Catalog->>DB: saveUserState(userState, updated + autoPropagated)
    DB-->>Catalog: Persist to Firestore (user_state_{userId})
    Catalog-->>Router: Return { updated, auto_propagated, reply }
    Router-->>UI: JSON response
    UI->>UI: Re-render World Scratch/Flag Map, 50-States Map & KPI Counters
```

---

## Quick Start

### 1. Local CLI & Web Dashboard (SQLite)

```bash
# View travel stats
python3 src/cli.py stats

# Mark places visited (auto-marks parent country & state)
python3 src/cli.py mark "Kyoto" "Zion National Park" "Mahabalipuram" --status visited

# Launch local web map
python3 src/cli.py serve --port 8765
```

### 2. Deploy Your Own Cloudflare Worker (Optional)

1. Configure your secrets/variables in Cloudflare Worker Settings (or via Wrangler CLI):
   ```bash
   npx wrangler secret put FIREBASE_PROJECT_ID
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put ALLOWED_EMAILS
   ```
   *(Note: `keep_vars = true` is enabled in [`wrangler.toml`](wrangler.toml) so Git deployments never overwrite variables or secrets set in your Cloudflare Dashboard).*
2. Build and deploy:
   ```bash
   python3 scripts/build_worker.py
   npx wrangler deploy
   ```

### 3. Android App & Password-Protected Signed APK (`android/`)

Set `PLACES_TRACKER_URL` in git-ignored `android/local.properties` (or as a GitHub Actions secret) and build via `./gradlew assembleDebug`. Every push to `main` automatically builds a release-signed APK (`1.0.<run_number>`) using `ANDROID_KEYSTORE_BASE64` and `KEYSTORE_PASSWORD`, locks the APK inside a password-protected archive (`PlacesTracker-Protected.zip`), and optionally delivers updates via **Firebase App Distribution** (`.github/workflows/android-apk.yml`).

---

## Project Structure

```text
PlacesTracker/
├── data/catalog/          # Modular static JSON datasets (2,398+ places & schemas)
├── src/                   # Python SQLite engine, CLI & stdio MCP server
├── cloudflare/            # Cloudflare Worker (ES modules + D3 vector web app)
├── android/               # Native Android WebView & Share-from-Gemini wrapper
└── scripts/               # Worker build script (build_worker.py)
```

---

## License

MIT
