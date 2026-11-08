/**
 * CatalogService — Core Business Logic for Place Resolution, Auto-Propagation,
 * Statistics Computation, Recommendations, and CSV Export.
 */

import { CONTINENT_NAMES, PLACE_CATEGORIES, isoToFlag } from "../config/constants.js";
import { ALIASES, BASE_CATALOG } from "../data/CatalogData.js";

const PARENT_CATEGORIES = new Set([
  "country",
  "territory",
  "us_state",
  "indian_state",
  "canadian_province",
]);

function stripAccents(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export class CatalogService {
  constructor(storageRepo) {
    this.storageRepo = storageRepo;
  }

  getMergedCatalog(userState) {
    const tracked = { ...(userState.places || {}) };
    const baseIds = new Set(BASE_CATALOG.map((b) => b.id));
    for (const k of Object.keys(tracked)) {
      if (k.startsWith("city:") && !baseIds.has(k)) {
        const wonderId = "wonder:" + k.slice(5);
        if (baseIds.has(wonderId) && !tracked[wonderId]) {
          tracked[wonderId] = tracked[k];
        }
      }
    }
    const baseByNormKey = new Map();
    for (const b of BASE_CATALOG) {
      const key = `${stripAccents(b.name)}|${(b.country_code || "").toUpperCase()}`;
      if (!baseByNormKey.has(key)) baseByNormKey.set(key, b.id);
    }

    const extraCustom = [];
    for (const c of userState.custom_catalog || []) {
      if (!c || !c.id) continue;
      if (baseIds.has(c.id)) continue;
      const normKey = `${stripAccents(c.name)}|${(c.country_code || "").toUpperCase()}`;
      const matchedBaseId = baseByNormKey.get(normKey);
      if (matchedBaseId) {
        if (tracked[c.id] && !tracked[matchedBaseId]) {
          tracked[matchedBaseId] = tracked[c.id];
        }
        continue;
      }
      extraCustom.push(c);
    }

    const all = [...BASE_CATALOG, ...extraCustom];
    const merged = all.map((item) => {
      const u = tracked[item.id] || {};
      return {
        ...item,
        status: u.status || "unvisited",
        is_favorite: u.is_favorite ? 1 : 0,
        visit_date: u.visit_date || "",
        rating: u.rating || 0,
        trip_name: u.trip_name || "",
        notes: u.notes || "",
        updated_at: u.updated_at || "",
      };
    });

    // Auto-derive Country and State/Province statuses strictly from leaf places
    // (city, national_park, unesco, world_wonder)
    this._recomputeMergedParents(merged);

    return merged;
  }

  _recomputeMergedParents(merged) {
    const visitedCountries = new Set();
    const bucketCountries = new Set();
    const visitedStates = new Set();
    const bucketStates = new Set();

    for (const p of merged) {
      if (PARENT_CATEGORIES.has(p.category) || p.category === "airport") continue;
      if (p.status === "visited") {
        if (p.country_code) visitedCountries.add(p.country_code);
        if (p.state_code) visitedStates.add(p.state_code);
      } else if (p.status === "bucket_list") {
        if (p.country_code) bucketCountries.add(p.country_code);
        if (p.state_code) bucketStates.add(p.state_code);
      }
    }

    for (const p of merged) {
      if (p.category === "country" || p.category === "territory") {
        if (visitedCountries.has(p.country_code)) p.status = "visited";
        else if (bucketCountries.has(p.country_code)) p.status = "bucket_list";
        else p.status = "unvisited";
      } else if (
        p.category === "us_state" ||
        p.category === "indian_state" ||
        p.category === "canadian_province"
      ) {
        if (visitedStates.has(p.state_code)) p.status = "visited";
        else if (bucketStates.has(p.state_code)) p.status = "bucket_list";
        else p.status = "unvisited";
      }
    }
  }

  _syncDerivedParentsToUserState(userState, catalog, now, changedList = []) {
    this._recomputeMergedParents(catalog);
    for (const p of catalog) {
      if (!PARENT_CATEGORIES.has(p.category)) continue;
      const prevStatus = (userState.places[p.id] && userState.places[p.id].status) || "unvisited";
      if (p.status === "unvisited") {
        if (userState.places[p.id]) {
          delete userState.places[p.id];
          changedList.push({
            id: p.id,
            name: p.name,
            category: p.category,
            flag_emoji: p.flag_emoji,
            status: "unvisited",
          });
        }
      } else if (prevStatus !== p.status) {
        userState.places[p.id] = {
          status: p.status,
          is_favorite: Boolean(userState.places[p.id] && userState.places[p.id].is_favorite),
          visit_date: "",
          rating: 0,
          trip_name: "",
          notes: "Auto-derived from places",
          updated_at: now,
        };
        changedList.push({
          id: p.id,
          name: p.name,
          category: p.category,
          flag_emoji: p.flag_emoji,
          status: p.status,
        });
      }
    }
  }

  resolvePlace(catalog, query, categoryHint) {
    if (!query) return null;
    const q = String(query).trim();
    if (!q) return null;
    const ql = q.toLowerCase();

    // 1. Exact ID
    let found = catalog.find((p) => p.id.toLowerCase() === ql);
    if (found) return found;

    const qNorm = stripAccents(q);

    // 2. Alias lookup (exact or diacritic-stripped)
    if (!categoryHint && (ALIASES[ql] || ALIASES[qNorm])) {
      const targetId = ALIASES[ql] || ALIASES[qNorm];
      found = catalog.find((p) => p.id === targetId);
      if (found) return found;
    }

    // 3. Exact name match (or diacritic-stripped / airport post-dash name match)
    if (categoryHint) {
      found = catalog.find(
        (p) =>
          p.category === categoryHint &&
          (p.name.toLowerCase() === ql || stripAccents(p.name) === qNorm)
      );
      if (found) return found;
    }
    // Prefer leaf places (city, national_park, unesco, world_wonder, airport) when a city-state
    // shares a name with a country/state (e.g. Singapore, Monaco, Luxembourg, New York)
    found =
      catalog.find(
        (p) =>
          !PARENT_CATEGORIES.has(p.category) &&
          (p.name.toLowerCase() === ql ||
            stripAccents(p.name) === qNorm ||
            (p.category === "airport" &&
              p.name.includes(" — ") &&
              stripAccents(p.name.split(" — ")[1]) === qNorm))
      ) ||
      catalog.find(
        (p) =>
          p.name.toLowerCase() === ql ||
          stripAccents(p.name) === qNorm
      );
    if (found) return found;

    if (q.includes(",")) {
      const parts = q.split(",").map((s) => s.trim());
      const cityLower = (parts[0] || "").toLowerCase();
      const regLower = (parts[1] || "").toLowerCase();
      if (cityLower && regLower) {
        const regState = catalog.find(
          (p) =>
            (p.category === "us_state" ||
              p.category === "indian_state" ||
              p.category === "canadian_province") &&
            (p.name.toLowerCase() === regLower ||
              (p.state_code || "").toLowerCase() === regLower ||
              (p.state_code || "").toLowerCase() === `in-${regLower}` ||
              (p.state_code || "").toLowerCase() === `ca-${regLower}`)
        );
        const regCountry = catalog.find(
          (p) =>
            p.category === "country" &&
            (p.name.toLowerCase() === regLower || (p.country_code || "").toLowerCase() === regLower)
        );
        found = catalog.find((p) => {
          if (p.category !== "city") return false;
          const pNameLower = p.name.toLowerCase();
          const nameMatches =
            pNameLower === ql ||
            pNameLower === cityLower ||
            pNameLower.startsWith(cityLower + ",");
          if (!nameMatches) return false;
          if (regState) return p.state_code === regState.state_code;
          if (regCountry) return p.country_code === regCountry.country_code;
          return (p.subregion || "").toLowerCase() === regLower;
        });
        if (found) return found;
        // Return null so markPlaces can dynamically geocode this exact "City, State"
        return null;
      }
    }

    // 4. 2-letter ISO or US State code
    if (q.length === 2) {
      const qu = q.toUpperCase();
      if (categoryHint === "us_state") {
        found = catalog.find((p) => p.category === "us_state" && p.state_code === qu);
        if (found) return found;
      }
      found = catalog.find(
        (p) => (p.category === "country" || p.category === "territory") && p.country_code === qu
      );
      if (found) return found;
      found = catalog.find((p) => p.category === "us_state" && p.state_code === qu);
      if (found) return found;
    }

    // 5. 3-letter IATA airport code (e.g. SFO, JFK, LHR, DEL, BLR)
    if (q.length === 3) {
      const qu = q.toUpperCase();
      found = catalog.find(
        (p) => p.category === "airport" && (p.iata_code === qu || p.id === `airport:${qu}`)
      );
      if (found) return found;
    }

    // 6. Substring match (shortest name first, diacritic-insensitive)
    const candidates = catalog
      .filter(
        (p) =>
          (!categoryHint || p.category === categoryHint) &&
          (p.name.toLowerCase().includes(ql) || stripAccents(p.name).includes(qNorm))
      )
      .sort((a, b) => a.name.length - b.name.length);
    if (candidates.length > 0) return candidates[0];

    // 7. Suffix / noise stripping & reverse substring match (query contains catalog name, longest match first)
    const qCleaned = ql
      .replace(/^the\s+/i, "")
      .replace(/\s+\b(?:in|near|at)\s+[a-z\s,.]+$/i, "")
      .replace(
        /\s*\b(?:visitor\s+cent(?:er|re)|visitors?\s+cent(?:er|re)|welcome\s+cent(?:er|re)|observation\s+deck|observatory|viewpoint|overlook|lookout|historic(?:al)?\s+(?:site|park|monument)|national\s+(?:park|monument|memorial|historic\s+site)|state\s+park|world\s+heritage\s+site|unesco\s+site|international\s+airport|airport)\b\s*/gi,
        " "
      )
      .replace(/\s+/g, " ")
      .trim();
    const qCleanNorm = stripAccents(qCleaned);

    if (qCleaned.length >= 3 && qCleaned !== ql) {
      if (!categoryHint && (ALIASES[qCleaned] || ALIASES[qCleanNorm])) {
        const targetId = ALIASES[qCleaned] || ALIASES[qCleanNorm];
        found = catalog.find((p) => p.id === targetId);
        if (found) return found;
      }
      found = catalog.find(
        (p) =>
          !PARENT_CATEGORIES.has(p.category) &&
          (!categoryHint || p.category === categoryHint) &&
          (p.name.toLowerCase() === qCleaned ||
            stripAccents(p.name) === qCleanNorm ||
            p.name.toLowerCase().replace(/,\s*[a-z]{2}$/i, "") === qCleaned)
      );
      if (found) return found;

      const cleanSub = catalog
        .filter(
          (p) =>
            !PARENT_CATEGORIES.has(p.category) &&
            (!categoryHint || p.category === categoryHint) &&
            (p.name.toLowerCase().includes(qCleaned) || stripAccents(p.name).includes(qCleanNorm))
        )
        .sort((a, b) => a.name.length - b.name.length);
      if (cleanSub.length > 0) return cleanSub[0];
    }

    // Reverse containment: check if query contains a known landmark/park/UNESCO/airport/city name
    // (picking the longest matching catalog name, preferring landmarks/parks/UNESCO over generic city names)
    const revMatches = [];
    for (const p of catalog) {
      if (PARENT_CATEGORIES.has(p.category)) continue;
      if (categoryHint && p.category !== categoryHint) continue;
      const pLower = p.name.toLowerCase();
      const pNorm = stripAccents(p.name);
      const baseLower =
        p.category === "city" ? pLower.replace(/,\s*[a-z]{2}$/i, "").trim() : pLower;
      const baseNorm =
        p.category === "city" ? pNorm.replace(/,\s*[a-z]{2}$/i, "").trim() : pNorm;

      let matchedLen = 0;
      if (pLower.length >= 4 && (ql.includes(pLower) || qNorm.includes(pNorm))) {
        const esc = pNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${esc}\\b`, "i").test(qNorm)) {
          matchedLen = pLower.length;
        }
      }
      if (
        !matchedLen &&
        baseLower.length >= 4 &&
        (ql.includes(baseLower) || qNorm.includes(baseNorm))
      ) {
        const esc = baseNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${esc}\\b`, "i").test(qNorm)) {
          matchedLen = baseLower.length;
        }
      }
      if (matchedLen > 0) {
        const isSpecificSight = p.category !== "city" ? 1 : 0;
        revMatches.push({ item: p, matchedLen, isSpecificSight });
      }
    }
    if (revMatches.length > 0) {
      revMatches.sort(
        (a, b) => b.isSpecificSight - a.isSpecificSight || b.matchedLen - a.matchedLen
      );
      return revMatches[0].item;
    }

    return null;
  }

  async markPlaces(args) {
    const userState = await this.storageRepo.loadUserState();
    const catalog = this.getMergedCatalog(userState);
    const status = args.status || "visited";
    const now = new Date().toISOString();
    const updated = [];
    const autoPropagated = [];
    const unresolved = [];

    for (const rawItem of args.places || []) {
      let resolved = this.resolvePlace(catalog, rawItem, args.category_hint);
      if (!resolved && args.place_meta && args.place_meta.id === rawItem) {
        const meta = {
          id: args.place_meta.id,
          name: args.place_meta.name,
          category: args.place_meta.category || "city",
          country_code: args.place_meta.country_code || "",
          state_code: args.place_meta.state_code || "",
          continent: args.place_meta.continent || "",
          subregion: args.place_meta.subregion || "",
          lat: Number(args.place_meta.lat || 0),
          lng: Number(args.place_meta.lng || 0),
          flag_emoji: args.place_meta.flag_emoji || isoToFlag(args.place_meta.country_code || ""),
          description: args.place_meta.description || "",
        };
        userState.custom_catalog = (userState.custom_catalog || []).filter((x) => x.id !== meta.id);
        userState.custom_catalog.push(meta);
        catalog.push(meta);
        resolved = meta;
      }
      if (!resolved && status !== "unvisited") {
        resolved = await this._geocodeAndCreateCity(rawItem, userState, catalog);
      }
      if (!resolved) {
        unresolved.push(rawItem);
        continue;
      }
      const pid = resolved.id;
      // Do not allow direct manual marking of parent regions (country/state/province);
      // their statuses are automatically derived from leaf places (city, park, UNESCO, wonder)
      if (PARENT_CATEGORIES.has(resolved.category)) {
        continue;
      }
      const prev = userState.places[pid] || {};
      const prevStatus = prev.status || "unvisited";
      const fav =
        typeof args.is_favorite === "boolean" ? args.is_favorite : Boolean(prev.is_favorite);
      if (status === "unvisited" && !fav) {
        delete userState.places[pid];
        resolved.status = "unvisited";
        resolved.is_favorite = 0;
        if (prevStatus !== "unvisited") {
          this._recordActivity(userState, resolved, prevStatus, "unvisited", now);
        }
        updated.push({
          id: pid,
          name: resolved.name,
          category: resolved.category,
          flag_emoji: resolved.flag_emoji,
          status: "unvisited",
          prev_status: prevStatus,
          changed: prevStatus !== "unvisited",
          is_favorite: false,
        });
        continue;
      }

      userState.places[pid] = {
        status,
        is_favorite: fav,
        visit_date: args.visit_date || prev.visit_date || "",
        rating: args.rating || prev.rating || 0,
        trip_name: args.trip_name || prev.trip_name || "",
        notes: args.notes || prev.notes || "",
        updated_at: now,
      };
      resolved.status = status;
      resolved.is_favorite = fav ? 1 : 0;
      if (prevStatus !== status) {
        this._recordActivity(userState, resolved, prevStatus, status, now);
      }
      updated.push({
        id: pid,
        name: resolved.name,
        category: resolved.category,
        flag_emoji: resolved.flag_emoji,
        status,
        prev_status: prevStatus,
        changed: prevStatus !== status,
        is_favorite: fav,
      });
    }

    this._syncDerivedParentsToUserState(userState, catalog, now, autoPropagated);
    await this.storageRepo.saveUserState(
      userState,
      [...updated.filter((u) => u.changed !== false), ...autoPropagated]
    );
    return {
      updated,
      auto_propagated: autoPropagated,
      unresolved,
      activity_log: userState.activity_log || [],
    };
  }

  _recordActivity(userState, item, prevStatus, nextStatus, now) {
    if (!item || prevStatus === nextStatus) return;
    let actionLabel = "Updated";
    if (prevStatus === "unvisited" && nextStatus === "visited") {
      actionLabel = "Added as Been";
    } else if (prevStatus === "unvisited" && nextStatus === "bucket_list") {
      actionLabel = "Added as Want";
    } else if (prevStatus === "bucket_list" && nextStatus === "visited") {
      actionLabel = "Converted from Want to Been";
    } else if (prevStatus === "visited" && nextStatus === "bucket_list") {
      actionLabel = "Converted from Been to Want";
    } else if (prevStatus === "visited" && nextStatus === "unvisited") {
      actionLabel = "Removed from Been";
    } else if (prevStatus === "bucket_list" && nextStatus === "unvisited") {
      actionLabel = "Removed from Want";
    }

    const log = Array.isArray(userState.activity_log) ? userState.activity_log : [];
    log.unshift({
      id: item.id,
      name: item.name,
      category: item.category,
      flag_emoji: item.flag_emoji || "📍",
      prev_status: prevStatus,
      next_status: nextStatus,
      action_label: actionLabel,
      timestamp: now,
    });
    userState.activity_log = log.slice(0, 25);
  }

  async _geocodeAndCreateCity(rawQuery, userState, catalog) {
    try {
      const q = String(rawQuery || "").trim();
      if (q.length < 2) return null;
      const parts = q.split(",").map((s) => s.trim());
      const citySearch = parts[0];
      const regHint = (parts[1] || "").toLowerCase();

      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        citySearch
      )}&count=10&language=en&format=json`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) return null;

      let chosen = results[0];
      if (regHint) {
        const regState = catalog.find(
          (p) =>
            (p.category === "us_state" ||
              p.category === "indian_state" ||
              p.category === "canadian_province") &&
            (p.name.toLowerCase() === regHint ||
              (p.state_code || "").toLowerCase() === regHint ||
              (p.state_code || "").toLowerCase() === `in-${regHint}` ||
              (p.state_code || "").toLowerCase() === `ca-${regHint}`)
        );
        const match = results.find((r) => {
          const admin1 = (r.admin1 || "").toLowerCase();
          const cc = (r.country_code || "").toLowerCase();
          const cName = (r.country || "").toLowerCase();
          if (regState) {
            return (
              admin1 === regState.name.toLowerCase() &&
              cc === regState.country_code.toLowerCase()
            );
          }
          return admin1 === regHint || cc === regHint || cName === regHint;
        });
        if (match) chosen = match;
      }

      const cc = String(chosen.country_code || "US").toUpperCase();
      const admin1 = String(chosen.admin1 || "").trim();
      let stateCode = "";
      if (admin1) {
        const stObj = catalog.find(
          (p) =>
            p.country_code === cc &&
            (p.category === "us_state" ||
              p.category === "indian_state" ||
              p.category === "canadian_province") &&
            p.name.toLowerCase() === admin1.toLowerCase()
        );
        if (stObj) stateCode = stObj.state_code;
      }

      const slug = `${chosen.name}_${stateCode || cc}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      const pid = `city:${slug}`;
      const displayName =
        cc === "US" && stateCode ? `${chosen.name}, ${stateCode}` : chosen.name;
      const countryEntry = catalog.find((p) => p.id === `country:${cc}`);

      const customItem = {
        id: pid,
        name: displayName,
        category: "city",
        country_code: cc,
        state_code: stateCode,
        continent: countryEntry ? countryEntry.continent : "North America",
        subregion: admin1 || cc,
        lat: Number(chosen.latitude || 0),
        lng: Number(chosen.longitude || 0),
        flag_emoji: isoToFlag(cc),
        description: `City in ${admin1 ? admin1 + ", " : ""}${cc}`,
      };

      userState.custom_catalog = (userState.custom_catalog || []).filter((x) => x.id !== pid);
      userState.custom_catalog.push(customItem);
      catalog.push(customItem);
      return customItem;
    } catch (_) {
      return null;
    }
  }

  _autoPropagateParentCountry(userState, catalog, resolved, args, now, autoPropagated) {
    const cc = resolved.country_code;
    if (!cc || resolved.category === "country" || resolved.category === "territory") return;
    const parentCountryId = `country:${cc}`;
    const pEntry = userState.places[parentCountryId];
    if (pEntry && pEntry.status === "visited") return;

    const pInfo = catalog.find((x) => x.id === parentCountryId);
    if (!pInfo) return;

    userState.places[parentCountryId] = {
      status: "visited",
      is_favorite: pEntry ? Boolean(pEntry.is_favorite) : false,
      visit_date: args.visit_date || "",
      rating: 0,
      trip_name: args.trip_name || "",
      notes: `Auto-logged via ${resolved.name}`,
      updated_at: now,
    };
    autoPropagated.push({
      id: parentCountryId,
      name: pInfo.name,
      category: pInfo.category,
      flag_emoji: pInfo.flag_emoji,
      status: "visited",
      reason: `Visited ${resolved.name}`,
    });
  }

  _autoPropagateParentSubdivision(userState, catalog, resolved, args, now, autoPropagated) {
    const cc = resolved.country_code;
    const sc = resolved.state_code || "";
    let parentStateId = null;

    if (cc === "US" && sc.length === 2 && resolved.category !== "us_state") {
      parentStateId = `us_state:${sc}`;
    } else if (cc === "IN" && sc.startsWith("IN-") && resolved.category !== "indian_state") {
      parentStateId = `in_state:${sc.slice(3)}`;
    } else if (cc === "CA" && sc.startsWith("CA-") && resolved.category !== "canadian_province") {
      parentStateId = `ca_province:${sc.slice(3)}`;
    }
    if (!parentStateId) return;

    const sEntry = userState.places[parentStateId];
    if (sEntry && sEntry.status === "visited") return;

    const sInfo = catalog.find((x) => x.id === parentStateId);
    if (!sInfo) return;

    userState.places[parentStateId] = {
      status: "visited",
      is_favorite: sEntry ? Boolean(sEntry.is_favorite) : false,
      visit_date: args.visit_date || "",
      rating: 0,
      trip_name: args.trip_name || "",
      notes: `Auto-logged via ${resolved.name}`,
      updated_at: now,
    };
    autoPropagated.push({
      id: parentStateId,
      name: sInfo.name,
      category: sInfo.category,
      flag_emoji: sInfo.flag_emoji,
      status: "visited",
      reason: `Visited ${resolved.name}`,
    });
  }

  async addCustomPlace(args) {
    const userState = await this.storageRepo.loadUserState();
    const slug = String(args.name || "custom")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    const cc = String(args.country_code || "").toUpperCase();
    const pid = `custom:${args.category || "city"}:${slug}`;
    const customItem = {
      id: pid,
      name: args.name,
      category: args.category || "city",
      country_code: cc,
      state_code: String(args.state_code || "").toUpperCase(),
      continent: "Custom",
      subregion: "Custom Place",
      lat: Number(args.lat || 0),
      lng: Number(args.lng || 0),
      flag_emoji: isoToFlag(cc),
      description: args.description || `Custom ${args.category || "city"}`,
    };
    userState.custom_catalog = (userState.custom_catalog || []).filter((x) => x.id !== pid);
    userState.custom_catalog.push(customItem);
    await this.storageRepo.saveUserState(userState, [customItem]);

    return this.markPlaces({
      places: [pid],
      status: args.status || "visited",
      notes: args.notes || "",
    });
  }

  computeStats(catalog) {
    const summary = {};
    for (const cat of PLACE_CATEGORIES) {
      const items = catalog.filter((p) => p.category === cat);
      const vis = items.filter((p) => p.status === "visited").length;
      const buck = items.filter((p) => p.status === "bucket_list").length;
      const fav = items.filter((p) => p.is_favorite).length;
      summary[cat] = {
        total: items.length,
        visited: vis,
        bucket_list: buck,
        favorites: fav,
        percent: items.length ? Math.round((vis / items.length) * 1000) / 10 : 0,
      };
    }

    const usNp = catalog.filter(
      (p) =>
        p.category === "national_park" &&
        p.country_code === "US" &&
        /\bNational (and State )?Parks?\b/i.test(p.name)
    );
    const usNpVis = usNp.filter((p) => p.status === "visited").length;
    summary.us_national_parks = {
      total: usNp.length,
      visited: usNpVis,
      bucket_list: usNp.filter((p) => p.status === "bucket_list").length,
      percent: usNp.length ? Math.round((usNpVis / usNp.length) * 1000) / 10 : 0,
    };

    const continents = CONTINENT_NAMES.map((cName) => {
      const cItems = catalog.filter((p) => p.category === "country" && p.continent === cName);
      const vis = cItems.filter((p) => p.status === "visited").length;
      return {
        continent: cName,
        visited: vis,
        total: cItems.length,
        percent: cItems.length ? Math.round((vis / cItems.length) * 1000) / 10 : 0,
      };
    });

    const visitedCountries = catalog
      .filter((p) => p.category === "country" && p.status === "visited")
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      summary,
      continents_touched: continents.filter((c) => c.visited > 0).length,
      total_continents: continents.length,
      continents,
      flag_belt: visitedCountries.map((c) => c.flag_emoji).join(" ") || "None yet",
      visited_countries: visitedCountries.map((c) => ({
        id: c.id,
        name: c.name,
        flag_emoji: c.flag_emoji,
        continent: c.continent,
      })),
      tracked_places: catalog.filter((p) => p.status !== "unvisited" || p.is_favorite),
    };
  }

  searchPlaces(catalog, args = {}) {
    const q = (args.query || "").toLowerCase().trim();
    return catalog
      .filter((p) => {
        if (args.category && p.category !== args.category) return false;
        if (args.status && p.status !== args.status) return false;
        if (args.country_code && p.country_code !== args.country_code.toUpperCase()) return false;
        if (args.continent && p.continent.toLowerCase() !== args.continent.toLowerCase())
          return false;
        if (args.favorites_only && !p.is_favorite) return false;
        if (
          q &&
          !(
            p.name.toLowerCase().includes(q) ||
            (p.description || "").toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q)
          )
        )
          return false;
        return true;
      })
      .slice(0, args.limit || 50);
  }

  recommendPlaces(catalog, destination) {
    const dest = (destination || "").trim();
    const resolved = this.resolvePlace(catalog, dest);
    let matches = [];
    if (resolved && resolved.category === "country") {
      matches = catalog.filter(
        (p) => p.country_code === resolved.country_code && p.category !== "country"
      );
    } else if (resolved && resolved.category === "us_state") {
      matches = catalog.filter(
        (p) => p.state_code === resolved.state_code && p.category !== "us_state"
      );
    } else {
      matches = catalog.filter(
        (p) => p.continent.toLowerCase() === dest.toLowerCase() && p.category !== "country"
      );
    }
    return {
      destination: resolved ? resolved.name : dest,
      unvisited_recommendations: matches.filter((p) => p.status !== "visited"),
      already_visited: matches.filter((p) => p.status === "visited"),
    };
  }

  exportCsv(catalog) {
    // Export in Places Been compatible semicolon-delimited format: lat;lon;country;city;been
    const tracked = catalog.filter(
      (p) =>
        !PARENT_CATEGORIES.has(p.category) &&
        (p.status === "visited" || p.status === "bucket_list")
    );
    const rows = ["lat;lon;country;city;been"];
    for (const p of tracked) {
      const lat = Number.isFinite(p.lat) ? p.lat : 0;
      const lon = Number.isFinite(p.lng) ? p.lng : 0;
      const cc = String(p.country_code || "").toLowerCase();
      let cleanName = String(p.name || "").trim();
      if (p.category === "airport") {
        cleanName = cleanName
          .replace(/^[A-Z0-9]{3}\s*[—–-]\s*/, "")
          .replace(/\bIntl\b/g, "International Airport");
      } else if (p.category === "city" && cleanName !== "Washington, D.C.") {
        cleanName = cleanName.replace(/,\s*[A-Z]{2}$/, "");
      }
      const beenVal = p.status === "visited" ? "been" : "want";
      const escapedName = cleanName.replace(/"/g, '""');
      rows.push(`${lat};${lon};"${cc}";"${escapedName}";"${beenVal}"`);
    }
    return rows.join("\n");
  }

  _buildCsvIndex(catalog) {
    const byId = new Map();
    const byNormName = new Map();
    const stateItemsByCountry = { US: [], IN: [], CA: [] };
    const customIdMap = new Map();

    const addNorm = (key, item) => {
      if (!key) return;
      let list = byNormName.get(key);
      if (!list) {
        list = [];
        byNormName.set(key, list);
      }
      list.push(item);
    };

    for (const p of catalog) {
      byId.set(p.id.toLowerCase(), p);
      const pNorm = stripAccents(p.name);
      addNorm(pNorm, p);
      if (p.name.includes(",")) {
        const prefixNorm = stripAccents(p.name.split(",")[0]);
        if (prefixNorm !== pNorm) {
          addNorm(prefixNorm, p);
        }
      }
      if (p.category === "airport") {
        if (p.iata_code) {
          addNorm(p.iata_code.toLowerCase(), p);
        }
        if (p.name.includes(" — ")) {
          addNorm(stripAccents(p.name.split(" — ")[1]), p);
        }
      }
      if (
        (p.country_code === "US" || p.country_code === "IN" || p.country_code === "CA") &&
        p.state_code &&
        Number.isFinite(p.lat)
      ) {
        stateItemsByCountry[p.country_code].push(p);
      }
    }

    return { byId, byNormName, stateItemsByCountry, customIdMap };
  }

  _resolveCsvRow(catalog, placeName, cc, lat, lng, userState, csvIndex) {
    const q = String(placeName || "").trim();
    if (!q) return null;
    const ql = q.toLowerCase();
    const qNorm = stripAccents(q);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
    const idx = csvIndex || this._buildCsvIndex(catalog);

    const distSq = (p) => {
      if (!hasCoords || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return 999999;
      const dLat = p.lat - lat;
      const dLng = p.lng - lng;
      return dLat * dLat + dLng * dLng;
    };

    // 1. Direct ID or Alias lookup (O(1))
    if (idx.byId.has(ql)) {
      return idx.byId.get(ql);
    }
    const aliasId = ALIASES[ql] || ALIASES[qNorm];
    if (aliasId && idx.byId.has(aliasId.toLowerCase())) {
      const aliased = idx.byId.get(aliasId.toLowerCase());
      if (!cc || !hasCoords || aliased.country_code === cc || distSq(aliased) < 25) {
        return aliased;
      }
    }

    // 2. Indexed exact/prefix/airport name match (O(1))
    const exactMatches = idx.byNormName.get(qNorm) || [];
    if (exactMatches.length > 0) {
      const ccMatches = cc ? exactMatches.filter((p) => p.country_code === cc) : [];
      const pool = ccMatches.length > 0 ? ccMatches : exactMatches;
      const sorted = [...pool].sort((a, b) => {
        const aParent = PARENT_CATEGORIES.has(a.category) ? 1 : 0;
        const bParent = PARENT_CATEGORIES.has(b.category) ? 1 : 0;
        if (aParent !== bParent) return aParent - bParent;
        return distSq(a) - distSq(b);
      });
      const best = sorted[0];
      if (!hasCoords || !cc || best.country_code === cc || distSq(best) < 25) {
        return best;
      }
    }

    // 3. If row has explicit lat/lon + country code (Places Been format), create custom entry with inferred state
    if (hasCoords && cc) {
      let stateCode = "";
      let subregion = cc;
      const stateCandidates = idx.stateItemsByCountry[cc];
      if (stateCandidates && stateCandidates.length > 0) {
        let bestStateItem = null;
        let bestDist = 999999;
        for (const sp of stateCandidates) {
          const d = distSq(sp);
          if (d < bestDist) {
            bestDist = d;
            bestStateItem = sp;
          }
        }
        if (bestStateItem && bestDist < 16) {
          stateCode = bestStateItem.state_code;
          subregion = bestStateItem.subregion || stateCode;
        }
      }
      const slug = `${qNorm}_${stateCode || cc}`
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      const isAirport = /\bairport\b/i.test(q);
      const isPark =
        /\b(national park|national monument|state park|wildlife sanctuary|tiger reserve|biosphere reserve)\b/i.test(
          q
        );
      const isSight =
        /\b(bridge|tower|statue|memorial|monument|temple|palace|fort|cathedral|basilica|castle|museum|observatory|pier|falls|dam)\b/i.test(
          q
        );
      const cat = isAirport
        ? "airport"
        : isPark
          ? "national_park"
          : isSight
            ? "world_wonder"
            : "city";
      const pid = `${cat}:${slug}`;
      const existing = idx.byId.get(pid.toLowerCase());
      if (existing) return existing;

      const countryEntry = idx.byId.get(`country:${cc.toLowerCase()}`);
      const customItem = {
        id: pid,
        name: q,
        category: cat,
        country_code: cc,
        state_code: stateCode,
        continent: countryEntry ? countryEntry.continent : "Custom",
        subregion,
        lat,
        lng,
        flag_emoji: isoToFlag(cc),
        description: `${isAirport ? "Airport" : isPark ? "National Park" : isSight ? "Landmark" : "Place"} in ${subregion}, ${cc}`,
      };
      if (!idx.customIdMap.has(pid)) {
        userState.custom_catalog = (userState.custom_catalog || []).filter((x) => x.id !== pid);
      }
      idx.customIdMap.set(pid, customItem);
      userState.custom_catalog.push(customItem);
      catalog.push(customItem);
      idx.byId.set(pid.toLowerCase(), customItem);
      return customItem;
    }

    // 4. Fallback for rows without coordinates
    const fallback =
      this.resolvePlace(catalog, cc ? `${q}, ${cc}` : q) || this.resolvePlace(catalog, q);
    return fallback;
  }

  async importCsv(csvText, mode = "append") {
    const importMode = mode === "override" ? "override" : "append";
    const lines = String(csvText || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      return {
        mode: importMode,
        imported: 0,
        visited_count: 0,
        bucket_count: 0,
        deleted_total: 0,
        deleted_by_category: {},
        deleted_items: [],
        added_total: 0,
        added_by_category: {},
        added_items: [],
        unresolved: [],
      };
    }

    const delimiter = lines[0].includes(";") ? ";" : ",";
    const headers = lines[0]
      .split(delimiter)
      .map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());

    const userState = await this.storageRepo.loadUserState();
    const catalog = this.getMergedCatalog(userState);
    const now = new Date().toISOString();
    const changedItems = [];
    const unresolved = [];
    let visitedCount = 0;
    let bucketCount = 0;

    const deletedByCat = {
      city: 0,
      national_park: 0,
      unesco: 0,
      world_wonder: 0,
      airport: 0,
    };
    const deletedItems = [];
    let deletedTotal = 0;

    if (importMode === "override") {
      for (const p of catalog) {
        if (PARENT_CATEGORIES.has(p.category)) continue;
        if (p.status === "visited" || p.status === "bucket_list") {
          deletedTotal++;
          deletedByCat[p.category] = (deletedByCat[p.category] || 0) + 1;
          if (deletedItems.length < 10) {
            deletedItems.push({
              id: p.id,
              name: p.name,
              category: p.category,
              flag_emoji: p.flag_emoji || "📍",
              status: p.status,
            });
          }
          changedItems.push({
            id: p.id,
            name: p.name,
            category: p.category,
            flag_emoji: p.flag_emoji,
            status: "unvisited",
            is_favorite: false,
          });
          p.status = "unvisited";
        }
      }
      userState.places = {};
    }

    const addedMap = new Map();
    const csvIndex = this._buildCsvIndex(catalog);

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = cols[idx] || "";
      });

      const placeName =
        row.place_id || row.name || row.city || row.place || row.country || "";
      if (!placeName) continue;

      const cc = String(row.country_code || row.country || "").trim().toUpperCase();
      const lat = parseFloat(row.lat);
      const lng = parseFloat(row.lon !== undefined ? row.lon : row.lng);
      const rawStatus = (row.status || row.been || "visited").toLowerCase().trim();

      let status = "visited";
      if (rawStatus === "want" || rawStatus === "bucket_list" || rawStatus === "wishlist") {
        status = "bucket_list";
      } else if (rawStatus === "unvisited") {
        status = "unvisited";
      }

      const resolved = this._resolveCsvRow(
        catalog,
        placeName,
        cc.length === 2 ? cc : "",
        lat,
        lng,
        userState,
        csvIndex
      );
      if (!resolved) {
        unresolved.push(placeName);
        continue;
      }

      const pid = resolved.id;
      if (PARENT_CATEGORIES.has(resolved.category)) {
        continue;
      }
      if (status === "unvisited") {
        delete userState.places[pid];
        resolved.status = "unvisited";
        continue;
      }

      const prev = userState.places[pid] || {};
      const prevStatus = prev.status || "unvisited";
      // Do not downgrade an already visited place to bucket_list if duplicate rows exist
      const finalStatus = prevStatus === "visited" && status === "bucket_list" ? "visited" : status;
      const fav =
        row.is_favorite !== undefined
          ? ["1", "true", "yes"].includes(String(row.is_favorite).toLowerCase())
          : Boolean(prev.is_favorite);

      if (importMode === "override" || prevStatus !== finalStatus) {
        addedMap.set(pid, {
          id: pid,
          name: resolved.name,
          category: resolved.category,
          flag_emoji: resolved.flag_emoji || "📍",
          status: finalStatus,
        });
      }

      userState.places[pid] = {
        status: finalStatus,
        is_favorite: fav,
        visit_date: row.visit_date || prev.visit_date || "",
        rating: Number(row.rating || prev.rating || 0),
        trip_name: row.trip_name || prev.trip_name || "",
        notes: row.notes || prev.notes || "",
        updated_at: now,
      };
      resolved.status = finalStatus;
      changedItems.push({
        id: pid,
        name: resolved.name,
        category: resolved.category,
        flag_emoji: resolved.flag_emoji,
        status: finalStatus,
        is_favorite: fav,
      });

      if (finalStatus === "visited") {
        visitedCount++;
      } else if (finalStatus === "bucket_list") {
        bucketCount++;
      }
    }

    const addedByCat = {
      city: 0,
      national_park: 0,
      unesco: 0,
      world_wonder: 0,
      airport: 0,
    };
    const addedAll = Array.from(addedMap.values());
    for (const item of addedAll) {
      addedByCat[item.category] = (addedByCat[item.category] || 0) + 1;
    }

    this._syncDerivedParentsToUserState(userState, catalog, now, changedItems);
    await this.storageRepo.saveUserState(userState, changedItems);
    return {
      mode: importMode,
      imported: visitedCount + bucketCount,
      visited_count: visitedCount,
      bucket_count: bucketCount,
      deleted_total: deletedTotal,
      deleted_by_category: deletedByCat,
      deleted_items: deletedTotal < 10 ? deletedItems : [],
      added_total: addedAll.length,
      added_by_category: addedByCat,
      added_items: addedAll.length < 10 ? addedAll : [],
      auto_propagated_count: Math.max(0, changedItems.length - (visitedCount + bucketCount)),
      unresolved,
    };
  }
}

