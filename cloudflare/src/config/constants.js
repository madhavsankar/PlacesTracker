/**
 * Global Configuration & Utility Classes for PlacesTracker Cloudflare Worker.
 * Static values are loaded from `data/catalog/app_metadata.json` and `gemini_prompt_schema.json`.
 */

import { APP_METADATA, GEMINI_CONFIG } from "../data/CatalogData.js";

export const KV_KEY = APP_METADATA.kv_key;
export const DEFAULT_FIREBASE_PROJECT_ID = APP_METADATA.default_firebase_project_id;

export const GEMINI_API_ENDPOINT = GEMINI_CONFIG.api_endpoint;
export const GEMINI_API_REVISION = GEMINI_CONFIG.api_revision;
export const GEMINI_MODEL_CASCADE = GEMINI_CONFIG.model_cascade;

export const CONTINENT_NAMES = APP_METADATA.continents;
export const PLACE_CATEGORIES = APP_METADATA.categories;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Accept, X-User-Id",
};

export class FlagFormatter {
  static UNICODE_OFFSET = 127397;
  static DEFAULT_EMOJI = "🌍";

  static fromIso2(iso2) {
    if (!iso2 || iso2.length !== 2) return FlagFormatter.DEFAULT_EMOJI;
    const u = iso2.toUpperCase();
    return String.fromCodePoint(
      u.charCodeAt(0) + FlagFormatter.UNICODE_OFFSET,
      u.charCodeAt(1) + FlagFormatter.UNICODE_OFFSET
    );
  }
}

export function isoToFlag(iso2) {
  return FlagFormatter.fromIso2(iso2);
}
