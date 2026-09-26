import http from "http";
import https from "https";
import { brotliDecompressSync } from "zlib";
import Fuse from "fuse.js";

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 3000;

const COMLINK_URL =
  process.env.COMLINK_URL ||
  "https://arena-tracker-2uod.onrender.com";

const ICONS_REPO_API =
  "https://api.github.com/repos/tools4swgoh/swgoh-icons/contents";

const ICONS_RAW_BASE =
  "https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/main";

const GAMEDATA_RAW_BASE =
  "https://raw.githubusercontent.com/swgoh-utils/gamedata/main";

const GAMEDATA_API =
  "https://api.github.com/repos/swgoh-utils/gamedata";

const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

/* =========================================================
   GLOBAL CACHE
========================================================= */

let portraitsCache = null;
let portraitsCacheTime = 0;

let unitsCache = null;
let unitsCacheTime = 0;

let unitsFuse = null;

/* =========================================================
   HTTP HELPERS
========================================================= */

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: options.method || "GET",
        headers: {
          "User-Agent": "arena-tracker/1.0",
          Accept: options.accept || "*/*",
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => chunks.push(chunk));

        res.on("end", () => {
          const buffer = Buffer.concat(chunks);

          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buffer,
          });
        });
      }
    );

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function githubApi(path) {
  const response = await request(
    `https://api.github.com${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `GitHub API ${response.status}: ${response.body.toString("utf8").slice(0, 500)}`
    );
  }

  return JSON.parse(response.body.toString("utf8"));
}

async function getJson(url) {
  const response = await request(url);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `GET ${url} -> ${response.status}: ${response.body
        .toString("utf8")
        .slice(0, 300)}`
    );
  }

  return JSON.parse(response.body.toString("utf8"));
}

/* =========================================================
   COMLINK
========================================================= */

async function comlinkPost(path, payload) {
  const url = `${COMLINK_URL}${path}`;

  const body = JSON.stringify(payload);

  const response = await request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  });

  const text = response.body.toString("utf8");

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(
      `Comlink ${path} -> ${response.status}`
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
}

/* =========================================================
   PORTRAITS
========================================================= */

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/%22/g, "")
    .replace(/%26/g, "and")
    .replace(/&/g, "and")
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function filenameToPortraitName(filename) {
  let name = filename;

  name = name.replace(/^65px-Unit-Character-/i, "");
  name = name.replace(/-portrait\.png$/i, "");
  name = name.replace(/\.png$/i, "");

  try {
    name = decodeURIComponent(name);
  } catch {
    // ignore
  }

  return name;
}

async function discoverPortraitFiles() {
  const allFiles = [];

  async function readDirectory(path = "") {
    const endpoint =
      path.length > 0
        ? `${ICONS_REPO_API}/${path}`
        : ICONS_REPO_API;

    const response = await githubApi(
      endpoint.replace(
        "https://api.github.com",
        ""
      )
    );

    for (const item of response) {
      if (item.type === "file") {
        allFiles.push(item);
      }
    }
  }

  /*
   * swgoh-icons stores the 65px character portraits in
   * the repository root, so one request is enough.
   */
  await readDirectory("");

  return allFiles;
}

async function loadPortraits() {
  const now = Date.now();

  if (
    portraitsCache &&
    now - portraitsCacheTime < CACHE_TTL
  ) {
    return portraitsCache;
  }

  const files = await discoverPortraitFiles();

  const portraits = [];

  for (const file of files) {
    if (!file.name) continue;

    if (!/portrait\.png$/i.test(file.name)) {
      continue;
    }

    const characterName =
      filenameToPortraitName(file.name);

    portraits.push({
      filename: file.name,
      name: characterName,
      normalized: normalizeText(characterName),
      url:
        `${ICONS_RAW_BASE}/` +
        encodeURI(file.name),
    });
  }

  portraitsCache = portraits;
  portraitsCacheTime = now;

  return portraits;
}

/* =========================================================
   GAME DATA
========================================================= */

/*
 * IMPORTANT:
 *
 * The current swgoh-utils/gamedata repository does NOT keep
 * units as normal units.json.
 *
 * allVersions.json reports:
 *
 *     units.json.br
 *
 * So we download that file and Brotli-decompress it.
 */

async function loadUnits() {
  const now = Date.now();

  if (
    unitsCache &&
    now - unitsCacheTime < CACHE_TTL
  ) {
    return unitsCache;
  }

  /*
   * First read allVersions so we know which current version
   * is available.
   */
  const versions = await getJson(
    `${GAMEDATA_RAW_BASE}/allVersions.json`
  );

  if (!versions["units.json.br"]) {
    throw new Error(
      "allVersions.json does not contain units.json.br"
    );
  }

  const version = versions["units.json.br"];

  console.log(
    `[GameData] Current units version: ${version}`
  );

  /*
   * GitHub raw endpoint for the actual compressed data.
   */
  const url =
    `${GAMEDATA_RAW_BASE}/units.json.br`;

  const response = await request(url);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Could not download units.json.br: HTTP ${response.status}`
    );
  }

  let decompressed;

  try {
    decompressed = brotliDecompressSync(
      response.body
    );
  } catch (error) {
    throw new Error(
      `Could not decompress units.json.br: ${error.message}`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(
      decompressed.toString("utf8")
    );
  } catch (error) {
    throw new Error(
      `Could not parse units.json.br: ${error.message}`
    );
  }

  /*
   * Normal gamedata format:
   *
   * {
   *   "version": "...",
   *   "data": [...]
   * }
   */
  let rawUnits;

  if (Array.isArray(parsed)) {
    rawUnits = parsed;
  } else if (Array.isArray(parsed.data)) {
    rawUnits = parsed.data;
  } else if (Array.isArray(parsed.units)) {
    rawUnits = parsed.units;
  } else {
    throw new Error(
      "units.json.br loaded successfully, but its data array was not found"
    );
  }

  /*
   * Build a compact lookup object.
   */
  const units = [];

  for (const unit of rawUnits) {
    if (!unit || typeof unit !== "object") {
      continue;
    }

    const baseId =
      unit.baseId ||
      unit.baseID ||
      unit.unitId ||
      unit.id;

    if (!baseId) {
      continue;
    }

    const nameKey =
      unit.nameKey ||
      unit.name ||
      unit.displayName ||
      "";

    const thumbnailName =
      unit.thumbnailName ||
      unit.thumbnail ||
      unit.portrait ||
      unit.portraitName ||
      "";

    units.push({
      baseId: String(baseId),
      nameKey: String(nameKey || ""),
      thumbnailName: String(
        thumbnailName || ""
      ),
      combatType: unit.combatType,
    });
  }

  if (!units.length) {
    throw new Error(
      "units.json.br was loaded, but no units were extracted"
    );
  }

  unitsCache = units;
  unitsCacheTime = now;

  unitsFuse = new Fuse(units, {
    keys: [
      {
        name: "baseId",
        weight: 0.7,
      },
      {
        name: "thumbnailName",
        weight: 0.3,
      },
    ],
    threshold: 0.45,
    ignoreLocation: true,
  });

  console.log(
    `[GameData] Loaded ${units.length} units`
  );

  return units;
}

/* =========================================================
   PORTRAIT MATCHING
========================================================= */

function stripUnitSuffix(unitDefId) {
  return String(unitDefId || "")
    .replace(/:SEVEN_STAR$/i, "")
    .replace(/:SIX_STAR$/i, "")
    .replace(/:FIVE_STAR$/i, "")
    .replace(/:FOUR_STAR$/i, "")
    .replace(/:THREE_STAR$/i, "")
    .replace(/:TWO_STAR$/i, "")
    .replace(/:ONE_STAR$/i, "")
    .replace(/:ZERO_STAR$/i, "");
}

function unitIdCandidates(unitDefId) {
  const id = stripUnitSuffix(unitDefId);

  const result = new Set();

  result.add(id);
  result.add(id.toUpperCase());
  result.add(id.toLowerCase());

  /*
   * Some IDs contain underscores.
   */
  result.add(id.replace(/_/g, ""));
  result.add(id.replace(/_/g, "-"));

  /*
   * Some IDs contain LEGENDARY/versions.
   */
  result.add(
    id
      .replace(/_LEGENDARY$/i, "")
      .replace(/_EVENT$/i, "")
  );

  /*
   * GL characters.
   */
  result.add(
    id.replace(/^GL/i, "")
  );

  return [...result].filter(Boolean);
}

/*
 * Known SWGOH naming quirks.
 *
 * This is intentionally tiny. The actual mapping is still
 * obtained automatically from gamedata + swgoh-icons.
 */
const SPECIAL_ALIASES = {
  C3POCHEWBACCA: [
    "Threepio & Chewie",
    "ThreepioandChewie",
    "Threepio_Chewie",
  ],

  R2D2_LEGENDARY: [
    "R2-D2",
    "R2D2",
  ],

  CAPTAINREX: [
    "Captain Rex",
    "CT-7567 \"Rex\"",
  ],

  CAPTAINDROGAN: [
    "Captain Drogan",
  ],

  GLLEIA: [
    "GL Leia",
    "Leia",
  ],
};

function scorePortrait(unit, portrait) {
  let score = 0;

  const unitId = normalizeText(
    unit.baseId
  );

  const thumbnail = normalizeText(
    unit.thumbnailName
  );

  const portraitName = normalizeText(
    portrait.name
  );

  /*
   * Exact thumbnail match is the strongest.
   */
  if (
    thumbnail &&
    portraitName === thumbnail
  ) {
    score += 1000;
  }

  /*
   * Exact baseId match.
   */
  if (portraitName === unitId) {
    score += 900;
  }

  /*
   * Containment.
   */
  if (
    unitId &&
    portraitName.includes(unitId)
  ) {
    score += 500;
  }

  if (
    portraitName &&
    unitId.includes(portraitName)
  ) {
    score += 400;
  }

  /*
   * Thumbnail containment.
   */
  if (
    thumbnail &&
    (
      portraitName.includes(thumbnail) ||
      thumbnail.includes(portraitName)
    )
  ) {
    score += 300;
  }

  return score;
}

async function findPortrait(unitDefId) {
  if (!unitDefId) {
    return null;
  }

  const [units, portraits] =
    await Promise.all([
      loadUnits(),
      loadPortraits(),
    ]);

  const cleanId =
    stripUnitSuffix(unitDefId);

  /*
   * -------------------------------------------------------
   * 1. Find exact unit definition.
   * -------------------------------------------------------
   */

  let unit =
    units.find(
      (u) =>
        u.baseId.toUpperCase() ===
        cleanId.toUpperCase()
    );

  /*
   * -------------------------------------------------------
   * 2. If not found, Fuse search.
   * -------------------------------------------------------
   */

  if (!unit && unitsFuse) {
    const result =
      unitsFuse.search(cleanId, {
        limit: 5,
      });

    if (result.length > 0) {
      unit = result[0].item;
    }
  }

  /*
   * -------------------------------------------------------
   * 3. Special aliases.
   * -------------------------------------------------------
   */

  const aliases =
    SPECIAL_ALIASES[cleanId] || [];

  for (const alias of aliases) {
    const normalizedAlias =
      normalizeText(alias);

    const exact =
      portraits.find(
        (p) =>
          p.normalized === normalizedAlias
      );

    if (exact) {
      return {
        unitDefId,
        baseId:
          unit?.baseId || cleanId,
        name:
          unit?.nameKey || alias,
        thumbnailName:
          unit?.thumbnailName || "",
        portrait: exact.name,
        url: exact.url,
        method: "special-alias",
      };
    }
  }

  /*
   * -------------------------------------------------------
   * 4. Match using gamedata thumbnail.
   * -------------------------------------------------------
   */

  if (unit) {
    let best = null;
    let bestScore = 0;

    for (const portrait of portraits) {
      const score =
        scorePortrait(unit, portrait);

      if (score > bestScore) {
        bestScore = score;
        best = portrait;
      }
    }

    if (best && bestScore >= 300) {
      return {
        unitDefId,
        baseId: unit.baseId,
        name:
          unit.nameKey || unit.baseId,
        thumbnailName:
          unit.thumbnailName,
        portrait: best.name,
        url: best.url,
        method: "gamedata",
        score: bestScore,
      };
    }
  }

  /*
   * -------------------------------------------------------
   * 5. Direct normalized ID matching.
   * -------------------------------------------------------
   */

  const candidates =
    unitIdCandidates(cleanId);

  for (const candidate of candidates) {
    const normalized =
      normalizeText(candidate);

    const exact =
      portraits.find(
        (p) =>
          p.normalized === normalized
      );

    if (exact) {
      return {
        unitDefId,
        baseId:
          unit?.baseId || cleanId,
        name:
          unit?.nameKey || cleanId,
        thumbnailName:
          unit?.thumbnailName || "",
        portrait: exact.name,
        url: exact.url,
        method: "direct",
      };
    }
  }

  /*
   * -------------------------------------------------------
   * 6. Fuzzy portrait matching as final fallback.
   * -------------------------------------------------------
   */

  const searchTerms = [
    cleanId,
    ...(unit?.thumbnailName
      ? [unit.thumbnailName]
      : []),
    ...(unit?.nameKey
      ? [unit.nameKey]
      : []),
  ].filter(Boolean);

  let bestFuzzy = null;
  let bestFuzzyScore = 0;

  for (const term of searchTerms) {
    const normalizedTerm =
      normalizeText(term);

    for (const portrait of portraits) {
      const normalizedPortrait =
        portrait.normalized;

      let score = 0;

      if (
        normalizedPortrait ===
        normalizedTerm
      ) {
        score = 100;
      } else if (
        normalizedPortrait.includes(
          normalizedTerm
        )
      ) {
        score = 75;
      } else if (
        normalizedTerm.includes(
          normalizedPortrait
        )
      ) {
        score = 65;
      }

      if (score > bestFuzzyScore) {
        bestFuzzyScore = score;
        bestFuzzy = portrait;
      }
    }
  }

  if (bestFuzzy && bestFuzzyScore >= 65) {
    return {
      unitDefId,
      baseId:
        unit?.baseId || cleanId,
      name:
        unit?.nameKey || cleanId,
      thumbnailName:
        unit?.thumbnailName || "",
      portrait: bestFuzzy.name,
      url: bestFuzzy.url,
      method: "fuzzy",
      score: bestFuzzyScore,
    };
  }

  return null;
}

/* =========================================================
   PLAYER ARENA
========================================================= */

async function getPlayerArena(payload) {
  return await comlinkPost(
    "/playerArena",
    payload
  );
}

/* =========================================================
   PLAYER
========================================================= */

async function getPlayer(payload) {
  return await comlinkPost(
    "/player",
    payload
  );
}

/* =========================================================
   CHARACTER IMAGE
========================================================= */

async function getCharacterImage(body) {
  const unitDefId =
    body?.unitDefId ||
    body?.baseId ||
    body?.id;

  if (!unitDefId) {
    throw new Error(
      "unitDefId is required"
    );
  }

  const result =
    await findPortrait(unitDefId);

  if (!result) {
    return {
      ok: false,
      unitDefId,
      error:
        "Portrait not found",
    };
  }

  return {
    ok: true,
    ...result,
  };
}

/* =========================================================
   ROUTING
========================================================= */

function sendJson(res, status, data) {
  const body =
    JSON.stringify(
      data,
      null,
      2
    );

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",
    "Cache-Control":
      "no-store",
  });

  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type":
      "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",
  });

  res.end(text);
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      const chunks = [];

      req.on(
        "data",
        (chunk) => {
          chunks.push(chunk);
        }
      );

      req.on(
        "end",
        () => {
          const body =
            Buffer.concat(
              chunks
            ).toString("utf8");

          if (!body) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(body)
            );
          } catch {
            reject(
              new Error(
                "Invalid JSON body"
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

/* =========================================================
   SERVER
========================================================= */

const server = http.createServer(
  async (req, res) => {
    try {
      /*
       * CORS preflight.
       */
      if (
        req.method === "OPTIONS"
      ) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin":
            "*",
          "Access-Control-Allow-Headers":
            "Content-Type",
          "Access-Control-Allow-Methods":
            "GET,POST,OPTIONS",
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

      /*
       * -----------------------------------------------------
       * HEALTH
       * -----------------------------------------------------
       */

      if (
        pathname === "/health" &&
        req.method === "GET"
      ) {
        sendJson(res, 200, {
          ok: true,
          service:
            "arena-tracker-proxy",
          time:
            new Date().toISOString(),
        });

        return;
      }

      /*
       * -----------------------------------------------------
       * PORTRAIT STATUS
       * -----------------------------------------------------
       */

      if (
        pathname ===
          "/portraitStatus" &&
        req.method === "GET"
      ) {
        const portraits =
          await loadPortraits();

        sendJson(res, 200, {
          ok: true,
          portraits:
            portraits.length,
          cacheAge:
            portraitsCacheTime
              ? Date.now() -
                portraitsCacheTime
              : null,
        });

        return;
      }

      /*
       * -----------------------------------------------------
       * GAME DATA STATUS
       * -----------------------------------------------------
       */

      if (
        pathname ===
          "/gameDataStatus" &&
        req.method === "GET"
      ) {
        const units =
          await loadUnits();

        sendJson(res, 200, {
          ok: true,
          units:
            units.length,
          cacheAge:
            unitsCacheTime
              ? Date.now() -
                unitsCacheTime
              : null,
        });

        return;
      }

      /*
       * -----------------------------------------------------
       * PLAYER ARENA
       * -----------------------------------------------------
       */

      if (
        pathname ===
          "/playerArena" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const data =
          await getPlayerArena(body);

        sendJson(
          res,
          200,
          data
        );

        return;
      }

      /*
       * -----------------------------------------------------
       * PLAYER
       * -----------------------------------------------------
       */

      if (
        pathname ===
          "/player" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const data =
          await getPlayer(body);

        sendJson(
          res,
          200,
          data
        );

        return;
      }

      /*
       * -----------------------------------------------------
       * CHARACTER IMAGE
       * -----------------------------------------------------
       */

      if (
        pathname ===
          "/characterImage" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const data =
          await getCharacterImage(
            body
          );

        sendJson(
          res,
          200,
          data
        );

        return;
      }

      /*
       * -----------------------------------------------------
       * RAW /DATA DEBUG PROXY
       *
       * Kept for debugging only.
       * Do NOT use this for unit lookup.
       * -----------------------------------------------------
       */

      if (
        pathname === "/data" &&
        req.method === "POST"
      ) {
        const body =
          await readBody(req);

        const data =
          await comlinkPost(
            "/data",
            body
          );

        sendJson(
          res,
          200,
          data
        );

        return;
      }

      /*
       * -----------------------------------------------------
       * 404
       * -----------------------------------------------------
       */

      sendJson(res, 404, {
        ok: false,
        error:
          "Route not found",
      });
    } catch (error) {
      console.error(
        "[SERVER ERROR]",
        error
      );

      sendJson(res, 500, {
        ok: false,
        error:
          error?.message ||
          "Internal server error",
        stack:
          process.env.NODE_ENV ===
          "production"
            ? undefined
            : error?.stack,
      });
    }
  }
);

/* =========================================================
   START
========================================================= */

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
