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
- **Smart Parent Auto-Propagation:** Marking any city, National Park, UNESCO site, or World Wonder as `visited` automatically marks its parent **Country** and **State/Province**.
- **✨ Tell Gemini (Text, Voice & Ticket Vision):** Log trips in plain English, dictate via microphone, or upload a boarding pass screenshot / `.ics` calendar file.
- **Interactive Vector Maps:** Switch between **Scratch Map** and **Flag Map** across World, US 50-States, and category checklists.
- **Multi-Tenant User Isolation:** Each browser/device generates its own isolated Sync ID (`X-User-Id`), keeping every user's travel database separate.
- **CSV Import & Export:** 1-click CSV backup and native import for both standard CSVs and *Places Been* exports (`lat;lon;country;city;been`).

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

1. Set your `FIREBASE_PROJECT_ID` secret/variable and `GEMINI_API_KEY`:
   ```bash
   npx wrangler secret put FIREBASE_PROJECT_ID
   npx wrangler secret put GEMINI_API_KEY
   ```
2. Build and deploy:
   ```bash
   python3 scripts/build_worker.py
   npx wrangler deploy
   ```

### 3. Android App (Optional)

Set `<string name="web_app_url">` in `android/app/src/main/res/values/strings.xml` to your deployed URL and build via `./gradlew assembleDebug` (or use `.github/workflows/android-apk.yml`).

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
