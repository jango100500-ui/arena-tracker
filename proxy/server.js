import http from "http";
import Fuse from "fuse.js";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  "https://arena-tracker-2uod.onrender.com";

const ICONS_API =
  "https://api.github.com/repos/tools4swgoh/swgoh-icons/git/trees/main?recursive=1";
const GAMEDATA_URL =
  "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/gameDataItems.json";


const ALLOWED_ROUTES = {
  "/playerArena": "/playerArena",
  "/player": "/player"
};


let iconFiles = null;
let fuse = null;
let gameData = null;


/* =========================================================
   HELPERS
========================================================= */

function normalize(text) {

  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]/gi, "");

}


/* =========================================================
   LOAD ICON FILES
========================================================= */

async function loadIconFiles(debug) {

  if (iconFiles) {

    debug.push(
      `Icon cache: ${iconFiles.length} files`
    );

    return iconFiles;

  }


  debug.push(
    "Загружаем список иконок..."
  );


  const response =
    await fetch(ICONS_API, {
      headers: {
        "User-Agent":
          "arena-tracker"
      }
    });


  if (!response.ok) {

    throw new Error(
      `Icons API HTTP ${response.status}`
    );

  }


  const data =
    await response.json();


  iconFiles =
    data.tree
      .filter(file =>
        file.type === "blob" &&
        file.path
          .toLowerCase()
          .endsWith(".png")
      )
      .map(file => file.path);


  debug.push(
    `Всего PNG: ${iconFiles.length}`
  );


  return iconFiles;

}


/* =========================================================
   LOAD GAMEDATA
========================================================= */

async function loadGameData(debug) {

  if (gameData) {

    debug.push(
      "Gamedata: cache"
    );

    return gameData;

  }


  debug.push(
    "Загружаем SWGOH gamedata..."
  );


  const response =
    await fetch(GAMEDATA_URL);


  if (!response.ok) {

    throw new Error(
      `Gamedata HTTP ${response.status}`
    );

  }


  gameData =
    await response.json();


  debug.push(
    "Gamedata загружен ✓"
  );


  return gameData;

}


/* =========================================================
   BUILD FUSE
========================================================= */

async function buildFuse(debug) {

  if (fuse) {

    debug.push(
      "Fuse index: cache"
    );

    return fuse;

  }


  const files =
    await loadIconFiles(debug);


  const characterFiles =
    files.filter(file => {

      const lower =
        file.toLowerCase();

      return (
        lower.includes("character") &&
        lower.includes("portrait")
      );

    });


  debug.push(
    `Портретов персонажей: ${characterFiles.length}`
  );


  const documents =
    characterFiles.map(file => ({

      path: file,

      name:
        file
          .split("/")
          .pop()
          .replace(
            /\.png$/i,
            ""
          )

    }));


  fuse =
    new Fuse(
      documents,
      {

        keys: [
          {
            name: "name",
            weight: 1
          }
        ],

        includeScore: true,

        threshold: 0.65,

        ignoreLocation: true,

        minMatchCharLength: 3

      }
    );


  debug.push(
    "Fuse index создан ✓"
  );


  return fuse;

}


/* =========================================================
   FIND UNIT DEFINITION
========================================================= */

function findUnitDefinition(
  unitDefId,
  data,
  debug
) {

  const baseId =
    unitDefId
      ?.split(":")[0];


  if (!baseId) {

    debug.push(
      "Base ID не найден"
    );

    return null;

  }


  debug.push(
    `Base ID: ${baseId}`
  );


  const collections = [];


  if (
    Array.isArray(
      data.UnitDefinitions
    )
  ) {

    collections.push(
      data.UnitDefinitions
    );

  }


  if (
    Array.isArray(
      data.unitDefinitions
    )
  ) {

    collections.push(
      data.unitDefinitions
    );

  }


  /*
   * Иногда gamedata содержит объект,
   * а не массив.
   */
  if (
    data.UnitDefinitions &&
    typeof data.UnitDefinitions === "object" &&
    !Array.isArray(data.UnitDefinitions)
  ) {

    const direct =
      data.UnitDefinitions[baseId];


    if (direct) {

      debug.push(
        "UnitDefinition найден ✓"
      );

      return direct;

    }

  }


  for (
    const collection
    of collections
  ) {

    const found =
      collection.find(unit => {

        const id =
          unit.id ||
          unit.unitId ||
          unit.defId ||
          unit.baseId;


        return (
          id === baseId ||
          id === unitDefId
        );

      });


    if (found) {

      debug.push(
        "UnitDefinition найден ✓"
      );

      return found;

    }

  }


  debug.push(
    "UnitDefinition не найден"
  );


  return null;

}


/* =========================================================
   GET POSSIBLE NAMES
========================================================= */

function getPossibleNames(
  unitDefId,
  definition
) {

  const names = [];


  const baseId =
    unitDefId
      ?.split(":")[0];


  if (baseId) {
    names.push(baseId);
  }


  if (!definition) {

    return [
      ...new Set(names)
    ];

  }


  const fields = [

    "name",

    "displayName",

    "characterName",

    "localizedName",

    "unitName",

    "shortName",

    "baseName",

    "nameKey"

  ];


  for (
    const field
    of fields
  ) {

    const value =
      definition[field];


    if (
      typeof value ===
      "string" &&
      value.length > 1
    ) {

      names.push(value);

    }

  }


  return [
    ...new Set(names)
  ];

}


/* =========================================================
   FIND CHARACTER IMAGE
========================================================= */

async function findCharacterImage(
  unitDefId
) {

  const debug = [];


  debug.push(
    `unitDefId: ${unitDefId}`
  );


  try {

    const data =
      await loadGameData(
        debug
      );


    const search =
      await buildFuse(
        debug
      );


    const definition =
      findUnitDefinition(
        unitDefId,
        data,
        debug
      );


    const names =
      getPossibleNames(
        unitDefId,
        definition
      );


    debug.push(
      `Имена для поиска: ${names.join(" | ")}`
    );


    let bestResult =
      null;


    let bestSearchName =
      null;


    for (
      const name
      of names
    ) {

      debug.push(
        `Fuse search: "${name}"`
      );


      const results =
        search.search(name);


      if (!results.length) {

        debug.push(
          "  → результатов нет"
        );

        continue;

      }


      const candidate =
        results[0];


      const filename =
        candidate.item.name;


      const score =
        candidate.score;


      debug.push(
        `  → ${filename}`
      );


      debug.push(
        `  → score: ${score}`
      );


      if (
        !bestResult ||
        score <
        bestResult.score
      ) {

        bestResult =
          candidate;

        bestSearchName =
          name;

      }

    }


    if (!bestResult) {

      debug.push(
        "❌ Портрет не найден"
      );


      return {
        image: null,
        debug
      };

    }


    const file =
      bestResult.item.path;


    const score =
      bestResult.score;


    debug.push(
      `Лучшее совпадение: ${file}`
    );


    debug.push(
      `Итоговый score: ${score}`
    );


    /*
     * Очень плохие совпадения
     * отбрасываем.
     */
    if (
      score !== undefined &&
      score > 0.50
    ) {

      debug.push(
        "❌ Совпадение слишком слабое"
      );


      return {
        image: null,

        debug,

        match: {
          file,
          score,
          searchedName:
            bestSearchName
        }
      };

    }


    const encodedPath =
      file
        .split("/")
        .map(
          encodeURIComponent
        )
        .join("/");


    const url =
      `https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/master/${encodedPath}`;


    debug.push(
      "✓ Портрет найден"
    );


    return {

      image: {

        url,

        file,

        score,

        searchedName:
          bestSearchName

      },

      debug

    };


  } catch (error) {

    debug.push(
      `❌ ERROR: ${error.message}`
    );


    return {

      image: null,

      debug,

      error:
        error.message

    };

  }

}


/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {


      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );


      res.setHeader(
        "Access-Control-Allow-Methods",
        "POST, OPTIONS"
      );


      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
      );


      if (
        req.method === "OPTIONS"
      ) {

        res.writeHead(204);
        res.end();

        return;

      }


      /* ===================================================
         CHARACTER IMAGE
      =================================================== */

      if (
        req.method === "POST" &&
        req.url ===
          "/characterImage"
      ) {

        let body = "";


        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );


        req.on(
          "end",
          async () => {

            try {

              const data =
                JSON.parse(body);


              const result =
                await findCharacterImage(
                  data.unitDefId
                );


              res.writeHead(
                200,
                {
                  "Content-Type":
                    "application/json"
                }
              );


              res.end(
                JSON.stringify({

                  unitDefId:
                    data.unitDefId,

                  image:
                    result.image,

                  debug:
                    result.debug,

                  error:
                    result.error ||
                    null,

                  match:
                    result.match ||
                    null

                })
              );


            } catch (error) {

              res.writeHead(
                500,
                {
                  "Content-Type":
                    "application/json"
                }
              );


              res.end(
                JSON.stringify({

                  error:
                    error.message

                })
              );

            }

          }
        );


        return;

      }


      /* ===================================================
         COMLINK
      =================================================== */

      const targetPath =
        ALLOWED_ROUTES[
          req.url
        ];


      if (
        req.method === "POST" &&
        targetPath
      ) {

        let body = "";


        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );


        req.on(
          "end",
          async () => {

            try {

              console.log(
                `POST ${req.url}`
              );


              const response =
                await fetch(
                  `${COMLINK_URL}${targetPath}`,
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
                    "application/json"
                }
              );


              res.end(text);


            } catch (error) {

              res.writeHead(
                500,
                {
                  "Content-Type":
                    "application/json"
                }
              );


              res.end(
                JSON.stringify({

                  error:
                    error.message

                })
              );

            }

          }
        );


        return;

      }


      res.writeHead(
        404,
        {
          "Content-Type":
            "application/json"
        }
      );


      res.end(
        JSON.stringify({

          message:
            "Route not found"

        })
      );

    }
  );


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Proxy listening on port ${PORT}`
    );

  }
);
