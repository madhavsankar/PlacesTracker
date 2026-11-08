/**
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
