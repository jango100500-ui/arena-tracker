import http from "node:http";
import { URL } from "node:url";
import Fuse from "fuse.js";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  process.env.COMLINK_URL ||
  "https://arena-tracker-2uod.onrender.com";

const ICONS_RAW_URL =
  "https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/main";

const ICONS_REPO_URL =
  "https://github.com/tools4swgoh/swgoh-icons/tree/main";

const CACHE_TTL = 6 * 60 * 60 * 1000;

// ============================================================
// CACHE
// ============================================================

let portraitsCache = null;
let portraitsCacheTime = 0;

let unitsCache = null;
let unitsCacheTime = 0;

let portraitFuse = null;

// ============================================================
// HELPERS
// ============================================================

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-cache"
  });

  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });

  res.end(text);
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      resolve(body);
    });

    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 1000)}`
    );
  }

  return text;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON from ${url}: ${text.slice(0, 1000)}`
    );
  }
}

function normalizeName(value) {
  if (!value) return "";

  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function cleanUnitDefId(unitDefId) {
  if (!unitDefId) return "";

  return String(unitDefId)
    .replace(/:SEVEN_STAR$/i, "")
    .replace(/:ONE_STAR$/i, "")
    .replace(/:TWO_STAR$/i, "")
    .replace(/:THREE_STAR$/i, "")
    .replace(/:FOUR_STAR$/i, "")
    .replace(/:FIVE_STAR$/i, "")
    .replace(/:SIX_STAR$/i, "")
    .replace(/:BASE$/i, "");
}

// ============================================================
// PORTRAITS
// ============================================================

async function loadPortraits() {
  if (
    portraitsCache &&
    Date.now() - portraitsCacheTime < CACHE_TTL
  ) {
    return portraitsCache;
  }

  console.log("Loading portrait index from GitHub...");

  const html = await fetchText(ICONS_REPO_URL);

  const portraits = [];

  // Find every character portrait PNG in the GitHub directory.
  const regex =
    /65px-Unit-Character-[^"'<>\\]+?-portrait\.png/gi;

  const matches = html.match(regex) || [];

  const unique = [...new Set(matches)];

  for (const filename of unique) {
    const decoded = filename
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&");

    const withoutPrefix =
      decoded.replace(/^65px-Unit-Character-/i, "");

    const characterName =
      withoutPrefix.replace(/-portrait\.png$/i, "");

    portraits.push({
      filename: decoded,
      name: characterName,
      normalized: normalizeName(characterName),

      image:
        `${ICONS_RAW_URL}/${encodeURIComponent(decoded)}`
    });
  }

  // Sometimes GitHub's HTML contains escaped URLs.
  // Add a second parser just in case.
  if (portraits.length === 0) {
    const rawRegex =
      /65px-Unit-Character-[^"'<>\\]+?-portrait\.png/gi;

    const rawMatches = html.match(rawRegex) || [];

    for (const filename of rawMatches) {
      const decoded = filename
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&");

      const withoutPrefix =
        decoded.replace(/^65px-Unit-Character-/i, "");

      const characterName =
        withoutPrefix.replace(/-portrait\.png$/i, "");

      portraits.push({
        filename: decoded,
        name: characterName,
        normalized: normalizeName(characterName),
        image:
          `${ICONS_RAW_URL}/${encodeURIComponent(decoded)}`
      });
    }
  }

  // Remove duplicates.
  const uniquePortraits = [];
  const seen = new Set();

  for (const portrait of portraits) {
    if (seen.has(portrait.filename)) {
      continue;
    }

    seen.add(portrait.filename);
    uniquePortraits.push(portrait);
  }

  portraitsCache = uniquePortraits;
  portraitsCacheTime = Date.now();

  portraitFuse = new Fuse(portraitsCache, {
    keys: [
      "name",
      "normalized"
    ],
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true
  });

  console.log(
    `Portrait index loaded: ${portraitsCache.length}`
  );

  return portraitsCache;
}

// ============================================================
// COMLINK GAME DATA
// ============================================================

async function loadUnits() {
  if (
    unitsCache &&
    Date.now() - unitsCacheTime < CACHE_TTL
  ) {
    return unitsCache;
  }

  console.log("Loading unitsList from Comlink...");

  const requestBody = {
    payload: {
      collection: "unitsList",
      language: "ENG_US",

      enums: true,

      match: {
        rarity: 7
      },

      project: {
        baseId: 1,
        nameKey: 1,
        thumbnailName: 1,
        descKey: 1,
        combatType: 1,
        forceAlignment: 1,

        skillReferenceList: {
          skillId: 1
        }
      }
    }
  };

  const response = await fetch(
    `${COMLINK_URL}/data`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify(requestBody)
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Comlink /data ${response.status}: ${text}`
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Comlink /data returned invalid JSON: ${text.slice(0, 2000)}`
    );
  }

  let units = null;

  // ----------------------------------------------------------
  // Different Comlink versions/wrappers
  // ----------------------------------------------------------

  if (Array.isArray(json)) {
    units = json;
  }

  if (!units && Array.isArray(json.data)) {
    units = json.data;
  }

  if (!units && Array.isArray(json.unitsList)) {
    units = json.unitsList;
  }

  if (
    !units &&
    json.data &&
    Array.isArray(json.data.unitsList)
  ) {
    units = json.data.unitsList;
  }

  if (
    !units &&
    json.payload &&
    Array.isArray(json.payload)
  ) {
    units = json.payload;
  }

  if (!units) {
    throw new Error(
      `Unexpected /data response: ${JSON.stringify(json).slice(0, 5000)}`
    );
  }

  console.log(
    `Units loaded from Comlink: ${units.length}`
  );

  unitsCache = units;
  unitsCacheTime = Date.now();

  return units;
}

// ============================================================
// UNIT INDEX
// ============================================================

async function buildUnitIndex() {
  const units = await loadUnits();

  const byBaseId = new Map();
  const byId = new Map();
  const byThumbnail = new Map();

  for (const unit of units) {
    if (!unit || typeof unit !== "object") {
      continue;
    }

    if (unit.baseId) {
      byBaseId.set(
        String(unit.baseId).toUpperCase(),
        unit
      );
    }

    if (unit.id) {
      byId.set(
        String(unit.id).toUpperCase(),
        unit
      );
    }

    if (unit.thumbnailName) {
      byThumbnail.set(
        normalizeName(unit.thumbnailName),
        unit
      );
    }
  }

  return {
    units,
    byBaseId,
    byId,
    byThumbnail
  };
}

// ============================================================
// PORTRAIT MATCHING
// ============================================================

function createPortraitCandidates(unitDefId, unit) {
  const candidates = [];

  const baseId = cleanUnitDefId(unitDefId);

  if (unitDefId) {
    candidates.push(String(unitDefId));
  }

  if (baseId) {
    candidates.push(baseId);
  }

  if (unit) {
    if (unit.baseId) {
      candidates.push(String(unit.baseId));
    }

    if (unit.id) {
      candidates.push(String(unit.id));
    }

    if (unit.thumbnailName) {
      candidates.push(String(unit.thumbnailName));
    }

    if (unit.nameKey) {
      candidates.push(String(unit.nameKey));
    }

    if (unit.descKey) {
      candidates.push(String(unit.descKey));
    }
  }

  return [
    ...new Set(
      candidates
        .filter(Boolean)
        .map(String)
    )
  ];
}

function findExactPortrait(candidates, portraits) {
  const normalizedCandidates =
    candidates
      .map(normalizeName)
      .filter(Boolean);

  if (!normalizedCandidates.length) {
    return null;
  }

  // ----------------------------------------------------------
  // Exact normalized filename/name matching
  // ----------------------------------------------------------

  for (const candidate of normalizedCandidates) {
    const found = portraits.find(
      portrait =>
        portrait.normalized === candidate
    );

    if (found) {
      return {
        portrait: found,
        method: "exact-normalized",
        score: 0
      };
    }
  }

  // ----------------------------------------------------------
  // More tolerant matching:
  // Captain Rex
  // CAPTAINREX
  // Captain_Rex
  // etc.
  // ----------------------------------------------------------

  for (const candidate of normalizedCandidates) {
    const found = portraits.find(
      portrait => {
        const p = portrait.normalized;

        return (
          p === candidate ||
          p.includes(candidate) ||
          candidate.includes(p)
        );
      }
    );

    if (found) {
      return {
        portrait: found,
        method: "partial-normalized",
        score: 0.1
      };
    }
  }

  return null;
}

function findFuzzyPortrait(candidates, portraits) {
  if (!portraitFuse) {
    return null;
  }

  const results = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const matches = portraitFuse.search(
      String(candidate)
    );

    for (const match of matches) {
      results.push(match);
    }
  }

  if (!results.length) {
    return null;
  }

  results.sort(
    (a, b) =>
      (a.score ?? 1) -
      (b.score ?? 1)
  );

  const best = results[0];

  if (!best || !best.item) {
    return null;
  }

  return {
    portrait: best.item,
    method: "fuzzy",
    score: best.score
  };
}

// ============================================================
// CHARACTER IMAGE
// ============================================================

async function findCharacterImage(unitDefId) {
  const portraits = await loadPortraits();
  const unitIndex = await buildUnitIndex();

  const cleanId =
    cleanUnitDefId(unitDefId);

  const upperId =
    String(unitDefId || "").toUpperCase();

  const upperCleanId =
    cleanId.toUpperCase();

  let unit =
    unitIndex.byId.get(upperId) ||
    unitIndex.byBaseId.get(upperCleanId);

  // Sometimes Comlink has a unit id with additional suffixes.
  if (!unit) {
    for (const candidate of unitIndex.units) {
      if (!candidate) continue;

      const candidateBase =
        String(candidate.baseId || "")
          .toUpperCase();

      const candidateId =
        String(candidate.id || "")
          .toUpperCase();

      if (
        candidateBase === upperCleanId ||
        candidateId === upperId
      ) {
        unit = candidate;
        break;
      }
    }
  }

  const candidates =
    createPortraitCandidates(
      unitDefId,
      unit
    );

  console.log(
    "Portrait search:",
    unitDefId
  );

  console.log(
    "Resolved unit:",
    unit
      ? {
          baseId: unit.baseId,
          id: unit.id,
          thumbnailName: unit.thumbnailName,
          nameKey: unit.nameKey
        }
      : null
  );

  console.log(
    "Candidates:",
    candidates
  );

  // ----------------------------------------------------------
  // Exact / partial
  // ----------------------------------------------------------

  const exact =
    findExactPortrait(
      candidates,
      portraits
    );

  if (exact) {
    return {
      ok: true,

      image:
        exact.portrait.image,

      filename:
        exact.portrait.filename,

      match:
        exact.method,

      score:
        exact.score,

      unit: unit
        ? {
            baseId: unit.baseId,
            id: unit.id,
            thumbnailName:
              unit.thumbnailName,
            nameKey:
              unit.nameKey
          }
        : null,

      candidates
    };
  }

  // ----------------------------------------------------------
  // Fuse fallback
  // ----------------------------------------------------------

  const fuzzy =
    findFuzzyPortrait(
      candidates,
      portraits
    );

  if (fuzzy) {
    return {
      ok: true,

      image:
        fuzzy.portrait.image,

      filename:
        fuzzy.portrait.filename,

      match:
        fuzzy.method,

      score:
        fuzzy.score,

      unit: unit
        ? {
            baseId: unit.baseId,
            id: unit.id,
            thumbnailName:
              unit.thumbnailName,
            nameKey:
              unit.nameKey
          }
        : null,

      candidates
    };
  }

  // ----------------------------------------------------------
  // Not found
  // ----------------------------------------------------------

  return {
    ok: false,

    error: "IMAGE_NOT_FOUND",

    unitDefId,

    cleanId,

    unit: unit
      ? {
          baseId: unit.baseId,
          id: unit.id,
          thumbnailName:
            unit.thumbnailName,
          nameKey:
            unit.nameKey
        }
      : null,

    candidates,

    portraitCount:
      portraits.length
  };
}

// ============================================================
// SERVER
// ============================================================

const server = http.createServer(
  async (req, res) => {
    try {
      // ------------------------------------------------------
      // CORS preflight
      // ------------------------------------------------------

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type",
          "Access-Control-Allow-Methods":
            "GET,POST,OPTIONS"
        });

        res.end();
        return;
      }

      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      const pathname =
        url.pathname;

      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        pathname === "/health" &&
        req.method === "GET"
      ) {
        sendJson(res, 200, {
          ok: true,
          service: "arena-tracker-proxy",
          comlink: COMLINK_URL,
          time: new Date().toISOString()
        });

        return;
      }

      // ------------------------------------------------------
      // PORTRAIT STATUS
      // ------------------------------------------------------

      if (
        pathname === "/portraitStatus" &&
        req.method === "GET"
      ) {
        const portraits =
          await loadPortraits();

        sendJson(res, 200, {
          ok: true,
          portraits: portraits.length,

          cacheAge:
            portraitsCacheTime
              ? Math.floor(
                  (Date.now() -
                    portraitsCacheTime) /
                    1000
                )
              : null
        });

        return;
      }

      // ------------------------------------------------------
      // GAME DATA STATUS
      // ------------------------------------------------------

      if (
        pathname === "/gameDataStatus" &&
        req.method === "GET"
      ) {
        const units =
          await loadUnits();

        sendJson(res, 200, {
          ok: true,

          units: units.length,

          cacheAge:
            unitsCacheTime
              ? Math.floor(
                  (Date.now() -
                    unitsCacheTime) /
                    1000
                )
              : null,

          sample:
            units.slice(0, 3).map(unit => ({
              baseId: unit.baseId,
              id: unit.id,
              thumbnailName:
                unit.thumbnailName,
              nameKey:
                unit.nameKey
            }))
        });

        return;
      }

      // ------------------------------------------------------
      // CHARACTER IMAGE
      // ------------------------------------------------------

      if (
        pathname === "/characterImage" &&
        req.method === "POST"
      ) {
        const body =
          await readJsonBody(req);

        const unitDefId =
          body.unitDefId;

        if (!unitDefId) {
          sendJson(res, 400, {
            ok: false,
            error:
              "unitDefId is required"
          });

          return;
        }

        const result =
          await findCharacterImage(
            unitDefId
          );

        sendJson(res, 200, result);

        return;
      }

      // ------------------------------------------------------
      // PLAYER ARENA
      // ------------------------------------------------------

      if (
        pathname === "/playerArena" &&
        req.method === "POST"
      ) {
        const body =
          await readJsonBody(req);

        const allyCode =
          body.allyCode;

        if (!allyCode) {
          sendJson(res, 400, {
            ok: false,
            error:
              "allyCode is required"
          });

          return;
        }

        const response =
          await fetch(
            `${COMLINK_URL}/playerArena`,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body: JSON.stringify({
                allyCode:
                  String(allyCode)
              })
            }
          );

        const text =
          await response.text();

        if (!response.ok) {
          throw new Error(
            `Comlink /playerArena ${response.status}: ${text}`
          );
        }

        let json;

        try {
          json =
            JSON.parse(text);
        } catch {
          throw new Error(
            `Invalid JSON from /playerArena: ${text.slice(0, 1000)}`
          );
        }

        sendJson(res, 200, json);

        return;
      }

      // ------------------------------------------------------
      // PLAYER
      // ------------------------------------------------------

      if (
        pathname === "/player" &&
        req.method === "POST"
      ) {
        const body =
          await readJsonBody(req);

        const allyCode =
          body.allyCode;

        if (!allyCode) {
          sendJson(res, 400, {
            ok: false,
            error:
              "allyCode is required"
          });

          return;
        }

        const response =
          await fetch(
            `${COMLINK_URL}/player`,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body: JSON.stringify({
                allyCode:
                  String(allyCode)
              })
            }
          );

        const text =
          await response.text();

        if (!response.ok) {
          throw new Error(
            `Comlink /player ${response.status}: ${text}`
          );
        }

        let json;

        try {
          json =
            JSON.parse(text);
        } catch {
          throw new Error(
            `Invalid JSON from /player: ${text.slice(0, 1000)}`
          );
        }

        sendJson(res, 200, json);

        return;
      }

      // ------------------------------------------------------
      // PROXY RAW DATA
      // ------------------------------------------------------

      if (
        pathname === "/data" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const response =
          await fetch(
            `${COMLINK_URL}/data`,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body
            }
          );

        const text =
          await response.text();

        res.writeHead(
          response.status,
          {
            "Content-Type":
              "application/json; charset=utf-8",

            "Access-Control-Allow-Origin":
              "*"
          }
        );

        res.end(text);

        return;
      }

      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      sendJson(res, 404, {
        ok: false,
        error: "Not found",
        path: pathname
      });
    } catch (error) {
      console.error(
        "SERVER ERROR:",
        error
      );

      sendJson(res, 500, {
        ok: false,

        error:
          error?.message ||
          String(error),

        stack:
          error?.stack ||
          null
      });
    }
  }
);

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  () => {
    console.log(
      `Arena Tracker Proxy listening on port ${PORT}`
    );

    console.log(
      `Comlink: ${COMLINK_URL}`
    );
  }
);
