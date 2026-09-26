import http from "http";
import { brotliDecompressSync } from "zlib";
import Fuse from "fuse.js";

const PORT = process.env.PORT || 3000;

const COMLINK_URL =
  process.env.COMLINK_URL ||
  "https://arena-tracker-2uod.onrender.com";

const GITHUB_API =
  "https://api.github.com/repos/tools4swgoh/swgoh-icons/git/trees/main?recursive=1";

const GAMEDATA_VERSIONS_URL =
  "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/allVersions.json";

const PORTRAIT_BASE_URL =
  "https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/main/65px";

let portraitIndex = [];
let portraitFuse = null;

let unitsData = null;
let unitsFuse = null;

let portraitCacheTime = 0;
let gameDataCacheTime = 0;

const SPECIAL_ALIASES = {
  C3POCHEWBACCA: [
    "Threepio & Chewie",
    "ThreepioandChewie",
    "Threepio_Chewie",
    "Threepio Chewie",
  ],

  R2D2_LEGENDARY: [
    "R2-D2",
    "R2D2",
  ],

  CAPTAINREX: [
    "Captain Rex",
    'CT-7567 "Rex"',
    "CT-7567 Rex",
    "CT7567 Rex",
  ],

  CAPTAINDROGAN: [
    "Captain Drogan",
  ],

  GLLEIA: [
    "GL Leia",
    "Leia",
    "Leia Organa",
  ],
};


// ------------------------------------------------------------
// HTTP HELPERS
// ------------------------------------------------------------

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });

  res.end(body);
}


function text(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });

  res.end(data);
}


async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}


// ------------------------------------------------------------
// COMLINK
// ------------------------------------------------------------

async function comlinkPost(path, body) {
  const url = `${COMLINK_URL}${path}`;

  console.log("--------------------------------------------------");
  console.log("COMLINK REQUEST");
  console.log(url);
  console.log(JSON.stringify(body, null, 2));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const contentType =
    response.headers.get("content-type") || "";

  let data;

  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      data = await response.text();
    }
  } else {
    data = await response.text();
  }

  console.log("COMLINK RESPONSE STATUS:", response.status);
  console.log(
    "COMLINK RESPONSE:",
    typeof data === "string"
      ? data
      : JSON.stringify(data, null, 2)
  );

  console.log("--------------------------------------------------");

  if (response.status < 200 || response.status >= 300) {
    const errorText =
      typeof data === "string"
        ? data
        : JSON.stringify(data);

    const error = new Error(
      `Comlink ${path} -> ${response.status}: ${errorText}`
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
}


// ------------------------------------------------------------
// PLAYER ARENA
// ------------------------------------------------------------

async function getPlayerArena(payload) {
  const allyCode =
    payload?.allyCode ??
    payload?.allycode;

  if (!allyCode) {
    throw new Error("allyCode is required");
  }

  return await comlinkPost(
    "/playerArena",
    {
      payload: {
        allyCode: String(allyCode),
        playerDetailsOnly: false,
      },
    }
  );
}


// ------------------------------------------------------------
// PLAYER
// ------------------------------------------------------------

async function getPlayer(payload) {
  const allyCode =
    payload?.allyCode ??
    payload?.allycode;

  if (!allyCode) {
    throw new Error("allyCode is required");
  }

  return await comlinkPost(
    "/player",
    {
      payload: {
        allyCode: String(allyCode),
      },
    }
  );
}


// ------------------------------------------------------------
// GITHUB FETCH
// ------------------------------------------------------------

async function githubFetch(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "arena-tracker",
      "Accept": "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub ${response.status}: ${await response.text()}`
    );
  }

  return response;
}


// ------------------------------------------------------------
// PORTRAIT INDEX
// ------------------------------------------------------------

async function loadPortraitIndex(force = false) {
  if (
    !force &&
    portraitIndex.length &&
    Date.now() - portraitCacheTime < 6 * 60 * 60 * 1000
  ) {
    return;
  }

  console.log("Loading portrait index...");

  const response = await githubFetch(GITHUB_API);
  const data = await response.json();

  const files = [];

  for (const item of data.tree || []) {
    if (
      item.type === "blob" &&
      item.path &&
      item.path.toLowerCase().endsWith(".png")
    ) {
      files.push(item.path);
    }
  }

  portraitIndex = files
    .filter(path => path.includes("portrait"))
    .map(path => {
      const filename =
        path.split("/").pop();

      const withoutExtension =
        filename.replace(/\.png$/i, "");

      return {
        path,
        filename,
        name: withoutExtension,
        url:
          "https://raw.githubusercontent.com/" +
          "tools4swgoh/swgoh-icons/main/" +
          path,
      };
    });

  portraitFuse = new Fuse(
    portraitIndex,
    {
      keys: [
        "name",
        "filename",
      ],
      threshold: 0.35,
      ignoreLocation: true,
    }
  );

  portraitCacheTime = Date.now();

  console.log(
    `Portraits loaded: ${portraitIndex.length}`
  );
}


// ------------------------------------------------------------
// GAME DATA / UNITS
// ------------------------------------------------------------

async function loadUnitsData(force = false) {
  if (
    !force &&
    unitsData &&
    Date.now() - gameDataCacheTime <
      6 * 60 * 60 * 1000
  ) {
    return;
  }

  console.log("Loading SWGOH game data...");

  const versionsResponse =
    await githubFetch(GAMEDATA_VERSIONS_URL);

  const versions =
    await versionsResponse.json();

  let versionEntry = null;

  if (Array.isArray(versions)) {
    versionEntry = versions[0];
  } else if (versions && typeof versions === "object") {
    const keys = Object.keys(versions);

    if (keys.length) {
      versionEntry = versions[keys[keys.length - 1]];
    }
  }

  if (!versionEntry) {
    throw new Error(
      "Could not determine gamedata version"
    );
  }

  let unitsUrl = null;

  if (
    typeof versionEntry === "object" &&
    versionEntry !== null
  ) {
    if (versionEntry.units) {
      unitsUrl = versionEntry.units;
    }

    if (
      versionEntry.files &&
      versionEntry.files.units
    ) {
      unitsUrl =
        versionEntry.files.units;
    }

    if (
      versionEntry.urls &&
      versionEntry.urls.units
    ) {
      unitsUrl =
        versionEntry.urls.units;
    }
  }

  if (!unitsUrl) {
    unitsUrl =
      "https://raw.githubusercontent.com/" +
      "swgoh-utils/gamedata/main/units.json.br";
  }

  if (
    unitsUrl.startsWith("/") ||
    !unitsUrl.startsWith("http")
  ) {
    unitsUrl =
      "https://raw.githubusercontent.com/" +
      "swgoh-utils/gamedata/main/" +
      unitsUrl.replace(/^\/+/, "");
  }

  console.log("Units URL:", unitsUrl);

  const response =
    await githubFetch(unitsUrl);

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  let parsed;

  try {
    const decompressed =
      brotliDecompressSync(buffer);

    parsed =
      JSON.parse(
        decompressed.toString("utf8")
      );
  } catch {
    try {
      parsed =
        JSON.parse(
          buffer.toString("utf8")
        );
    } catch (error) {
      throw new Error(
        "Unable to parse units data"
      );
    }
  }

  unitsData = parsed;

  const entries = [];

  if (Array.isArray(parsed)) {
    for (const unit of parsed) {
      entries.push(unit);
    }
  } else if (
    parsed &&
    typeof parsed === "object"
  ) {
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object"
      ) {
        entries.push({
          ...value,
          __key: key,
        });
      }
    }
  }

  unitsFuse = new Fuse(
    entries,
    {
      keys: [
        "baseId",
        "name",
        "id",
        "unitDefId",
        "__key",
      ],
      threshold: 0.3,
      ignoreLocation: true,
    }
  );

  gameDataCacheTime = Date.now();

  console.log(
    `Game data loaded: ${entries.length} units`
  );
}


// ------------------------------------------------------------
// NORMALIZATION
// ------------------------------------------------------------

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/%22/g, "")
    .replace(/%26/g, "&")
    .replace(/[_-]/g, " ")
    .replace(/[^a-z0-9а-яё& ]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}


function cleanUnitDefId(unitDefId) {
  return String(unitDefId || "")
    .split(":")[0]
    .trim();
}


// ------------------------------------------------------------
// PORTRAIT MATCHING
// ------------------------------------------------------------

function exactPortraitMatch(
  candidate
) {
  if (!candidate) {
    return null;
  }

  const normalized =
    normalizeName(candidate);

  for (const portrait of portraitIndex) {
    const name =
      normalizeName(
        portrait.name
      );

    if (name === normalized) {
      return portrait;
    }
  }

  return null;
}


function searchPortrait(
  unitDefId
) {
  if (!portraitFuse) {
    return null;
  }

  const baseId =
    cleanUnitDefId(unitDefId);

  const aliases =
    SPECIAL_ALIASES[baseId] || [];

  const candidates = [
    baseId,
    ...aliases,
  ];

  // Exact matching first
  for (const candidate of candidates) {
    const exact =
      exactPortraitMatch(candidate);

    if (exact) {
      return exact;
    }
  }

  // Fuzzy matching
  for (const candidate of candidates) {
    const results =
      portraitFuse.search(candidate);

    if (results.length) {
      return results[0].item;
    }
  }

  return null;
}


// ------------------------------------------------------------
// CHARACTER IMAGE
// ------------------------------------------------------------

async function getCharacterImage(
  unitDefId
) {
  await loadPortraitIndex();

  const portrait =
    searchPortrait(unitDefId);

  if (!portrait) {
    return {
      ok: false,
      unitDefId,
      url: null,
      error: "Portrait not found",
    };
  }

  return {
    ok: true,
    unitDefId,
    filename: portrait.filename,
    url: portrait.url,
  };
}


// ------------------------------------------------------------
// ROUTER
// ------------------------------------------------------------

async function handleRequest(
  req,
  res
) {
  const url =
    new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type",
      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS",
    });

    res.end();
    return;
  }


  // ----------------------------------------------------------
  // HEALTH
  // ----------------------------------------------------------

  if (
    req.method === "GET" &&
    url.pathname === "/health"
  ) {
    json(res, 200, {
      ok: true,
      service: "arena-tracker-proxy",
      time: new Date().toISOString(),
    });

    return;
  }


  // ----------------------------------------------------------
  // PORTRAIT STATUS
  // ----------------------------------------------------------

  if (
    req.method === "GET" &&
    url.pathname === "/portraitStatus"
  ) {
    try {
      await loadPortraitIndex();

      json(res, 200, {
        ok: true,
        portraits:
          portraitIndex.length,
        cacheAge:
          Math.floor(
            (Date.now() -
              portraitCacheTime) /
              1000
          ),
      });
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: error.message,
      });
    }

    return;
  }


  // ----------------------------------------------------------
  // GAME DATA STATUS
  // ----------------------------------------------------------

  if (
    req.method === "GET" &&
    url.pathname === "/gameDataStatus"
  ) {
    try {
      await loadUnitsData();

      json(res, 200, {
        ok: true,
        loaded: !!unitsData,
        cacheAge:
          Math.floor(
            (Date.now() -
              gameDataCacheTime) /
              1000
          ),
      });
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: error.message,
      });
    }

    return;
  }


  // ----------------------------------------------------------
  // CHARACTER IMAGE
  // ----------------------------------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/characterImage"
  ) {
    try {
      const body =
        await readBody(req);

      if (!body.unitDefId) {
        json(res, 400, {
          ok: false,
          error: "unitDefId is required",
        });

        return;
      }

      const result =
        await getCharacterImage(
          body.unitDefId
        );

      json(res, 200, result);
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: error.message,
      });
    }

    return;
  }


  // ----------------------------------------------------------
  // PLAYER ARENA
  // ----------------------------------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/playerArena"
  ) {
    try {
      const body =
        await readBody(req);

      const result =
        await getPlayerArena(body);

      json(res, 200, result);
    } catch (error) {
      console.error(
        "playerArena ERROR:",
        error
      );

      json(res, error.status || 500, {
        ok: false,
        error: error.message,
        comlink:
          error.response || null,
      });
    }

    return;
  }


  // ----------------------------------------------------------
  // PLAYER
  // ----------------------------------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/player"
  ) {
    try {
      const body =
        await readBody(req);

      const result =
        await getPlayer(body);

      json(res, 200, result);
    } catch (error) {
      console.error(
        "player ERROR:",
        error
      );

      json(res, error.status || 500, {
        ok: false,
        error: error.message,
        comlink:
          error.response || null,
      });
    }

    return;
  }


  // ----------------------------------------------------------
  // RAW DEBUG DATA
  // ----------------------------------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/data"
  ) {
    try {
      const body =
        await readBody(req);

      const result =
        await comlinkPost(
          "/data",
          body
        );

      json(res, 200, result);
    } catch (error) {
      json(res, error.status || 500, {
        ok: false,
        error: error.message,
        comlink:
          error.response || null,
      });
    }

    return;
  }


  // ----------------------------------------------------------
  // 404
  // ----------------------------------------------------------

  json(res, 404, {
    ok: false,
    error: "Route not found",
    path: url.pathname,
  });
}


// ------------------------------------------------------------
// SERVER
// ------------------------------------------------------------

const server =
  http.createServer(
    (req, res) => {
      handleRequest(req, res)
        .catch(error => {
          console.error(
            "UNHANDLED ERROR:",
            error
          );

          if (!res.headersSent) {
            json(res, 500, {
              ok: false,
              error:
                error.message ||
                "Internal server error",
            });
          } else {
            res.end();
          }
        });
    }
  );


server.listen(
  PORT,
  () => {
    console.log(
      `Arena Tracker Proxy running on port ${PORT}`
    );

    console.log(
      `Comlink: ${COMLINK_URL}`
    );
  }
);
