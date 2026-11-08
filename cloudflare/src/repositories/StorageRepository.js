/**
 * StorageRepository — Multi-Tenant NoSQL Document Persistence Layer.
 * Primary store: Firebase Cloud Firestore (configured via `FIREBASE_PROJECT_ID` env var)
 *   - Default state document: `places_tracker/user_state`
 *   - Per-user state document: `places_tracker/user_state_{userId}`
 *   - Per-place NoSQL collection: `user_places/{docId}` (or `user_places/{userId}__{docId}`)
 * Secondary fallback: Cloudflare Workers KV (`PLACES_KV`) and in-memory state.
 */

import { DEFAULT_FIREBASE_PROJECT_ID, KV_KEY } from "../config/constants.js";

const MEMORY_FALLBACK_BY_USER = {};

export class StorageRepository {
  constructor(env, userId = "default") {
    this.env = env || {};
    this.firebaseProjectId = this.env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID;
    this.setUserId(userId);
  }

  setUserId(rawUserId) {
    const cleaned = String(rawUserId || "")
      .trim()
      .toLowerCase()
      .replace(/@[a-z0-9.-]+\.[a-z]{2,}$/i, "")
      .replace(/^([a-z0-9._-]+)_[a-z0-9-]+\.[a-z]{2,}$/i, "$1")
      .replace(/[^a-z0-9_.-]/g, "_")
      .slice(0, 64);
    this.userId = cleaned && cleaned !== "default" ? cleaned : "default";
  }

  getStateDocName() {
    return this.userId === "default" ? "user_state" : `user_state_${this.userId}`;
  }

  getKvKey() {
    return this.userId === "default" ? KV_KEY : `${KV_KEY}:${this.userId}`;
  }

  getFirestoreBaseUrl() {
    return `https://firestore.googleapis.com/v1/projects/${this.firebaseProjectId}/databases/(default)/documents`;
  }

  async loadUserState() {
    const stateDoc = this.getStateDocName();
    // 1. Firebase Cloud Firestore (Primary NoSQL Document DB)
    if (this.firebaseProjectId) {
      try {
        const url = `${this.getFirestoreBaseUrl()}/places_tracker/${stateDoc}`;
        const res = await fetch(url);
        if (res.ok) {
          const doc = await res.json();
          const jsonStr = doc.fields?.payload?.stringValue;
          if (jsonStr) {
            const parsed = JSON.parse(jsonStr);
            return {
              places: parsed.places || {},
              custom_catalog: parsed.custom_catalog || [],
              activity_log: parsed.activity_log || [],
            };
          }
        } else if (res.status === 404 && this.userId !== "default") {
          return { places: {}, custom_catalog: [], activity_log: [] };
        }
      } catch (_) {
        // Fall through to KV or memory fallback
      }
    }

    // 2. Cloudflare Workers KV (Optional secondary store)
    if (this.env.PLACES_KV) {
      const raw = await this.env.PLACES_KV.get(this.getKvKey(), "json");
      if (raw && typeof raw === "object") {
        return {
          places: raw.places || {},
          custom_catalog: raw.custom_catalog || [],
          activity_log: raw.activity_log || [],
        };
      }
    }

    return MEMORY_FALLBACK_BY_USER[this.userId] || { places: {}, custom_catalog: [], activity_log: [] };
  }

  async saveUserState(state, changedItems = []) {
    MEMORY_FALLBACK_BY_USER[this.userId] = state;
    const stateDoc = this.getStateDocName();

    if (this.firebaseProjectId) {
      try {
        const now = new Date().toISOString();
        const baseUrl = this.getFirestoreBaseUrl();
        const writes = [
          fetch(`${baseUrl}/places_tracker/${stateDoc}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fields: {
                userId: { stringValue: this.userId },
                payload: { stringValue: JSON.stringify(state) },
                trackedCount: { integerValue: String(Object.keys(state.places || {}).length) },
                updatedAt: { stringValue: now },
              },
            }),
          }),
        ];

        // Sync individual NoSQL documents inside `user_places/{docId}`
        for (const item of changedItems) {
          const baseDocId = String(item.id).replace(/[^a-zA-Z0-9_-]/g, "_");
          const docId = this.userId === "default" ? baseDocId : `${this.userId}__${baseDocId}`;
          const docUrl = `${baseUrl}/user_places/${docId}`;
          if (item.status === "unvisited") {
            writes.push(fetch(docUrl, { method: "DELETE" }));
          } else {
            writes.push(
              fetch(docUrl, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  fields: {
                    user_id: { stringValue: this.userId },
                    place_id: { stringValue: item.id },
                    name: { stringValue: item.name || "" },
                    category: { stringValue: item.category || "" },
                    flag_emoji: { stringValue: item.flag_emoji || "🌍" },
                    status: { stringValue: item.status || "visited" },
                    is_favorite: { booleanValue: Boolean(item.is_favorite) },
                    updated_at: { stringValue: now },
                  },
                }),
              })
            );
          }
        }

        await Promise.allSettled(writes);
      } catch (_) {
        // Ignore network errors and persist to fallback
      }
    }

    if (this.env.PLACES_KV) {
      await this.env.PLACES_KV.put(this.getKvKey(), JSON.stringify(state));
    }
  }
}

