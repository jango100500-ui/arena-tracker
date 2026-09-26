import http from "node:http";
import { URL } from "node:url";
import Fuse from "fuse.js";

const PORT = process.env.PORT || 10000;

// Твой Comlink Render
const COMLINK_URL =
  process.env.COMLINK_URL ||
  "https://arena-tracker-2uod.onrender.com";

// GitHub raw с актуальными иконками
const ICONS_RAW =
  "https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/main/";

// Репозиторий иконок.
// Вместо GitHub API используем обычную HTML-страницу,
// чтобы не упираться в API rate limit.
const ICONS_REPO =
  "https://github.com/tools4swgoh/swgoh-icons/tree/main";

// Официальные game data
const GAMEDATA_RAW =
  "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/";

// ------------------------------------------------------------
// CACHE
// ------------------------------------------------------------

let gameDataCache = null;
let gameDataLoadedAt = 0;

let portraitCache = null;
let portraitLoadedAt = 0;

const GAME_DATA_TTL = 60 * 60 * 1000;       // 1 час
const PORTRAIT_TTL = 6 * 60 * 60 * 1000;    // 6 часов

// ------------------------------------------------------------
// HTTP HELPERS
// ------------------------------------------------------------

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "arena-tracker/1.0",
      Accept: "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Ответ не является JSON: ${text.slice(0, 500)}`);
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "arena-tracker/1.0",
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`
    );
  }

  return text;
}

// ------------------------------------------------------------
// GAME DATA
// ------------------------------------------------------------

function normalizeArray(value) {
  if (Array.isArray(value)) return value;

  if (!value || typeof value !== "object") {
    return [];
  }

  // Некоторые игровые коллекции могут прийти объектом.
  return Object.values(value);
}

function extractCollection(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload.data && typeof payload.data === "object") {
    return Object.values(payload.data);
  }

  return [];
}

async function loadUnitsFromGameData() {
  // Сначала пытаемся использовать units.json из gamedata.
  // Это самый простой и лёгкий источник актуальных baseId/nameKey.
  const candidates = [
    "units.json",
    "unitsList.json"
  ];

  let lastError = null;

  for (const file of candidates) {
    try {
      const data = await fetchJson(`${GAMEDATA_RAW}${file}`);

      const units = extractCollection(data);

      if (units.length > 0) {
        return {
          source: `${GAMEDATA_RAW}${file}`,
          units
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Не удалось загрузить units из gamedata: ${
      lastError?.message || "unknown error"
    }`
  );
}

async function getGameData() {
  const now = Date.now();

  if (
    gameDataCache &&
    now - gameDataLoadedAt < GAME_DATA_TTL
  ) {
    return gameDataCache;
  }

  const loaded = await loadUnitsFromGameData();

  const units = normalizeArray(loaded.units);

  const byBaseId = new Map();
  const byDefinitionId = new Map();

  for (const unit of units) {
    if (!unit || typeof unit !== "object") continue;

    const baseId =
      unit.baseId ||
      unit.baseID ||
      unit.id ||
      unit.unitId;

    if (baseId) {
      byBaseId.set(String(baseId).toUpperCase(), unit);
    }

    const definitionId =
      unit.definitionId ||
      unit.defId ||
      unit.definitionID;

    if (definitionId) {
      byDefinitionId.set(String(definitionId).toUpperCase(), unit);
    }
  }

  gameDataCache = {
    source: loaded.source,
    units,
    byBaseId,
    byDefinitionId
  };

  gameDataLoadedAt = now;

  console.log(
    `[GAME DATA] loaded ${units.length} units from ${loaded.source}`
  );

  return gameDataCache;
}

// ------------------------------------------------------------
// PORTRAIT INDEX
// ------------------------------------------------------------

function decodeGitHubPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanFileName(name) {
  return decodeGitHubPath(name)
    .replace(/^.*\//, "")
    .replace(/\.png$/i, "")
    .trim();
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/["'’]/g, "")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeSearchName(name) {
  return normalizeName(name)
    .replace(/\bunit\b/g, "")
    .replace(/\bcharacter\b/g, "")
    .replace(/\bportrait\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCharacterPortrait(filename) {
  const clean = cleanFileName(filename);

  return (
    /^65px-Unit-Character-.*-portrait\.png$/i.test(clean + ".png")
  );
}

function portraitFileToName(filename) {
  let name = cleanFileName(filename);

  name = name
    .replace(/^65px-Unit-Character-/i, "")
    .replace(/-portrait$/i, "");

  // GitHub filename convention
  name = name.replace(/_/g, " ");

  // Некоторые имена используют encoded punctuation.
  name = name.replace(/%26/gi, "&");
  name = name.replace(/%22/g, '"');

  return name;
}

async function loadPortraitIndex() {
  const now = Date.now();

  if (
    portraitCache &&
    now - portraitLoadedAt < PORTRAIT_TTL
  ) {
    return portraitCache;
  }

  console.log("[PORTRAITS] downloading portrait index...");

  let html;

  try {
    html = await fetchText(ICONS_REPO);
  } catch (error) {
    console.error(
      "[PORTRAITS] GitHub page failed:",
      error.message
    );

    throw error;
  }

  const files = new Set();

  // GitHub HTML содержит ссылки на файлы.
  // Ищем все character portrait PNG.
  const regex =
    /65px-Unit-Character-[^"'<>]+?-portrait\.png/gi;

  for (const match of html.matchAll(regex)) {
    const file = decodeGitHubPath(match[0]);

    if (isCharacterPortrait(file)) {
      files.add(file);
    }
  }

  const portraits = [...files].map((file) => {
    const name = portraitFileToName(file);

    return {
      file,
      name,
      normalized: makeSearchName(name),
      url:
        ICONS_RAW +
        encodeURI(file)
    };
  });

  if (!portraits.length) {
    throw new Error(
      "GitHub вернул страницу, но character portraits не найдены"
    );
  }

  portraitCache = portraits;
  portraitLoadedAt = now;

  console.log(
    `[PORTRAITS] indexed ${portraits.length} character portraits`
  );

  return portraitCache;
}

// ------------------------------------------------------------
// UNIT → PORTRAIT
// ------------------------------------------------------------

function getBaseIdFromDefinitionId(definitionId) {
  if (!definitionId) return "";

  return String(definitionId)
    .split(":")[0]
    .toUpperCase();
}

function getPossibleNames(unit) {
  if (!unit) return [];

  const names = [];

  const fields = [
    "name",
    "nameKey",
    "baseId",
    "id",
    "unitId",
    "definitionId",
    "thumbnailName"
  ];

  for (const field of fields) {
    if (unit[field]) {
      names.push(String(unit[field]));
    }
  }

  // Иногда локализованное имя может находиться глубже.
  if (unit.nameKey && typeof unit.nameKey === "object") {
    names.push(...Object.values(unit.nameKey));
  }

  return [...new Set(names.filter(Boolean))];
}

function scoreExactBaseId(baseId, portrait) {
  const normalizedBase = makeSearchName(
    String(baseId)
      .replace(/_/g, " ")
      .replace(/-/g, " ")
  );

  const normalizedPortrait = portrait.normalized;

  if (!normalizedBase || !normalizedPortrait) {
    return 0;
  }

  if (normalizedBase === normalizedPortrait) {
    return 1000;
  }

  if (
    normalizedPortrait.includes(normalizedBase) ||
    normalizedBase.includes(normalizedPortrait)
  ) {
    return 500;
  }

  return 0;
}

function createFuseIndex(portraits) {
  return new Fuse(portraits, {
    keys: [
      {
        name: "normalized",
        weight: 1
      },
      {
        name: "name",
        weight: 0.7
      }
    ],
    threshold: 0.25,
    distance: 100,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 3
  });
}

async function findCharacterImage(unitDefId) {
  const started = Date.now();

  const definitionId = String(unitDefId || "").trim();

  if (!definitionId) {
    return {
      image: null,
      debug: {
        error: "empty unitDefId"
      }
    };
  }

  const baseId = getBaseIdFromDefinitionId(definitionId);

  const gameData = await getGameData();
  const portraits = await loadPortraitIndex();

  let unit =
    gameData.byDefinitionId.get(
      definitionId.toUpperCase()
    ) ||
    gameData.byBaseId.get(baseId);

  // ----------------------------------------------------------
  // Exact baseId / unit lookup
  // ----------------------------------------------------------

  let candidates = [];

  if (unit) {
    candidates = getPossibleNames(unit);
  }

  // Даже если game data не нашла запись,
  // baseId всё равно полезен как дополнительный ключ.
  candidates.push(baseId);

  candidates = [
    ...new Set(
      candidates
        .filter(Boolean)
        .map(String)
    )
  ];

  // ----------------------------------------------------------
  // Exact matches
  // ----------------------------------------------------------

  const exactMatches = [];

  for (const portrait of portraits) {
    let score = 0;

    for (const candidate of candidates) {
      const candidateNormalized =
        makeSearchName(candidate);

      if (!candidateNormalized) continue;

      if (
        candidateNormalized ===
        portrait.normalized
      ) {
        score = Math.max(score, 1000);
      }

      score = Math.max(
        score,
        scoreExactBaseId(candidate, portrait)
      );
    }

    if (score > 0) {
      exactMatches.push({
        portrait,
        score
      });
    }
  }

  exactMatches.sort(
    (a, b) => b.score - a.score
  );

  if (exactMatches.length) {
    const best = exactMatches[0];

    return {
      image: best.portrait.url,
      match: best.portrait.name,
      debug: {
        method: "exact",
        definitionId,
        baseId,
        unitFound: !!unit,
        unit: unit || null,
        candidates,
        portrait: best.portrait.file,
        score: best.score,
        alternatives: exactMatches
          .slice(1, 5)
          .map((x) => ({
            name: x.portrait.name,
            score: x.score
          })),
        elapsedMs: Date.now() - started
      }
    };
  }

  // ----------------------------------------------------------
  // Fuse fallback
  // ----------------------------------------------------------

  const fuse = createFuseIndex(portraits);

  const fuseQueries = [
    ...candidates,
    baseId
  ].filter(Boolean);

  let fuseResults = [];

  for (const query of fuseQueries) {
    const result = fuse.search(
      makeSearchName(query)
    );

    fuseResults.push(
      ...result.map((item) => ({
        ...item,
        query
      }))
    );
  }

  // Убираем дубли
  const unique = new Map();

  for (const result of fuseResults) {
    const key = result.item.file;

    if (
      !unique.has(key) ||
      (result.score ?? 1) <
        (unique.get(key).score ?? 1)
    ) {
      unique.set(key, result);
    }
  }

  fuseResults = [...unique.values()]
    .sort(
      (a, b) =>
        (a.score ?? 1) -
        (b.score ?? 1)
    );

  if (fuseResults.length) {
    const best = fuseResults[0];

    return {
      image: best.item.url,
      match: best.item.name,
      debug: {
        method: "fuzzy-fallback",
        definitionId,
        baseId,
        unitFound: !!unit,
        unit: unit || null,
        candidates,
        portrait: best.item.file,
        score: best.score,
        query: best.query,
        alternatives: fuseResults
          .slice(1, 6)
          .map((x) => ({
            name: x.item.name,
            score: x.score
          })),
        elapsedMs: Date.now() - started
      }
    };
  }

  // ----------------------------------------------------------
  // Nothing found
  // ----------------------------------------------------------

  return {
    image: null,
    match: null,
    debug: {
      method: "not-found",
      definitionId,
      baseId,
      unitFound: !!unit,
      unit: unit || null,
      candidates,
      portraitsAvailable: portraits.length,
      elapsedMs: Date.now() - started
    }
  };
}

// ------------------------------------------------------------
// COMLINK PROXY
// ------------------------------------------------------------

async function proxyToComlink(path, body) {
  const url = `${COMLINK_URL}${path}`;

  console.log(
    `[COMLINK] POST ${path}`
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Comlink ${response.status}: ${text.slice(0, 1000)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Comlink returned invalid JSON: ${text.slice(0, 1000)}`
    );
  }
}

// ------------------------------------------------------------
// REQUEST BODY
// ------------------------------------------------------------

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      // Защита от случайно огромного POST.
      if (body.length > 2_000_000) {
        req.destroy();
        reject(
          new Error("Request body too large")
        );
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(
          new Error("Invalid JSON body")
        );
      }
    });

    req.on("error", reject);
  });
}

// ------------------------------------------------------------
// JSON RESPONSE
// ------------------------------------------------------------

function sendJson(res, status, data) {
  const payload =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type",

    "Cache-Control":
      "no-store"
  });

  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type":
      "text/plain; charset=utf-8",

    "Access-Control-Allow-Origin": "*"
  });

  res.end(text);
}

// ------------------------------------------------------------
// SERVER
// ------------------------------------------------------------

const server = http.createServer(
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type"
        });

        res.end();
        return;
      }

      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      // ------------------------------------------------------
      // Health
      // ------------------------------------------------------

      if (
        url.pathname === "/health" &&
        req.method === "GET"
      ) {
        sendJson(res, 200, {
          ok: true,
          service: "arena-tracker-proxy",
          comlink: COMLINK_URL,
          gameDataLoaded: !!gameDataCache,
          portraitsLoaded: !!portraitCache
        });

        return;
      }

      // ------------------------------------------------------
      // Debug game data
      // ------------------------------------------------------

      if (
        url.pathname === "/gameDataStatus" &&
        req.method === "GET"
      ) {
        const data =
          await getGameData();

        sendJson(res, 200, {
          ok: true,
          source: data.source,
          units: data.units.length,
          cacheAge:
            Date.now() -
            gameDataLoadedAt
        });

        return;
      }

      // ------------------------------------------------------
      // Debug portraits
      // ------------------------------------------------------

      if (
        url.pathname === "/portraitStatus" &&
        req.method === "GET"
      ) {
        const portraits =
          await loadPortraitIndex();

        sendJson(res, 200, {
          ok: true,
          portraits: portraits.length,
          cacheAge:
            Date.now() -
            portraitLoadedAt
        });

        return;
      }

      // ------------------------------------------------------
      // Character image
      // ------------------------------------------------------

      if (
        url.pathname === "/characterImage" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const unitDefId =
          body.unitDefId ||
          body.definitionId ||
          body.defId;

        console.log(
          `[PORTRAIT] ${unitDefId}`
        );

        try {
          const result =
            await findCharacterImage(
              unitDefId
            );

          sendJson(res, 200, {
            unitDefId,
            ...result
          });
        } catch (error) {
          console.error(
            "[PORTRAIT ERROR]",
            error
          );

          sendJson(res, 500, {
            unitDefId,
            image: null,
            error: error.message,
            debug: {
              stack: error.stack
            }
          });
        }

        return;
      }

      // ------------------------------------------------------
      // Arena
      // ------------------------------------------------------

      if (
        url.pathname === "/playerArena" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const data =
          await proxyToComlink(
            "/playerArena",
            body
          );

        sendJson(res, 200, data);
        return;
      }

      // ------------------------------------------------------
      // Player
      // ------------------------------------------------------

      if (
        url.pathname === "/player" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const data =
          await proxyToComlink(
            "/player",
            body
          );

        sendJson(res, 200, data);
        return;
      }

      // ------------------------------------------------------
      // Root
      // ------------------------------------------------------

      if (
        url.pathname === "/" &&
        req.method === "GET"
      ) {
        sendText(
          res,
          200,
          "Arena Tracker Proxy OK"
        );

        return;
      }

      sendJson(res, 404, {
        error: "Not found"
      });
    } catch (error) {
      console.error(
        "[SERVER ERROR]",
        error
      );

      sendJson(res, 500, {
        error: error.message
      });
    }
  }
);

server.listen(PORT, () => {
  console.log(
    `Arena Tracker Proxy listening on ${PORT}`
  );

  console.log(
    `Comlink: ${COMLINK_URL}`
  );
});
