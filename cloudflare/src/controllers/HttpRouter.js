/**
 * HttpRouter — Central HTTP Controller for the PlacesTracker Cloudflare Worker.
 * Routes Web UI (`/`), PWA Manifest (`/manifest.json`), REST API (`/api/*`), and MCP (`/mcp`).
 */

import { CORS_HEADERS } from "../config/constants.js";
import { PWA_MANIFEST, US_STATE_GRID } from "../data/CatalogData.js";
import { McpRouter } from "../mcp/McpRouter.js";
import { StorageRepository } from "../repositories/StorageRepository.js";
import { CatalogService } from "../services/CatalogService.js";
import { GeminiAgentService } from "../services/GeminiAgentService.js";
import { renderWebAppHtml } from "../ui/WebAppView.js";

const VERIFIED_GOOGLE_TOKENS = new Map();
const SESSION_MAX_AGE_MS = 3650 * 24 * 60 * 60 * 1000; // 10 years (3,650 days — until explicit Sign Out)
let GOOGLE_JWKS_CACHE = { keys: null, fetchedAt: 0 };

function encodeBase64UrlBytes(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    bin += String.fromCharCode(arr[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeBase64UrlJson(obj) {
  return encodeBase64UrlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function decodeBase64UrlBytes(b64url) {
  const b64 = String(b64url || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function decodeBase64UrlJson(b64url) {
  const bytes = decodeBase64UrlBytes(b64url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function getHmacCryptoKey(secret, usage) {
  const keyBytes = new TextEncoder().encode(String(secret || "places-tracker-session-v1"));
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage
  );
}

export async function mintWorkerSessionToken(email, secret) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + 3650 * 24 * 60 * 60; // 10 years
  const headerB64 = encodeBase64UrlJson({ alg: "HS256", typ: "JWT" });
  const payloadB64 = encodeBase64UrlJson({
    iss: "worker-session",
    email: cleanEmail,
    email_verified: true,
    iat: nowSec,
    exp: expSec,
  });
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await getHmacCryptoKey(secret, ["sign"]);
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${encodeBase64UrlBytes(sigBuf)}`;
}

export async function verifyWorkerSessionToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = decodeBase64UrlJson(parts[0]);
    payload = decodeBase64UrlJson(parts[1]);
  } catch (_) {
    return null;
  }
  if (!header || header.alg !== "HS256" || !payload || payload.iss !== "worker-session") {
    return null;
  }
  if (!payload.email) return null;
  const iatSec = Number(payload.iat || 0);
  const expMs = iatSec > 0 ? iatSec * 1000 + SESSION_MAX_AGE_MS : Number(payload.exp || 0) * 1000;
  if (expMs > 0 && expMs <= Date.now()) {
    return { error: "Session expired. Please sign in again." };
  }
  const key = await getHmacCryptoKey(secret, ["verify"]);
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sigBytes = decodeBase64UrlBytes(parts[2]);
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, signedData);
  if (!valid) return null;
  return {
    email: String(payload.email).trim().toLowerCase(),
    expMs: expMs || Date.now() + SESSION_MAX_AGE_MS,
  };
}

async function verifyGoogleJwtWithJwks(token, expectedAud) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const header = decodeBase64UrlJson(parts[0]);
  const payload = decodeBase64UrlJson(parts[1]);
  if (!header || header.alg !== "RS256" || !header.kid || !payload) return null;

  const iss = String(payload.iss || "");
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    return null;
  }
  if (expectedAud && payload.aud !== expectedAud) {
    return { error: "Invalid Google OAuth client audience." };
  }
  if (!payload.email || String(payload.email_verified) !== "true") {
    return { error: "Google account email is not verified." };
  }

  const iatSec = Number(payload.iat || payload.exp || 0);
  const sessionExpMs = iatSec > 0 ? iatSec * 1000 + SESSION_MAX_AGE_MS : Date.now() + SESSION_MAX_AGE_MS;
  if (sessionExpMs <= Date.now()) {
    return { error: "Google session expired. Please sign in again." };
  }

  const now = Date.now();
  if (!GOOGLE_JWKS_CACHE.keys || now - GOOGLE_JWKS_CACHE.fetchedAt > 6 * 3600 * 1000) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.keys)) {
        GOOGLE_JWKS_CACHE = { keys: data.keys, fetchedAt: now };
      }
    }
  }
  const jwk = (GOOGLE_JWKS_CACHE.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sigBytes = decodeBase64UrlBytes(parts[2]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sigBytes, signedData);
  if (!valid) return null;

  return {
    email: String(payload.email).trim().toLowerCase(),
    expMs: sessionExpMs,
  };
}

export class HttpRouter {
  constructor(env) {
    this.env = env || {};
    this.storageRepo = new StorageRepository(this.env);
    this.catalogService = new CatalogService(this.storageRepo);
    this.geminiService = new GeminiAgentService(
      this.env,
      this.catalogService,
      this.storageRepo
    );
    this.mcpRouter = new McpRouter(this.catalogService, this.storageRepo);
  }

  _getGoogleClientId() {
    return String(this.env.GOOGLE_CLIENT_ID || "").trim();
  }

  _getSessionSecret() {
    return (
      String(this.env.SESSION_SECRET || "").trim() ||
      String(this.env.FIREBASE_API_KEY || "").trim() ||
      String(this.env.GEMINI_API_KEY || "").trim() ||
      String(this.env.GOOGLE_CLIENT_ID || "").trim() ||
      "places-tracker-session-v1"
    );
  }

  _isEmailAllowed(email) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) return false;
    const allowedRaw = String(this.env.ALLOWED_EMAILS || "").trim();
    if (!allowedRaw) return false;
    const allowedSet = new Set(
      allowedRaw
        .split(",")
        .flatMap((entry) => {
          const clean = entry.trim().toLowerCase();
          if (!clean) return [];
          const usernamePart = clean.split("@")[0].replace(/[^a-z0-9_.-]/g, "_");
          return [clean, clean.split("@")[0], usernamePart];
        })
    );
    return allowedSet.has(cleanEmail) || allowedSet.has(cleanEmail.split("@")[0]);
  }

  async _verifyGoogleRequest(request, url) {
    const cfAccessEmail = (
      request.headers.get("Cf-Access-Authenticated-User-Email") || ""
    )
      .trim()
      .toLowerCase();
    if (cfAccessEmail && this._isEmailAllowed(cfAccessEmail)) {
      return { ok: true, email: cfAccessEmail };
    }

    const authHeader = request.headers.get("Authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const token =
      bearerToken ||
      (request.headers.get("X-Google-Id-Token") || "").trim() ||
      (url.searchParams.get("id_token") || "").trim();

    if (!token) {
      return {
        ok: false,
        status: 401,
        error: "Please sign in with your Google account.",
      };
    }

    let verifiedEmail = "";
    let isWorkerSession = false;
    const sessionSecret = this._getSessionSecret();
    const cached = VERIFIED_GOOGLE_TOKENS.get(token);
    if (cached && cached.expMs > Date.now()) {
      verifiedEmail = cached.email;
      isWorkerSession = Boolean(cached.isWorkerSession);
    } else {
      try {
        // 0. Check 10-year Worker-signed HMAC-SHA256 session token first (unaffected by Google JWKS rotation)
        const workerRes = await verifyWorkerSessionToken(token, sessionSecret);
        if (workerRes && workerRes.error) {
          return { ok: false, status: 401, error: workerRes.error };
        }
        if (workerRes && workerRes.email) {
          verifiedEmail = workerRes.email;
          isWorkerSession = true;
          VERIFIED_GOOGLE_TOKENS.set(token, {
            email: verifiedEmail,
            expMs: workerRes.expMs,
            isWorkerSession: true,
          });
        }
      } catch (_) {}

      const expectedAud = this._getGoogleClientId();
      if (!verifiedEmail) {
        try {
          // 1. Cryptographically verify Google RS256 JWT against Google JWKS
          const jwksResult = await verifyGoogleJwtWithJwks(token, expectedAud);
          if (jwksResult && jwksResult.error) {
            return { ok: false, status: 401, error: jwksResult.error };
          }
          if (jwksResult && jwksResult.email) {
            verifiedEmail = jwksResult.email;
            VERIFIED_GOOGLE_TOKENS.set(token, {
              email: verifiedEmail,
              expMs: jwksResult.expMs,
            });
          }
        } catch (_) {}
      }

      // 2. Fallback to oauth2.googleapis.com/tokeninfo if JWKS key rolled or wasn't matched
      if (!verifiedEmail) {
        try {
          const res = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
          );
          if (!res.ok) {
            return {
              ok: false,
              status: 401,
              error: "Google session expired or invalid. Please sign in again.",
            };
          }
          const info = await res.json();
          if (expectedAud && info.aud !== expectedAud) {
            return {
              ok: false,
              status: 401,
              error: "Invalid Google OAuth client audience.",
            };
          }
          if (String(info.email_verified) !== "true" || !info.email) {
            return {
              ok: false,
              status: 401,
              error: "Google account email is not verified.",
            };
          }
          const iatMs = Number(info.iat || info.exp || 0) * 1000;
          const sessionExpMs = iatMs > 0 ? iatMs + SESSION_MAX_AGE_MS : Date.now() + SESSION_MAX_AGE_MS;
          verifiedEmail = String(info.email).trim().toLowerCase();
          VERIFIED_GOOGLE_TOKENS.set(token, { email: verifiedEmail, expMs: sessionExpMs });
        } catch (_) {
          return {
            ok: false,
            status: 401,
            error: "Unable to verify Google token.",
          };
        }
      }
    }

    if (!this._isEmailAllowed(verifiedEmail)) {
      return {
        ok: false,
        status: 403,
        error: `Access denied for ${verifiedEmail}. Only allowlisted Google accounts are permitted.`,
      };
    }

    try {
      this.activeSessionToken = isWorkerSession
        ? token
        : await mintWorkerSessionToken(verifiedEmail, sessionSecret);
    } catch (_) {
      this.activeSessionToken = token;
    }

    return { ok: true, email: verifiedEmail, sessionToken: this.activeSessionToken };
  }

  async handle(request) {
    const url = new URL(request.url);
    const originUrl = `${url.protocol}//${url.host}`;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/auth-config") {
      return this._jsonResponse({
        googleClientId: this._getGoogleClientId(),
      });
    }

    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
      const auth = await this._verifyGoogleRequest(request, url);
      if (!auth.ok) {
        return this._jsonResponse(
          { error: auth.error, authRequired: true },
          auth.status || 401
        );
      }
      this.storageRepo.setUserId(auth.email);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(renderWebAppHtml(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          ...CORS_HEADERS,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/manifest.json") {
      return this._jsonResponse(PWA_MANIFEST);
    }

    if (request.method === "POST" && url.pathname === "/api/gemini") {
      const body = await request.json();
      const res = await this.geminiService.processPrompt(body.prompt || "", body);
      return this._jsonResponse(res);
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      const userState = await this.storageRepo.loadUserState();
      const places = this.catalogService.getMergedCatalog(userState);
      const stats = this.catalogService.computeStats(places);
      const cf = request.cf || {};
      const client_geo = {
        city: cf.city || "",
        region: cf.region || "",
        region_code: cf.regionCode || "",
        country_code: cf.country || "",
        lat: cf.latitude ? parseFloat(cf.latitude) : null,
        lng: cf.longitude ? parseFloat(cf.longitude) : null,
      };
      return this._jsonResponse({
        user_id: this.storageRepo.userId,
        session_token: this.activeSessionToken || "",
        places,
        stats,
        us_grid: US_STATE_GRID,
        client_geo,
        activity_log: userState.activity_log || [],
      });
    }

    if (request.method === "POST" && url.pathname === "/api/mark") {
      const body = await request.json();
      const res = await this.catalogService.markPlaces(body);
      return this._jsonResponse(res);
    }

    if (request.method === "POST" && url.pathname === "/api/custom") {
      const body = await request.json();
      const res = await this.catalogService.addCustomPlace(body);
      return this._jsonResponse(res);
    }

    if (request.method === "GET" && url.pathname === "/api/export.csv") {
      const userState = await this.storageRepo.loadUserState();
      const catalog = this.catalogService.getMergedCatalog(userState);
      const csvString = this.catalogService.exportCsv(catalog);
      return new Response(csvString, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=places_tracker_export.csv",
          ...CORS_HEADERS,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/import.csv") {
      try {
        const csvText = await request.text();
        const mode =
          url.searchParams.get("mode") || request.headers.get("X-Import-Mode") || "append";
        const res = await this.catalogService.importCsv(csvText, mode);
        return this._jsonResponse(res);
      } catch (err) {
        return this._jsonResponse(
          { error: err && err.message ? err.message : "CSV import failed on server" },
          500
        );
      }
    }

    if (url.pathname === "/mcp") {
      return this.mcpRouter.handleRequest(request, originUrl);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }

  _jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
}
