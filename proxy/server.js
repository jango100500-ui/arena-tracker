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

const GAME_DATA_TTL = 60 * 60 * 1000;
const PORTRAIT_TTL = 6 * 60 * 60 * 1000;

let unitsCache = null;
let unitsLoadedAt = 0;

let portraitCache = null;
let portraitLoadedAt = 0;


// ============================================================
// HTTP
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
      `Invalid JSON: ${text.slice(0, 1000)}`
    );
  }
}


// ============================================================
// NORMALIZE
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


function getBaseId(definitionId) {
  return String(definitionId || "")
    .split(":")[0]
    .trim()
    .toUpperCase();
}


// ============================================================
// COMLINK unitsList
// ============================================================

async function loadUnits() {
  const now = Date.now();

  if (
    unitsCache &&
    now - unitsLoadedAt < GAME_DATA_TTL
  ) {
    return unitsCache;
  }

  console.log(
    "[UNITS] Loading unitsList from Comlink..."
  );

  const payload = {
    collection: "unitsList",
    language: "ENG_US"
  };

  const response = await fetch(
    `${COMLINK_URL}/data`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "Accept":
          "application/json"
      },

      body:
        JSON.stringify(payload)
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Comlink /data ${response.status}: ${text.slice(0, 2000)}`
    );
  }

  let json;

  try {
    json =
      JSON.parse(text);
  } catch {
    throw new Error(
      `Comlink /data returned invalid JSON: ${text.slice(0, 2000)}`
    );
  }

  console.log(
    "[UNITS] Response keys:",
    Object.keys(json)
  );

  let units = [];

  /*
   * Comlink versions могут отдавать
   * коллекцию в разных формах.
   */

  if (Array.isArray(json)) {
    units = json;
  }

  else if (Array.isArray(json.data)) {
    units = json.data;
  }

  else if (
    json.data &&
    typeof json.data === "object"
  ) {
    units =
      Object.values(json.data);
  }

  else if (
    Array.isArray(json.unitsList)
  ) {
    units =
      json.unitsList;
  }

  else if (
    json.unitsList &&
    typeof json.unitsList === "object"
  ) {
    units =
      Object.values(json.unitsList);
  }

  if (!units.length) {
    console.log(
      "[UNITS] Unexpected response:"
    );

    console.log(
      JSON.stringify(json).slice(0, 5000)
    );

    throw new Error(
      "Comlink /data не вернул unitsList"
    );
  }

  const byBaseId =
    new Map();

  const byId =
    new Map();

  const byThumbnail =
    new Map();

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
        String(
          unit.thumbnailName
        ).toUpperCase(),
        unit
      );
    }
  }

  unitsCache = {
    units,
    byBaseId,
    byId,
    byThumbnail
  };

  unitsLoadedAt = now;

  console.log(
    `[UNITS] Loaded ${units.length} units`
  );

  console.log(
    `[UNITS] baseIds: ${byBaseId.size}`
  );

  console.log(
    `[UNITS] thumbnails: ${byThumbnail.size}`
  );

  return unitsCache;
}


// ============================================================
// PORTRAITS
// ============================================================

function decodeFilename(filename) {
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}


function getPortraitName(filename) {
  let name =
    filename
      .replace(
        /^65px-Unit-Character-/i,
        ""
      )
      .replace(
        /-portrait\.png$/i,
        ""
      );

  name =
    decodeFilename(name);

  name =
    name.replace(
      /_/g,
      " "
    );

  return name;
}


function makePortraitUrl(filename) {
  return (
    `${ICONS_RAW_URL}/` +
    encodeURI(filename)
  );
}


async function loadPortraits() {
  const now = Date.now();

  if (
    portraitCache &&
    now - portraitLoadedAt < PORTRAIT_TTL
  ) {
    return portraitCache;
  }

  console.log(
    "[PORTRAITS] Loading GitHub portrait list..."
  );

  const html =
    await fetchText(
      ICONS_REPO_URL
    );

  const files =
    new Set();

  const regex =
    /65px-Unit-Character-[^"'<>]+?-portrait\.png/gi;

  for (
    const match of html.matchAll(regex)
  ) {
    const filename =
      decodeFilename(
        match[0]
      );

    files.add(
      filename
    );
  }

  const portraits =
    [...files]
      .map(
        (filename) => {
          const name =
            getPortraitName(
              filename
            );

          return {
            filename,

            name,

            normalized:
              normalizeText(
                name
              ),

            url:
              makePortraitUrl(
                filename
              )
          };
        }
      )
      .filter(
        (x) =>
          x.normalized
      );

  if (!portraits.length) {
    throw new Error(
      "Не найдено ни одного character portrait"
    );
  }

  portraitCache =
    portraits;

  portraitLoadedAt =
    now;

  console.log(
    `[PORTRAITS] Loaded ${portraits.length} portraits`
  );

  return portraits;
}


// ============================================================
// FIND UNIT
// ============================================================

function findUnit(
  units,
  definitionId
) {
  const baseId =
    getBaseId(
      definitionId
    );

  const fullId =
    String(
      definitionId
    )
      .trim()
      .toUpperCase();

  /*
   * Сначала полный ID.
   */

  let unit =
    units.byId.get(
      fullId
    );

  /*
   * Потом baseId.
   */

  if (!unit) {
    unit =
      units.byBaseId.get(
        baseId
      );
  }

  return unit || null;
}


// ============================================================
// BUILD SEARCH CANDIDATES
// ============================================================

function getCandidates(
  unit,
  baseId
) {
  const result =
    [];

  if (unit) {

    if (unit.baseId) {
      result.push(
        String(
          unit.baseId
        )
      );
    }

    if (unit.nameKey) {
      result.push(
        String(
          unit.nameKey
        )
      );
    }

    if (unit.thumbnailName) {
      result.push(
        String(
          unit.thumbnailName
        )
      );
    }

    if (unit.id) {
      result.push(
        String(
          unit.id
        )
      );
    }
  }

  result.push(
    baseId
  );

  return [
    ...new Set(
      result
        .filter(Boolean)
    )
  ];
}


// ============================================================
// SPECIAL THUMBNAIL NORMALIZATION
// ============================================================

function normalizeThumbnail(
  value
) {
  return normalizeText(
    String(
      value || ""
    )
      .replace(
        /^tex\.charui\./i,
        ""
      )
      .replace(
        /^charui\./i,
        ""
      )
  );
}


// ============================================================
// EXACT MATCH
// ============================================================

function exactMatch(
  portraits,
  unit,
  candidates
) {
  /*
   * thumbnailName — самый важный источник.
   */

  if (
    unit &&
    unit.thumbnailName
  ) {
    const thumbnail =
      normalizeThumbnail(
        unit.thumbnailName
      );

    for (
      const portrait of portraits
    ) {
      const portraitName =
        normalizeText(
          portrait.name
        );

      if (
        portraitName ===
        thumbnail
      ) {
        return {
          portrait,
          method:
            "thumbnail-exact",
          score:
            1000
        };
      }
    }
  }

  /*
   * Затем nameKey / baseId.
   */

  const normalizedCandidates =
    candidates
      .map(
        normalizeText
      )
      .filter(Boolean);

  for (
    const portrait of portraits
  ) {
    if (
      normalizedCandidates.includes(
        portrait.normalized
      )
    ) {
      return {
        portrait,
        method:
          "name-exact",
        score:
          900
      };
    }
  }

  return null;
}


// ============================================================
// FUZZY FALLBACK
// ============================================================

function fuzzyMatch(
  portraits,
  candidates
) {
  const fuse =
    new Fuse(
      portraits,
      {
        keys: [
          {
            name:
              "normalized",
            weight: 1
          },

          {
            name:
              "name",
            weight: 0.5
          }
        ],

        threshold:
          0.18,

        distance:
          100,

        ignoreLocation:
          true,

        includeScore:
          true
      }
    );

  const results =
    [];

  for (
    const candidate of candidates
  ) {
    const query =
      normalizeText(
        candidate
      );

    if (!query) {
      continue;
    }

    const found =
      fuse.search(
        query
      );

    for (
      const result of found
    ) {
      results.push({
        ...result,
        query
      });
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

  return results[0];
}


// ============================================================
// MAIN IMAGE RESOLVER
// ============================================================

async function findCharacterImage(
  unitDefId
) {
  const started =
    Date.now();

  const definitionId =
    String(
      unitDefId || ""
    ).trim();

  if (!definitionId) {
    return {
      image: null,

      debug: {
        method:
          "empty-id"
      }
    };
  }

  const baseId =
    getBaseId(
      definitionId
    );

  const units =
    await loadUnits();

  const portraits =
    await loadPortraits();

  const unit =
    findUnit(
      units,
      definitionId
    );

  const candidates =
    getCandidates(
      unit,
      baseId
    );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `[PORTRAIT] ${definitionId}`
  );

  console.log(
    `[PORTRAIT] baseId: ${baseId}`
  );

  console.log(
    "[PORTRAIT] unit:",
    unit
      ? {
          id:
            unit.id ||
            null,

          baseId:
            unit.baseId ||
            null,

          nameKey:
            unit.nameKey ||
            null,

          thumbnailName:
            unit.thumbnailName ||
            null
        }
      : "NOT FOUND"
  );

  console.log(
    "[PORTRAIT] candidates:",
    candidates
  );

  /*
   * EXACT
   */

  const exact =
    exactMatch(
      portraits,
      unit,
      candidates
    );

  if (exact) {
    console.log(
      `[PORTRAIT] EXACT ✓ ${exact.portrait.filename}`
    );

    return {
      image:
        exact.portrait.url,

      match:
        exact.portrait.name,

      debug: {
        method:
          exact.method,

        score:
          exact.score,

        definitionId,

        baseId,

        unitFound:
          !!unit,

        unit:
          unit
            ? {
                id:
                  unit.id ||
                  null,

                baseId:
                  unit.baseId ||
                  null,

                nameKey:
                  unit.nameKey ||
                  null,

                thumbnailName:
                  unit.thumbnailName ||
                  null
              }
            : null,

        candidates,

        portrait:
          exact.portrait.filename,

        elapsedMs:
          Date.now() -
          started
      }
    };
  }

  /*
   * FUZZY
   */

  const fuzzy =
    fuzzyMatch(
      portraits,
      candidates
    );

  if (fuzzy) {
    console.log(
      `[PORTRAIT] FUZZY ⚠ ${fuzzy.item.filename}`
    );

    return {
      image:
        fuzzy.item.url,

      match:
        fuzzy.item.name,

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

        unit:
          unit
            ? {
                id:
                  unit.id ||
                  null,

                baseId:
                  unit.baseId ||
                  null,

                nameKey:
                  unit.nameKey ||
                  null,

                thumbnailName:
                  unit.thumbnailName ||
                  null
              }
            : null,

        candidates,

        portrait:
          fuzzy.item.filename,

        elapsedMs:
          Date.now() -
          started
      }
    };
  }

  /*
   * NOT FOUND
   */

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

      unit:
        unit
          ? {
              id:
                unit.id ||
                null,

              baseId:
                unit.baseId ||
                null,

              nameKey:
                unit.nameKey ||
                null,

              thumbnailName:
                unit.thumbnailName ||
                null
            }
          : null,

      candidates,

      portraitsAvailable:
        portraits.length,

      elapsedMs:
        Date.now() -
        started
    }
  };
}


// ============================================================
// COMLINK PROXY
// ============================================================

async function proxyToComlink(
  path,
  body
) {
  console.log(
    `[COMLINK] POST ${path}`
  );

  const response =
    await fetch(
      `${COMLINK_URL}${path}`,
      {
        method:
          "POST",

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
// BODY
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
// RESPONSES
// ============================================================

function sendJson(
  res,
  status,
  data
) {
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

  res.end(
    JSON.stringify(data)
  );
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
    async (
      req,
      res
    ) => {
      try {

        // ------------------------------------------------------
        // OPTIONS
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
          url.pathname ===
            "/health" &&
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

              unitsLoaded:
                !!unitsCache,

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
            const units =
              await loadUnits();

            sendJson(
              res,
              200,
              {
                ok: true,

                units:
                  units.units.length,

                baseIds:
                  units.byBaseId.size,

                thumbnails:
                  units.byThumbnail.size,

                cacheAge:
                  Date.now() -
                  unitsLoadedAt
              }
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
                  Date.now() -
                  portraitLoadedAt
              }
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
      `PORT: ${PORT}`
    );

    console.log(
      `COMLINK: ${COMLINK_URL}`
    );

    console.log(
      "UNITS: Comlink /data → unitsList"
    );

    console.log(
      "PORTRAITS: tools4swgoh/swgoh-icons"
    );

    console.log(
      "========================================"
    );
  }
);
