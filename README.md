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
- **✨ Gemini AI Travel Logger:** Dedicated **Gemini AI Logger** view in the navigation menu to log trips in plain English and extract & mark cities, National Parks, UNESCO sites, World Wonders, and airports in bulk with 1-tap **✕ Remove / ↩️ Restore** undo controls and smart suffix/landmark resolution (e.g., *"Space Needle Visitor Centre"* → `Space Needle`).
- **Interactive Vector Maps & 3D Globe:** Switch between **World Map**, **Visited Regional Map** (with long-press country/state drill-down), **3D Interactive Globe**, and **My Places** category checklists.
- **CSV Import & Export:** 1-click CSV backup (`Append` or `Override` mode) and native compatibility with *Places Been* exports (`lat;lon;country;city;been`).

---

## App Screens & Usage Pattern (Critical User Journey)

<p align="center">
  <img src="assets/app_screens.svg" width="100%" alt="PlacesTracker App Screens — Home Map, Regional Drill-Down & Statistics, and Gemini AI Travel Logger" />
</p>

### 1. App Usage Pattern (CUJ Flow)

```mermaid
flowchart LR
    classDef userNode fill:#065f46,stroke:#10b981,stroke-width:2px,color:#ecfdf5,font-weight:bold
    classDef authNode fill:#1e1b4b,stroke:#818cf8,stroke-width:2px,color:#e0e7ff,font-weight:bold
    classDef screenNode fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f0f9ff
    classDef aiNode fill:#3b0764,stroke:#c084fc,stroke-width:2px,color:#faf5ff,font-weight:bold
    classDef logicNode fill:#451a03,stroke:#f59e0b,stroke-width:2px,color:#fef3c7
    classDef dbNode fill:#083344,stroke:#22d3ee,stroke-width:2.5px,color:#ecfeff,font-weight:bold

    Start(["👤 Open Web or Android App"]):::userNode --> Auth{{"🔐 Google Sign-In Gate\n(OAuth JWT + Allowlist)"}}:::authNode
    Auth -->|"Verified Email"| Home(["🗺️ Home Map & Viewport List\n(Cities · UNESCO & Sights · Airports)"]):::screenNode

    Home -->|"Tap BEEN / WANT\nin Map Viewport"| Propagate{"⚡ Auto-Derive Parents\n(Country & State/Province)"}:::logicNode
    Home -->|"Open ✨ Gemini AI Logger\nin Hamburger Menu"| GeminiCard[["✨ Gemini AI Travel Logger\n(Plain-English Bulk Logging)"]]:::aiNode
    Home -->|"Open ⇅ Import / Export\nPlaces Been CSV"| CsvIO[/"📄 CSV Sync\n(Append or Override)"/]:::screenNode

    GeminiCard -->|"Extract Leaf Places\n+ 1-Tap Undo/Remove"| Propagate
    CsvIO --> Propagate

    Propagate -->|"Skip Parent Country\nfor Airport Layovers"| Firestore[("🗄️ Cloud Firestore DB\n(user_state_{userId})")]:::dbNode
    Firestore --> Views(["🌍 Visited Map · 3D Globe ·\nDonut Stats & Geo Extremes"]):::userNode
```

---

## High-Level Design (Website & App Major APIs)

```mermaid
flowchart TB
    classDef client fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#ecfdf5,font-weight:bold
    classDef gate fill:#311042,stroke:#e879f9,stroke-width:2px,color:#fdf4ff,font-weight:bold
    classDef api fill:#0c4a6e,stroke:#38bdf8,stroke-width:2px,color:#f0f9ff
    classDef ext fill:#3b0764,stroke:#a855f7,stroke-width:2px,color:#f3e8ff,font-weight:bold
    classDef db fill:#164e63,stroke:#06b6d4,stroke-width:2.5px,color:#ecfeff,font-weight:bold

    subgraph Touchpoints["📱 Client Touchpoints"]
        WebPWA(["🌐 Web PWA\n(D3 Vector Maps & 3D Globe)"]):::client
        Android(["🤖 Android App\n(WebView + Share Target)"]):::client
        McpClient(["🔌 MCP Agent\n(Claude / Gemini CLI)"]):::client
    end

    AuthGate{{"🔐 Google OAuth JWT Verifier\n(oauth2.googleapis.com/tokeninfo + ALLOWED_EMAILS)"}}:::gate

    subgraph WorkerAPIs["⚡ Cloudflare Worker Major APIs"]
        StateAPI["GET /api/state\n(Load Merged Catalog & Stats)"]:::api
        MarkAPI["POST /api/mark\n(Toggle Leaf Place + Derive Parents)"]:::api
        GeminiAPI["POST /api/gemini\n(Natural-Language Place Extraction)"]:::api
        CsvAPI["GET /api/export.csv\nPOST /api/import.csv"]:::api
        McpAPI["POST /mcp\n(JSON-RPC 2.0 Tools)"]:::api
    end

    GeminiCascade[["🤖 Google Gemini API Cascade\n(/v1beta/models -> gemini-3.8-flash -> fallback)"]]:::ext

    subgraph Storage["🗄️ Persistence & Catalog Layer"]
        CatalogDB[("📚 Static Place Catalog\n(2,398+ Places & 48k Cities)")]:::db
        FirestoreDB[("🔥 Firebase Cloud Firestore\n(places_tracker/user_state_{userId})")]:::db
        LocalCache[("💾 Browser & Android\nLocal Backup Cache")]:::db
    end

    WebPWA & Android <-->|"Save / Restore Offline"| LocalCache
    WebPWA & Android -->|"Bearer <Google_ID_Token>"| AuthGate
    McpClient -->|"Bearer <Google_ID_Token>"| AuthGate

    AuthGate --> StateAPI & MarkAPI & GeminiAPI & CsvAPI & McpAPI

    GeminiAPI -->|"Structured Extraction"| GeminiCascade
    GeminiCascade -->|"Resolved Places"| MarkAPI
    McpAPI --> MarkAPI & StateAPI

    StateAPI & MarkAPI & CsvAPI <-->|"Match & Auto-Propagate"| CatalogDB
    StateAPI & MarkAPI & CsvAPI <-->|"REST GET / PATCH"| FirestoreDB
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
