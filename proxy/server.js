import http from "node:http";
import { URL } from "node:url";
import Fuse from "fuse.js";

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  process.env.COMLINK_URL ||
  "https://arena-tracker-2uod.onrender.com";

const GAMEDATA_URL =
  "https://raw.githubusercontent.com/swgoh-utils/gamedata/main";

const ICONS_RAW_URL =
  "https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/main";

const ICONS_REPO_URL =
  "https://github.com/tools4swgoh/swgoh-icons/tree/main";

// Cache
const GAME_DATA_TTL = 60 * 60 * 1000;
const PORTRAIT_TTL = 6 * 60 * 60 * 1000;

let gameDataCache = null;
let gameDataLoadedAt = 0;

let portraitCache = null;
let portraitLoadedAt = 0;


// ============================================================
// HTTP HELPERS
// ============================================================

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,

    headers: {
      "User-Agent": "arena-tracker/1.0",
      ...(options.headers || {})
    }
  });

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
      `Ожидался JSON, но пришло:\n${text.slice(0, 1000)}`
    );
  }
}


// ============================================================
// GAME DATA
// ============================================================
//
// gamedata/units.json имеет структуру:
//
// {
//   "version": "...",
//   "data": [ ... ]
// }
//
// Мы используем именно data.
//
// Это автоматический источник. Никаких ручных персонажей.
// ============================================================

async function loadGameData() {
  const now = Date.now();

  if (
    gameDataCache &&
    now - gameDataLoadedAt < GAME_DATA_TTL
  ) {
    return gameDataCache;
  }

  console.log("[GAMEDATA] loading units.json...");

  const json = await fetchJson(
    `${GAMEDATA_URL}/units.json`
  );

  let units = [];

  if (Array.isArray(json)) {
    units = json;
  } else if (Array.isArray(json.data)) {
    units = json.data;
  } else if (
    json.data &&
    typeof json.data === "object"
  ) {
    units = Object.values(json.data);
  }

  if (!units.length) {
    throw new Error(
      "units.json загрузился, но массив units пуст"
    );
  }

  const byBaseId = new Map();

  const byId = new Map();

  const byThumbnail = new Map();

  for (const unit of units) {
    if (!unit || typeof unit !== "object") {
      continue;
    }

    const baseId =
      unit.baseId ||
      unit.baseID;

    const id =
      unit.id ||
      unit.definitionId;

    const thumbnailName =
      unit.thumbnailName;

    if (baseId) {
      byBaseId.set(
        String(baseId).toUpperCase(),
        unit
      );
    }

    if (id) {
      byId.set(
        String(id).toUpperCase(),
        unit
      );
    }

    if (thumbnailName) {
      byThumbnail.set(
        String(thumbnailName).toUpperCase(),
        unit
      );
    }
  }

  gameDataCache = {
    version: json.version || null,
    units,
    byBaseId,
    byId,
    byThumbnail
  };

  gameDataLoadedAt = now;

  console.log(
    `[GAMEDATA] loaded ${units.length} units`
  );

  console.log(
    `[GAMEDATA] version: ${json.version || "unknown"}`
  );

  return gameDataCache;
}


// ============================================================
// NORMALIZATION
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/%26/gi, "&")
    .replace(/%22/gi, '"')
    .replace(/["'’]/g, "")
    .replace(/[._-]+/g, " ")
    .replace(/[^a-z0-9а-яё&]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}


// ============================================================
// PORTRAIT INDEX
// ============================================================
//
// Репозиторий содержит реальные PNG.
//
// Например:
//
// Captain_Rex
// CT-7567 "Rex"
// Threepio & Chewie
//
// Мы НЕ пишем эти имена вручную.
//
// Список берём из GitHub.
// ============================================================

function decodeGithubFilename(filename) {
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}


function getPortraitDisplayName(filename) {
  let name = filename;

  name = name.replace(
    /^65px-Unit-Character-/i,
    ""
  );

  name = name.replace(
    /-portrait\.png$/i,
    ""
  );

  name = decodeGithubFilename(name);

  name = name.replace(/_/g, " ");

  return name;
}


function isCharacterPortrait(filename) {
  return /^65px-Unit-Character-.+-portrait\.png$/i.test(
    filename
  );
}


function makePortraitUrl(filename) {
  // encodeURI сохраняет / и кодирует пробелы,
  // но не ломает всю строку целиком.
  return (
    `${ICONS_RAW_URL}/` +
    encodeURI(filename)
  );
}


async function loadPortraitIndex() {
  const now = Date.now();

  if (
    portraitCache &&
    now - portraitLoadedAt < PORTRAIT_TTL
  ) {
    return portraitCache;
  }

  console.log("[PORTRAITS] downloading GitHub index...");

  const html = await fetchText(
    ICONS_REPO_URL
  );

  const files = new Set();

  // Ищем PNG непосредственно в HTML GitHub.
  //
  // Не используем GitHub API:
  // оно у Render уже отдавало 403.
  const regex =
    /65px-Unit-Character-[^"'<>]+?-portrait\.png/gi;

  for (const match of html.matchAll(regex)) {
    const filename =
      decodeGithubFilename(match[0]);

    if (
      isCharacterPortrait(filename)
    ) {
      files.add(filename);
    }
  }

  const portraits = [...files]
    .map((filename) => {
      const displayName =
        getPortraitDisplayName(filename);

      return {
        filename,
        displayName,

        normalizedName:
          normalizeText(displayName),

        url:
          makePortraitUrl(filename)
      };
    })
    .filter(
      (portrait) =>
        portrait.normalizedName.length > 0
    );

  if (!portraits.length) {
    throw new Error(
      "GitHub index не содержит character portraits"
    );
  }

  portraitCache = portraits;
  portraitLoadedAt = now;

  console.log(
    `[PORTRAITS] indexed ${portraits.length} portraits`
  );

  return portraits;
}


// ============================================================
// FIND UNIT
// ============================================================

function getBaseId(definitionId) {
  return String(definitionId || "")
    .split(":")[0]
    .trim()
    .toUpperCase();
}


function findUnit(gameData, definitionId) {
  const cleanDefinitionId =
    String(definitionId || "")
      .trim()
      .toUpperCase();

  const baseId =
    getBaseId(cleanDefinitionId);

  // Самый точный вариант:
  // например CAPTAINREX:SEVEN_STAR
  let unit =
    gameData.byId.get(
      cleanDefinitionId
    );

  // Обычно units.json содержит id,
  // но если нет — используем baseId.
  if (!unit) {
    unit =
      gameData.byBaseId.get(
        baseId
      );
  }

  return unit || null;
}


// ============================================================
// UNIT NAME CANDIDATES
// ============================================================

function getUnitNames(unit, baseId) {
  const names = [];

  if (unit) {
    // В units.json nameKey обычно уже
    // человекочитаемое имя.
    if (unit.nameKey) {
      names.push(
        String(unit.nameKey)
      );
    }

    if (unit.baseId) {
      names.push(
        String(unit.baseId)
      );
    }

    if (unit.thumbnailName) {
      names.push(
        String(unit.thumbnailName)
      );
    }

    if (unit.id) {
      names.push(
        String(unit.id)
      );
    }
  }

  // baseId всегда оставляем как fallback.
  if (baseId) {
    names.push(baseId);
  }

  return [
    ...new Set(
      names
        .filter(Boolean)
        .map(String)
    )
  ];
}


// ============================================================
// EXACT PORTRAIT MATCHING
// ============================================================

function exactPortraitMatch(
  portraits,
  names
) {
  const normalizedNames =
    names
      .map(normalizeText)
      .filter(Boolean);

  // ----------------------------------------------------------
  // 1. Полное совпадение имени
  // ----------------------------------------------------------

  for (const portrait of portraits) {
    if (
      normalizedNames.includes(
        portrait.normalizedName
      )
    ) {
      return {
        portrait,
        method: "exact-name",
        score: 1000
      };
    }
  }

  // ----------------------------------------------------------
  // 2. thumbnailName
  //
  // Например:
  // tex.charui_captainrex
  //
  // → captain rex
  // ----------------------------------------------------------

  for (const name of normalizedNames) {
    const compact =
      name
        .replace(/^tex charui /, "")
        .trim();

    if (!compact) {
      continue;
    }

    for (const portrait of portraits) {
      if (
        portrait.normalizedName === compact
      ) {
        return {
          portrait,
          method: "exact-thumbnail",
          score: 950
        };
      }
    }
  }

  return null;
}


// ============================================================
// FUZZY FALLBACK
// ============================================================
//
// Это ТОЛЬКО fallback.
//
// Основной путь выше — exact.
// Поэтому Rex / CT-7567 Rex больше не должны
// случайно меняться местами.
// ============================================================

function fuzzyPortraitMatch(
  portraits,
  names
) {
  const fuse =
    new Fuse(
      portraits,
      {
        keys: [
          {
            name: "normalizedName",
            weight: 1
          },
          {
            name: "displayName",
            weight: 0.5
          }
        ],

        threshold: 0.20,

        distance: 100,

        ignoreLocation: true,

        includeScore: true,

        minMatchCharLength: 3
      }
    );

  const candidates = [];

  for (const name of names) {
    const normalized =
      normalizeText(name);

    if (!normalized) {
      continue;
    }

    const results =
      fuse.search(normalized);

    for (const result of results) {
      candidates.push({
        ...result,
        query: name
      });
    }
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort(
    (a, b) =>
      (a.score ?? 1) -
      (b.score ?? 1)
  );

  return candidates[0];
}


// ============================================================
// CHARACTER IMAGE
// ============================================================

async function findCharacterImage(
  unitDefId
) {
  const started =
    Date.now();

  const definitionId =
    String(unitDefId || "")
      .trim();

  if (!definitionId) {
    return {
      image: null,

      debug: {
        method: "error",
        error: "unitDefId is empty"
      }
    };
  }

  const baseId =
    getBaseId(
      definitionId
    );

  const gameData =
    await loadGameData();

  const portraits =
    await loadPortraitIndex();

  const unit =
    findUnit(
      gameData,
      definitionId
    );

  const names =
    getUnitNames(
      unit,
      baseId
    );

  console.log(
    `[PORTRAIT] ${definitionId}`
  );

  console.log(
    `[PORTRAIT] baseId = ${baseId}`
  );

  console.log(
    `[PORTRAIT] unit =`,
    unit
      ? {
          id: unit.id,
          baseId: unit.baseId,
          nameKey: unit.nameKey,
          thumbnailName:
            unit.thumbnailName
        }
      : "NOT FOUND"
  );

  console.log(
    `[PORTRAIT] candidates =`,
    names
  );

  // ----------------------------------------------------------
  // EXACT
  // ----------------------------------------------------------

  const exact =
    exactPortraitMatch(
      portraits,
      names
    );

  if (exact) {
    console.log(
      `[PORTRAIT] EXACT ✓ ${exact.portrait.filename}`
    );

    return {
      image:
        exact.portrait.url,

      match:
        exact.portrait.displayName,

      debug: {
        method:
          exact.method,

        score:
          exact.score,

        definitionId,

        baseId,

        unitFound:
          !!unit,

        unit: unit
          ? {
              id: unit.id || null,
              baseId:
                unit.baseId || null,
              nameKey:
                unit.nameKey || null,
              thumbnailName:
                unit.thumbnailName || null
            }
          : null,

        candidates:
          names,

        portrait:
          exact.portrait.filename,

        elapsedMs:
          Date.now() - started
      }
    };
  }

  // ----------------------------------------------------------
  // FUZZY FALLBACK
  // ----------------------------------------------------------

  const fuzzy =
    fuzzyPortraitMatch(
      portraits,
      names
    );

  if (fuzzy) {
    console.log(
      `[PORTRAIT] FUZZY ⚠ ${fuzzy.item.filename}`
    );

    return {
      image:
        fuzzy.item.url,

      match:
        fuzzy.item.displayName,

      debug: {
        method:
          "fuzzy-fallback",

        score:
          fuzzy.score,

        query:
          fuzzy.query,

        definitionId,

        baseId,

        unitFound:
          !!unit,

        unit: unit
          ? {
              id: unit.id || null,
              baseId:
                unit.baseId || null,
              nameKey:
                unit.nameKey || null,
              thumbnailName:
                unit.thumbnailName || null
            }
          : null,

        candidates:
          names,

        portrait:
          fuzzy.item.filename,

        elapsedMs:
          Date.now() - started
      }
    };
  }

  // ----------------------------------------------------------
  // NOT FOUND
  // ----------------------------------------------------------

  console.log(
    `[PORTRAIT] NOT FOUND ✗ ${definitionId}`
  );

  return {
    image: null,

    match: null,

    debug: {
      method:
        "not-found",

      definitionId,

      baseId,

      unitFound:
        !!unit,

      unit: unit
        ? {
            id: unit.id || null,
            baseId:
              unit.baseId || null,
            nameKey:
              unit.nameKey || null,
            thumbnailName:
              unit.thumbnailName || null
          }
        : null,

      candidates:
        names,

      portraitsAvailable:
        portraits.length,

      elapsedMs:
        Date.now() - started
    }
  };
}


// ============================================================
// COMLINK
// ============================================================

async function proxyToComlink(
  path,
  body
) {
  const url =
    `${COMLINK_URL}${path}`;

  console.log(
    `[COMLINK] POST ${path}`
  );

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Accept":
            "application/json"
        },

        body:
          JSON.stringify(body)
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Comlink ${response.status}: ${text.slice(0, 2000)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Comlink returned invalid JSON: ${text.slice(0, 2000)}`
    );
  }
}


// ============================================================
// COMLINK GAME DATA DEBUG
// ============================================================
//
// Оставляем endpoint, чтобы можно было проверить,
// что units.json реально загружается.
// ============================================================

async function getGameDataStatus() {
  const data =
    await loadGameData();

  return {
    ok: true,

    version:
      data.version,

    units:
      data.units.length,

    baseIds:
      data.byBaseId.size,

    ids:
      data.byId.size,

    thumbnails:
      data.byThumbnail.size,

    cacheAge:
      Date.now() -
      gameDataLoadedAt
  };
}


async function getPortraitStatus() {
  const portraits =
    await loadPortraitIndex();

  return {
    ok: true,

    portraits:
      portraits.length,

    cacheAge:
      Date.now() -
      portraitLoadedAt
  };
}


// ============================================================
// REQUEST BODY
// ============================================================

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        (chunk) => {
          body += chunk;

          if (
            body.length >
            2_000_000
          ) {
            reject(
              new Error(
                "Request body too large"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
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


// ============================================================
// RESPONSE
// ============================================================

function sendJson(
  res,
  status,
  data
) {
  const payload =
    JSON.stringify(data);

  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS",

      "Access-Control-Allow-Headers":
        "Content-Type",

      "Cache-Control":
        "no-store"
    }
  );

  res.end(payload);
}


function sendText(
  res,
  status,
  text
) {
  res.writeHead(
    status,
    {
      "Content-Type":
        "text/plain; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*"
    }
  );

  res.end(text);
}


// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {
      try {

        // ------------------------------------------------------
        // CORS PREFLIGHT
        // ------------------------------------------------------

        if (
          req.method ===
          "OPTIONS"
        ) {
          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET, POST, OPTIONS",

              "Access-Control-Allow-Headers":
                "Content-Type"
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


        // ------------------------------------------------------
        // ROOT
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


        // ------------------------------------------------------
        // HEALTH
        // ------------------------------------------------------

        if (
          url.pathname === "/health" &&
          req.method === "GET"
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

              gameDataLoaded:
                !!gameDataCache,

              portraitsLoaded:
                !!portraitCache
            }
          );

          return;
        }


        // ------------------------------------------------------
        // GAME DATA STATUS
        // ------------------------------------------------------

        if (
          url.pathname ===
            "/gameDataStatus" &&
          req.method === "GET"
        ) {
          try {
            const status =
              await getGameDataStatus();

            sendJson(
              res,
              200,
              status
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                ok: false,

                error:
                  error.message,

                stack:
                  error.stack
              }
            );
          }

          return;
        }


        // ------------------------------------------------------
        // PORTRAIT STATUS
        // ------------------------------------------------------

        if (
          url.pathname ===
            "/portraitStatus" &&
          req.method === "GET"
        ) {
          try {
            const status =
              await getPortraitStatus();

            sendJson(
              res,
              200,
              status
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                ok: false,

                error:
                  error.message,

                stack:
                  error.stack
              }
            );
          }

          return;
        }


        // ------------------------------------------------------
        // CHARACTER IMAGE
        // ------------------------------------------------------

        if (
          url.pathname ===
            "/characterImage" &&
          req.method === "POST"
        ) {
          const body =
            await readBody(req);

          const unitDefId =
            body.unitDefId ||
            body.definitionId ||
            body.defId;

          try {
            const result =
              await findCharacterImage(
                unitDefId
              );

            sendJson(
              res,
              200,
              {
                unitDefId,
                ...result
              }
            );
          } catch (error) {
            console.error(
              "[PORTRAIT ERROR]",
              error
            );

            sendJson(
              res,
              500,
              {
                unitDefId,

                image: null,

                error:
                  error.message,

                debug: {
                  stack:
                    error.stack
                }
              }
            );
          }

          return;
        }


        // ------------------------------------------------------
        // PLAYER ARENA
        // ------------------------------------------------------

        if (
          url.pathname ===
            "/playerArena" &&
          req.method === "POST"
        ) {
          const body =
            await readBody(req);

          const data =
            await proxyToComlink(
              "/playerArena",
              body
            );

          sendJson(
            res,
            200,
            data
          );

          return;
        }


        // ------------------------------------------------------
        // PLAYER
        // ------------------------------------------------------

        if (
          url.pathname ===
            "/player" &&
          req.method === "POST"
        ) {
          const body =
            await readBody(req);

          const data =
            await proxyToComlink(
              "/player",
              body
            );

          sendJson(
            res,
            200,
            data
          );

          return;
        }


        // ------------------------------------------------------
        // 404
        // ------------------------------------------------------

        sendJson(
          res,
          404,
          {
            error:
              "Not found"
          }
        );

      } catch (error) {
        console.error(
          "[SERVER ERROR]",
          error
        );

        sendJson(
          res,
          500,
          {
            error:
              error.message,

            stack:
              error.stack
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
      "========================================"
    );

    console.log(
      "ARENA TRACKER PROXY"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Comlink: ${COMLINK_URL}`
    );

    console.log(
      "Game data: swgoh-utils/gamedata"
    );

    console.log(
      "Portraits: tools4swgoh/swgoh-icons"
    );

    console.log(
      "========================================"
    );
  }
);
