import http from "node:http";
import { URL } from "node:url";
import Fuse from "fuse.js";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  process.env.COMLINK_URL ||
  "https://arena-tracker-2uod.onrender.com";

const ICONS_REPO_API =
  "https://api.github.com/repos/tools4swgoh/swgoh-icons/contents";

const ICONS_RAW_URL =
  "https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/main";

const GAMEDATA_REPO_API =
  "https://api.github.com/repos/swgoh-utils/gamedata";

const GAMEDATA_RAW_URL =
  "https://raw.githubusercontent.com/swgoh-utils/gamedata/main";

const CACHE_TTL = 6 * 60 * 60 * 1000;

// ============================================================
// CACHE
// ============================================================

let portraitsCache = null;
let portraitsCacheTime = 0;
let portraitFuse = null;

let unitsCache = null;
let unitsCacheTime = 0;

let gameDataSource = null;

// ============================================================
// HTTP HELPERS
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
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 1500)}`
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
      `Invalid JSON from ${url}: ${text.slice(0, 1500)}`
    );
  }
}

// ============================================================
// NORMALIZATION
// ============================================================

function normalizeName(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function cleanUnitDefId(unitDefId) {
  if (!unitDefId) {
    return "";
  }

  return String(unitDefId)
    .replace(/:SEVEN_STAR$/i, "")
    .replace(/:SIX_STAR$/i, "")
    .replace(/:FIVE_STAR$/i, "")
    .replace(/:FOUR_STAR$/i, "")
    .replace(/:THREE_STAR$/i, "")
    .replace(/:TWO_STAR$/i, "")
    .replace(/:ONE_STAR$/i, "")
    .replace(/:BASE$/i, "");
}

// ============================================================
// GITHUB API
// ============================================================

async function githubApi(path) {
  return await fetchJson(
    `https://api.github.com${path}`,
    {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "arena-tracker"
      }
    }
  );
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

  console.log(
    "Loading character portraits from swgoh-icons..."
  );

  const files = await githubApi(
    "/repos/tools4swgoh/swgoh-icons/contents"
  );

  if (!Array.isArray(files)) {
    throw new Error(
      "swgoh-icons GitHub API did not return a file list"
    );
  }

  const portraits = [];

  for (const file of files) {
    if (!file || file.type !== "file") {
      continue;
    }

    const filename = file.name || "";

    if (
      !filename.startsWith(
        "65px-Unit-Character-"
      )
    ) {
      continue;
    }

    if (
      !filename.endsWith(
        "-portrait.png"
      )
    ) {
      continue;
    }

    const characterName =
      filename
        .replace(
          /^65px-Unit-Character-/i,
          ""
        )
        .replace(
          /-portrait\.png$/i,
          ""
        );

    portraits.push({
      filename,

      name: characterName,

      normalized:
        normalizeName(characterName),

      image:
        `${ICONS_RAW_URL}/${encodeURIComponent(filename)}`
    });
  }

  const unique = [];
  const seen = new Set();

  for (const portrait of portraits) {
    if (seen.has(portrait.filename)) {
      continue;
    }

    seen.add(portrait.filename);
    unique.push(portrait);
  }

  if (!unique.length) {
    throw new Error(
      "No character portraits were found in swgoh-icons"
    );
  }

  portraitsCache = unique;
  portraitsCacheTime = Date.now();

  portraitFuse = new Fuse(
    portraitsCache,
    {
      keys: [
        "name",
        "normalized"
      ],

      includeScore: true,

      threshold: 0.35,

      ignoreLocation: true
    }
  );

  console.log(
    `Portraits loaded: ${portraitsCache.length}`
  );

  return portraitsCache;
}

// ============================================================
// GAMEDATA DISCOVERY
// ============================================================

async function discoverGameDataFiles() {
  console.log(
    "Discovering gamedata files..."
  );

  const tree = await githubApi(
    "/repos/swgoh-utils/gamedata/git/trees/main?recursive=1"
  );

  if (
    !tree ||
    !Array.isArray(tree.tree)
  ) {
    throw new Error(
      "Could not read gamedata repository tree"
    );
  }

  const files =
    tree.tree
      .filter(
        item =>
          item.type === "blob"
      )
      .map(
        item =>
          item.path
      );

  return files;
}

// ============================================================
// FIND UNIT DATA SOURCE
// ============================================================

async function findUnitsDataSource() {
  const files =
    await discoverGameDataFiles();

  // Preferred exact files.
  const exactCandidates = [
    "units.json",
    "unitsList.json",
    "unitsList",
    "data/units.json",
    "gameData/units.json",
    "gameDataItems.json"
  ];

  for (const candidate of exactCandidates) {
    if (files.includes(candidate)) {
      return candidate;
    }
  }

  // Look for files with "unit" in the name.
  const unitFiles =
    files.filter(file =>
      /(^|\/)units?(List)?\.json$/i.test(
        file
      )
    );

  if (unitFiles.length) {
    return unitFiles[0];
  }

  // Broader fallback.
  const fallback =
    files.find(file =>
      /unit.*\.json$/i.test(file)
    );

  if (fallback) {
    return fallback;
  }

  throw new Error(
    "Could not automatically locate a units data file in swgoh-utils/gamedata"
  );
}

// ============================================================
// EXTRACT UNITS FROM ANY KNOWN GAMEDATA SHAPE
// ============================================================

function extractUnits(value) {
  if (!value) {
    return null;
  }

  // Direct array.
  if (Array.isArray(value)) {
    return value;
  }

  // Common wrappers.
  const possibleKeys = [
    "units",
    "unitsList",
    "UnitDefinitions",
    "unitDefinitions",
    "data"
  ];

  for (const key of possibleKeys) {
    if (
      value &&
      Object.prototype.hasOwnProperty.call(
        value,
        key
      )
    ) {
      const result =
        extractUnits(value[key]);

      if (result) {
        return result;
      }
    }
  }

  // Object map: { BASE_ID: {...} }
  if (
    typeof value === "object"
  ) {
    const entries =
      Object.entries(value);

    const likelyUnits =
      entries.filter(
        ([key, item]) =>
          item &&
          typeof item === "object" &&
          (
            item.baseId ||
            item.thumbnailName ||
            item.unitId
          )
      );

    if (likelyUnits.length) {
      return likelyUnits.map(
        ([key, item]) => ({
          ...item,

          baseId:
            item.baseId ||
            key
        })
      );
    }
  }

  return null;
}

// ============================================================
// LOAD GAMEDATA
// ============================================================

async function loadUnits() {
  if (
    unitsCache &&
    Date.now() - unitsCacheTime < CACHE_TTL
  ) {
    return unitsCache;
  }

  console.log(
    "Loading global unit database..."
  );

  const source =
    await findUnitsDataSource();

  console.log(
    "Selected gamedata source:",
    source
  );

  const url =
    `${GAMEDATA_RAW_URL}/${source
      .split("/")
      .map(
        part =>
          encodeURIComponent(part)
      )
      .join("/")}`;

  console.log(
    "Downloading:",
    url
  );

  const json =
    await fetchJson(url);

  const units =
    extractUnits(json);

  if (
    !units ||
    !units.length
  ) {
    throw new Error(
      `Found ${source}, but could not extract units from it`
    );
  }

  console.log(
    `Global units loaded: ${units.length}`
  );

  unitsCache = units;
  unitsCacheTime = Date.now();
  gameDataSource = source;

  return units;
}

// ============================================================
// BUILD UNIT INDEX
// ============================================================

async function buildUnitIndex() {
  const units =
    await loadUnits();

  const byBaseId = new Map();
  const byId = new Map();
  const byThumbnail = new Map();

  for (const unit of units) {
    if (
      !unit ||
      typeof unit !== "object"
    ) {
      continue;
    }

    if (unit.baseId) {
      byBaseId.set(
        String(
          unit.baseId
        ).toUpperCase(),
        unit
      );
    }

    if (unit.id) {
      byId.set(
        String(
          unit.id
        ).toUpperCase(),
        unit
      );
    }

    if (unit.thumbnailName) {
      byThumbnail.set(
        normalizeName(
          unit.thumbnailName
        ),
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
// PORTRAIT CANDIDATES
// ============================================================

function createPortraitCandidates(
  unitDefId,
  unit
) {
  const candidates = [];

  const baseId =
    cleanUnitDefId(
      unitDefId
    );

  if (unitDefId) {
    candidates.push(
      String(unitDefId)
    );
  }

  if (baseId) {
    candidates.push(baseId);
  }

  if (unit) {
    if (unit.baseId) {
      candidates.push(
        String(unit.baseId)
      );
    }

    if (unit.id) {
      candidates.push(
        String(unit.id)
      );
    }

    if (unit.thumbnailName) {
      candidates.push(
        String(
          unit.thumbnailName
        )
      );
    }

    if (unit.nameKey) {
      candidates.push(
        String(
          unit.nameKey
        )
      );
    }

    if (unit.descKey) {
      candidates.push(
        String(
          unit.descKey
        )
      );
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

// ============================================================
// EXACT PORTRAIT MATCH
// ============================================================

function findExactPortrait(
  candidates,
  portraits
) {
  const normalized =
    candidates
      .map(
        normalizeName
      )
      .filter(Boolean);

  for (
    const candidate of normalized
  ) {
    const exact =
      portraits.find(
        portrait =>
          portrait.normalized ===
          candidate
      );

    if (exact) {
      return {
        portrait: exact,
        method:
          "exact-normalized",
        score: 0
      };
    }
  }

  // Partial normalized matching.
  for (
    const candidate of normalized
  ) {
    const partial =
      portraits.find(
        portrait => {
          const name =
            portrait.normalized;

          return (
            name === candidate ||
            name.includes(
              candidate
            ) ||
            candidate.includes(
              name
            )
          );
        }
      );

    if (partial) {
      return {
        portrait: partial,
        method:
          "partial-normalized",
        score: 0.1
      };
    }
  }

  return null;
}

// ============================================================
// FUZZY PORTRAIT MATCH
// ============================================================

function findFuzzyPortrait(
  candidates
) {
  if (!portraitFuse) {
    return null;
  }

  const results = [];

  for (
    const candidate of candidates
  ) {
    if (!candidate) {
      continue;
    }

    const matches =
      portraitFuse.search(
        String(candidate)
      );

    for (
      const match of matches
    ) {
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

  const best =
    results[0];

  if (
    !best ||
    !best.item
  ) {
    return null;
  }

  return {
    portrait:
      best.item,

    method: "fuzzy",

    score:
      best.score
  };
}

// ============================================================
// RESOLVE CHARACTER IMAGE
// ============================================================

async function findCharacterImage(
  unitDefId
) {
  const portraits =
    await loadPortraits();

  const index =
    await buildUnitIndex();

  const cleanId =
    cleanUnitDefId(
      unitDefId
    );

  const upperId =
    String(
      unitDefId || ""
    ).toUpperCase();

  const upperCleanId =
    cleanId.toUpperCase();

  let unit =
    index.byId.get(
      upperId
    ) ||
    index.byBaseId.get(
      upperCleanId
    );

  // Fallback scan.
  if (!unit) {
    unit =
      index.units.find(
        candidate => {
          if (!candidate) {
            return false;
          }

          const candidateBase =
            String(
              candidate.baseId ||
              ""
            ).toUpperCase();

          const candidateId =
            String(
              candidate.id ||
              ""
            ).toUpperCase();

          return (
            candidateBase ===
              upperCleanId ||
            candidateId ===
              upperId
          );
        }
      );
  }

  const candidates =
    createPortraitCandidates(
      unitDefId,
      unit
    );

  console.log(
    "======================================"
  );

  console.log(
    "Portrait lookup:",
    unitDefId
  );

  console.log(
    "Resolved unit:",
    unit
      ? {
          baseId:
            unit.baseId,

          id:
            unit.id,

          thumbnailName:
            unit.thumbnailName,

          nameKey:
            unit.nameKey
        }
      : null
  );

  console.log(
    "Candidates:",
    candidates
  );

  // Exact.
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

      unit:
        unit
          ? {
              baseId:
                unit.baseId,

              id:
                unit.id,

              thumbnailName:
                unit.thumbnailName,

              nameKey:
                unit.nameKey
            }
          : null,

      candidates
    };
  }

  // Fuzzy.
  const fuzzy =
    findFuzzyPortrait(
      candidates
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

      unit:
        unit
          ? {
              baseId:
                unit.baseId,

              id:
                unit.id,

              thumbnailName:
                unit.thumbnailName,

              nameKey:
                unit.nameKey
            }
          : null,

      candidates
    };
  }

  return {
    ok: false,

    error:
      "IMAGE_NOT_FOUND",

    unitDefId,

    cleanId,

    unit:
      unit
        ? {
            baseId:
              unit.baseId,

            id:
              unit.id,

            thumbnailName:
              unit.thumbnailName,

            nameKey:
              unit.nameKey
          }
        : null,

    candidates,

    portraitCount:
      portraits.length,

    gameDataSource:
      gameDataSource
  };
}

// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {
      try {
        // ----------------------------------------------------
        // CORS
        // ----------------------------------------------------

        if (
          req.method ===
          "OPTIONS"
        ) {
          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "Content-Type",

              "Access-Control-Allow-Methods":
                "GET,POST,OPTIONS"
            }
          );

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

        // ----------------------------------------------------
        // HEALTH
        // ----------------------------------------------------

        if (
          pathname ===
            "/health" &&
          req.method ===
            "GET"
        ) {
          sendJson(
            res,
            200,
            {
              ok: true,

              service:
                "arena-tracker-proxy",

              comlink:
                COMLINK_URL,

              time:
                new Date()
                  .toISOString()
            }
          );

          return;
        }

        // ----------------------------------------------------
        // PORTRAIT STATUS
        // ----------------------------------------------------

        if (
          pathname ===
            "/portraitStatus" &&
          req.method ===
            "GET"
        ) {
          const portraits =
            await loadPortraits();

          sendJson(
            res,
            200,
            {
              ok: true,

              portraits:
                portraits.length,

              cacheAge:
                portraitsCacheTime
                  ? Math.floor(
                      (
                        Date.now() -
                        portraitsCacheTime
                      ) / 1000
                    )
                  : null
            }
          );

          return;
        }

        // ----------------------------------------------------
        // GAME DATA STATUS
        // ----------------------------------------------------

        if (
          pathname ===
            "/gameDataStatus" &&
          req.method ===
            "GET"
        ) {
          const units =
            await loadUnits();

          sendJson(
            res,
            200,
            {
              ok: true,

              units:
                units.length,

              source:
                gameDataSource,

              cacheAge:
                unitsCacheTime
                  ? Math.floor(
                      (
                        Date.now() -
                        unitsCacheTime
                      ) / 1000
                    )
                  : null,

              sample:
                units
                  .slice(0, 5)
                  .map(
                    unit => ({
                      baseId:
                        unit.baseId,

                      id:
                        unit.id,

                      thumbnailName:
                        unit.thumbnailName,

                      nameKey:
                        unit.nameKey
                    })
                  )
            }
          );

          return;
        }

        // ----------------------------------------------------
        // CHARACTER IMAGE
        // ----------------------------------------------------

        if (
          pathname ===
            "/characterImage" &&
          req.method ===
            "POST"
        ) {
          const body =
            await readJsonBody(
              req
            );

          const unitDefId =
            body.unitDefId;

          if (!unitDefId) {
            sendJson(
              res,
              400,
              {
                ok: false,

                error:
                  "unitDefId is required"
              }
            );

            return;
          }

          const result =
            await findCharacterImage(
              unitDefId
            );

          sendJson(
            res,
            200,
            result
          );

          return;
        }

        // ----------------------------------------------------
        // PLAYER ARENA
        // ----------------------------------------------------

        if (
          pathname ===
            "/playerArena" &&
          req.method ===
            "POST"
        ) {
          const body =
            await readJsonBody(
              req
            );

          const allyCode =
            body.allyCode;

          if (!allyCode) {
            sendJson(
              res,
              400,
              {
                ok: false,

                error:
                  "allyCode is required"
              }
            );

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

                body:
                  JSON.stringify({
                    allyCode:
                      String(
                        allyCode
                      )
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
              `Invalid JSON from /playerArena: ${text.slice(0, 1500)}`
            );
          }

          sendJson(
            res,
            200,
            json
          );

          return;
        }

        // ----------------------------------------------------
        // PLAYER
        // ----------------------------------------------------

        if (
          pathname ===
            "/player" &&
          req.method ===
            "POST"
        ) {
          const body =
            await readJsonBody(
              req
            );

          const allyCode =
            body.allyCode;

          if (!allyCode) {
            sendJson(
              res,
              400,
              {
                ok: false,

                error:
                  "allyCode is required"
              }
            );

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

                body:
                  JSON.stringify({
                    allyCode:
                      String(
                        allyCode
                      )
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
              `Invalid JSON from /player: ${text.slice(0, 1500)}`
            );
          }

          sendJson(
            res,
            200,
            json
          );

          return;
        }

        // ----------------------------------------------------
        // RAW COMLINK DATA
        // ----------------------------------------------------
        // Kept only for debugging.
        // Character lookup does NOT use this endpoint.

        if (
          pathname ===
            "/data" &&
          req.method ===
            "POST"
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

        // ----------------------------------------------------
        // 404
        // ----------------------------------------------------

        sendJson(
          res,
          404,
          {
            ok: false,

            error:
              "Not found",

            path:
              pathname
          }
        );
      } catch (error) {
        console.error(
          "SERVER ERROR:",
          error
        );

        sendJson(
          res,
          500,
          {
            ok: false,

            error:
              error?.message ||
              String(error),

            stack:
              error?.stack ||
              null
          }
        );
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

    console.log(
      "Character lookup: GitHub gamedata + swgoh-icons"
    );
  }
);
