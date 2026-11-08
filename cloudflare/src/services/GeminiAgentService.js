/**
 * GeminiAgentService — Natural Language Travel Logging & Trip Recommendation Engine.
 * Static prompt instructions, JSON schema, and model cascade are loaded from
 * `data/catalog/gemini_prompt_schema.json`.
 */

import {
  GEMINI_API_ENDPOINT,
  GEMINI_API_REVISION,
  GEMINI_MODEL_CASCADE,
} from "../config/constants.js";
import { ALIASES, GEMINI_CONFIG } from "../data/CatalogData.js";

export class GeminiAgentService {
  static DEFAULT_MODEL_CASCADE =
    Array.isArray(GEMINI_MODEL_CASCADE) && GEMINI_MODEL_CASCADE.length > 0
      ? GEMINI_MODEL_CASCADE
      : [
          "gemini-flash-latest",
          "gemini-3.8-flash",
          "gemini-3.6-flash",
          "gemini-3.5-flash-lite",
          "gemini-3.1-flash-lite",
          "gemini-flash-lite-latest",
        ];

  static _cachedCascade = null;
  static _cachedCascadeAt = 0;
  static _lastWorkingModel = null;

  constructor(env, catalogService, storageRepo) {
    this.env = env || {};
    this.catalogService = catalogService;
    this.storageRepo = storageRepo;
  }

  /**
   * Multi-stage model classifier and scorer for `/v1beta/models` entries (ported from PackTrack):
   *  1. Rejects non-Gemini families (`gemma-*`, `lyria-*`, `imagen-*`, `veo-*`, `aqa`, `text-embedding-*`)
   *  2. Rejects non-text / specialized media models (`-image`, `nano-banana`, `omni`, `transcribe`, `tts`, `live`, `translate`, `robotics`, `computer-use`)
   *  3. Rejects legacy/deprecated `< 3.0` generations (`2.5`, `2.0`, `1.5`, `1.0`)
   *  4. Ranks by `(Tier Class → Release Stability → Major.Minor Version)`:
   *     - Tier 3 (Fast Structured Text Primary — Best Free Tier Quota): `flash` (non-lite)
   *     - Tier 2 (Fast Structured Text Secondary — Separate Free Tier Quota): `flash-lite`
   *     - Tier 1 (Heavy Reasoning Fallback): `pro`, `argon`, `ultra`
   */
  static scoreGeminiModelId(rawId, metadata = null) {
    const id = String(rawId || "").replace(/^models\//, "").trim().toLowerCase();
    if (!id.startsWith("gemini-")) return -1;

    // Stage 1: Exclude specialized media/audio/agent/embedding models
    if (
      /image|banana|omni|transcribe|tts|audio|video|music|lyria|veo|imagen|embedding|aqa|learnlm|robotics|computer-use|deep-research|antigravity|translate|thinking|live|vision|customtools/i.test(
        id
      )
    ) {
      return -1;
    }

    // Stage 2: Check metadata description/methods if full Model resource object was passed
    if (metadata && typeof metadata === "object") {
      if (
        Array.isArray(metadata.supportedGenerationMethods) &&
        !metadata.supportedGenerationMethods.includes("generateContent")
      ) {
        return -1;
      }
      const desc = String(metadata.description || "").toLowerCase();
      if (/shut down|deprecated|text-to-speech|speech-to-text|image generation|video generation/i.test(desc)) {
        return -1;
      }
      if (
        typeof metadata.outputTokenLimit === "number" &&
        metadata.outputTokenLimit > 0 &&
        metadata.outputTokenLimit < 2048
      ) {
        return -1;
      }
    }

    // Stage 3: Identify tier class (flash > flash-lite > pro/argon/ultra)
    let tierScore = 0;
    if (id.includes("flash-lite") || id.includes("lite")) {
      tierScore = 20_000;
    } else if (id.includes("flash")) {
      tierScore = 30_000;
    } else if (id.includes("pro") || id.includes("argon") || id.includes("ultra")) {
      tierScore = 10_000;
    } else {
      return -1;
    }

    // Stage 4: Parse version or rolling `-latest` alias; reject legacy `< 3.0` models
    let versionScore = 0;
    const verMatch = id.match(
      /^gemini-(\d+)(?:\.(\d+))?-(?:flash-lite|flash|pro|argon|ultra)(?:$|-[a-z0-9-]+$)/
    );
    if (verMatch) {
      const major = parseInt(verMatch[1], 10) || 0;
      const minor = parseInt(verMatch[2] ?? "0", 10) || 0;
      if (major < 3) return -1;
      versionScore = major * 100 + minor * 10;
    } else if (
      id === "gemini-flash-latest" ||
      id === "gemini-flash-lite-latest" ||
      id === "gemini-pro-latest"
    ) {
      versionScore = 375;
    } else {
      return -1;
    }

    // Stage 5: Stability weight (Stable GA > Rolling `-latest` > Pinned `-001` > `-preview` > `-exp`)
    let stabilityScore = 0;
    if (id.includes("exp") || id.includes("experimental")) {
      stabilityScore = 1000;
    } else if (id.includes("preview")) {
      stabilityScore = 2000;
    } else if (id.endsWith("-latest")) {
      stabilityScore = 4500;
    } else if (/^gemini-\d+(?:\.\d+)?-(?:flash-lite|flash|pro|argon|ultra)$/.test(id)) {
      stabilityScore = 5000;
    } else {
      stabilityScore = 4000;
    }

    return tierScore + stabilityScore + versionScore;
  }

  /**
   * Ranks a list of model metadata objects from `/v1beta/models` (or raw model ID strings)
   * from best/newest to fallback, and merges with `DEFAULT_MODEL_CASCADE` for resilience.
   */
  static rankModelsFromList(modelsList = []) {
    const scored = [];
    for (const entry of modelsList || []) {
      const rawName = typeof entry === "string" ? entry : entry?.name || entry?.baseModelId || "";
      const id = String(rawName).replace(/^models\//, "").trim();
      if (!id) continue;
      const metadata = typeof entry === "object" ? entry : null;
      const s = GeminiAgentService.scoreGeminiModelId(id, metadata);
      if (s > 0) {
        scored.push({ id, score: s });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    const cascade = [];
    const seen = new Set();
    const pushUnique = (modelId) => {
      const clean = String(modelId || "").replace(/^models\//, "").trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        cascade.push(clean);
      }
    };

    if (GeminiAgentService._lastWorkingModel) {
      pushUnique(GeminiAgentService._lastWorkingModel);
    }
    for (const item of scored) {
      pushUnique(item.id);
    }
    for (const fallbackId of GeminiAgentService.DEFAULT_MODEL_CASCADE) {
      pushUnique(fallbackId);
    }
    return cascade;
  }

  /**
   * Dynamically discovers available Gemini models from `/v1beta/models` (cached for 1 hour)
   * so newly released models (e.g. `gemini-4.3-flash`, `gemini-3.8-flash`) are automatically prioritized.
   */
  static async resolveModelCascade(geminiApiKey, fetchImpl = fetch) {
    const now = Date.now();
    if (
      GeminiAgentService._cachedCascade &&
      GeminiAgentService._cachedCascade.length > 0 &&
      now - GeminiAgentService._cachedCascadeAt < 3600_000
    ) {
      return GeminiAgentService.rankModelsFromList(GeminiAgentService._cachedCascade);
    }

    try {
      const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
        String(geminiApiKey).trim()
      )}`;
      const resp = await fetchImpl(listUrl, { method: "GET" });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data?.models) && data.models.length > 0) {
          const ranked = GeminiAgentService.rankModelsFromList(data.models);
          GeminiAgentService._cachedCascade = ranked;
          GeminiAgentService._cachedCascadeAt = now;
          return ranked;
        }
      }
    } catch (_) {
      // Ignore discovery failure and use default cascade
    }
    return GeminiAgentService.rankModelsFromList([]);
  }

  extractLocalFallback(promptText, catalog) {
    const visited = [];
    const bucket_list = [];
    const unvisited = [];
    const parentCats = new Set([
      "country",
      "territory",
      "us_state",
      "indian_state",
      "canadian_province",
    ]);
    const leafCatalog = catalog.filter((p) => !parentCats.has(p.category));
    const clauses = String(promptText).split(/[.;\n]+/);

    for (const rawClause of clauses) {
      const cl = rawClause.toLowerCase();
      if (!cl.trim()) continue;

      let target = visited;
      if (
        cl.includes("bucket") ||
        cl.includes("want to") ||
        cl.includes("plan to") ||
        cl.includes("wish")
      ) {
        target = bucket_list;
      } else if (
        cl.includes("remove") ||
        cl.includes("clear") ||
        cl.includes("unvisited") ||
        cl.includes("delete") ||
        cl.includes("haven't")
      ) {
        target = unvisited;
      }

      if (cl.includes("mighty 5")) {
        target.push(...(GEMINI_CONFIG.mighty_five_parks || []));
      }

      for (const [alias, id] of Object.entries(ALIASES)) {
        if (alias.length >= 3 && !id.startsWith("country:") && !id.startsWith("us_state:") && !id.startsWith("in_state:")) {
          const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (new RegExp(`\\b${escaped}\\b`, "i").test(cl)) {
            target.push(id);
          }
        }
      }

      for (const item of leafCatalog) {
        if (item.category === "airport" && item.iata_code) {
          const iataRegex = new RegExp(`\\b${item.iata_code}\\b`);
          if (iataRegex.test(rawClause)) {
            target.push(item.id);
            continue;
          }
        }
        const nm = item.name.toLowerCase();
        const baseNm = nm.replace(/,\s*[a-z]{2}$/i, "").trim();
        if (nm.length >= 3 && cl.includes(nm)) {
          target.push(item.id);
        } else if (baseNm.length >= 4 && new RegExp(`\\b${baseNm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cl)) {
          target.push(item.id);
        }
      }

      // Also check comma-separated tokens for direct resolution
      const tokens = rawClause
        .replace(/^(i\s+visited|visited|been\s+to|went\s+to|want\s+to\s+visit|add|mark)\s+/i, "")
        .split(/\s*(?:,|\band\b|&)\s*/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3);
      for (const tok of tokens) {
        const res = this.catalogService.resolvePlace(leafCatalog, tok);
        if (res && !parentCats.has(res.category)) {
          target.push(res.id);
        }
      }
    }

    return {
      visited: [...new Set(visited)],
      bucket_list: [...new Set(bucket_list)],
      unvisited: [...new Set(unvisited)],
    };
  }

  async processPrompt(prompt, options = {}) {
    const apiKey = this.env.GEMINI_API_KEY;
    const imageBase64 = options.image_base64 || "";
    const imageMimeType = options.image_mime_type || "image/jpeg";
    const effectivePrompt =
      prompt ||
      (imageBase64
        ? "Scan this flight ticket, boarding pass, or travel itinerary screenshot. Extract every departure, layover, and arrival 3-letter IATA airport code as visited (e.g. 'airport:SFO') and extract the destination cities, national parks, UNESCO sites, and landmarks."
        : "");

    const interactionInput = imageBase64
      ? [
          { type: "text", text: effectivePrompt },
          { type: "image", data: imageBase64, mime_type: imageMimeType },
        ]
      : effectivePrompt;

    let parsed = null;
    let modelUsed = null;
    let lastErrorStatus = null;

    if (apiKey) {
      const cleanKey = String(apiKey).trim();
      const cascade = await GeminiAgentService.resolveModelCascade(cleanKey);
      const userParts = imageBase64
        ? [
            { text: effectivePrompt },
            { inlineData: { mimeType: imageMimeType, data: imageBase64 } },
          ]
        : [{ text: effectivePrompt }];

      for (const modelName of cascade) {
        try {
          // 1. Try standard generateContent endpoint (universal across all /v1beta/models entries)
          const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            modelName
          )}:generateContent?key=${encodeURIComponent(cleanKey)}`;
          const genRes = await fetch(genUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: GEMINI_CONFIG.system_instruction }],
              },
              contents: [{ role: "user", parts: userParts }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: GEMINI_CONFIG.generation_schema,
              },
            }),
          });

          if (genRes.ok) {
            const genData = await genRes.json();
            const textOut =
              genData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (textOut.trim()) {
              parsed = JSON.parse(textOut);
              modelUsed = modelName;
              GeminiAgentService._lastWorkingModel = modelName;
              break;
            }
          } else {
            lastErrorStatus = genRes.status;
          }

          // 2. Fallback to /v1beta/interactions for models supporting the Interactions API
          const res = await fetch(GEMINI_API_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": cleanKey,
              "Api-Revision": GEMINI_API_REVISION,
            },
            body: JSON.stringify({
              model: modelName,
              system_instruction: GEMINI_CONFIG.system_instruction,
              input: interactionInput,
              generation_config: {
                temperature: 0.1,
                response_mime_type: "application/json",
                response_schema: GEMINI_CONFIG.generation_schema,
              },
            }),
          });

          if (res.ok) {
            const data = await res.json();
            const textOut =
              (data.outputs || []).find((o) => o.type === "text")?.text || "{}";
            parsed = JSON.parse(textOut);
            modelUsed = modelName;
            GeminiAgentService._lastWorkingModel = modelName;
            break;
          }
          lastErrorStatus = res.status;
        } catch (_) {
          // Continue to next fallback model in cascade
        }
      }
    }

    if (!parsed) {
      const userState = await this.storageRepo.loadUserState();
      const catalog = this.catalogService.getMergedCatalog(userState);
      const fb = this.extractLocalFallback(prompt, catalog);
      if (fb.visited.length || fb.bucket_list.length || fb.unvisited.length) {
        parsed = {
          ...fb,
          reply: apiKey
            ? "Processed your places list and updated your travel map!"
            : "Processed your places list using the built-in PlacesTracker catalog & geocoder!",
        };
      } else if (!apiKey) {
        return {
          error:
            "Could not match places locally and GEMINI_API_KEY is not set. Add your free key from aistudio.google.com/apikey in Cloudflare Worker Settings -> Variables and Secrets.",
        };
      } else {
        return {
          error: `Gemini API is temporarily experiencing high demand (HTTP ${
            lastErrorStatus || 503
          }). Please try again in a few seconds!`,
        };
      }
    }

    const allMatched = [];
    const summaryAuto = [];
    const summaryUnresolved = [];
    let latestActivityLog = [];

    if (Array.isArray(parsed.visited) && parsed.visited.length > 0) {
      const r = await this.catalogService.markPlaces({
        places: parsed.visited,
        status: "visited",
      });
      allMatched.push(...r.updated);
      summaryAuto.push(...r.auto_propagated);
      summaryUnresolved.push(...(r.unresolved || []));
      if (r.activity_log) latestActivityLog = r.activity_log;
    }
    if (Array.isArray(parsed.bucket_list) && parsed.bucket_list.length > 0) {
      const r = await this.catalogService.markPlaces({
        places: parsed.bucket_list,
        status: "bucket_list",
      });
      allMatched.push(...r.updated);
      summaryUnresolved.push(...(r.unresolved || []));
      if (r.activity_log) latestActivityLog = r.activity_log;
    }
    if (Array.isArray(parsed.unvisited) && parsed.unvisited.length > 0) {
      const r = await this.catalogService.markPlaces({
        places: parsed.unvisited,
        status: "unvisited",
      });
      allMatched.push(...r.updated);
      if (r.activity_log) latestActivityLog = r.activity_log;
    }

    const seenIds = new Set();
    const summaryUpdated = [];
    let alreadyMarkedCount = 0;
    for (const item of allMatched) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      if (item.changed === false) {
        alreadyMarkedCount++;
      } else {
        summaryUpdated.push(item);
      }
    }

    const replyText = parsed.reply || "Updated your map!";

    return {
      reply: replyText,
      model_used: modelUsed || "local-fallback",
      updated: summaryUpdated,
      already_marked_count: alreadyMarkedCount,
      auto_propagated: summaryAuto,
      unresolved: summaryUnresolved,
      activity_log: latestActivityLog,
    };
  }
}
