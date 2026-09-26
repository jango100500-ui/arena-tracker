import http from "http";
import Fuse from "fuse.js";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  "https://arena-tracker-2uod.onrender.com";

const ICONS_API =
  "https://api.github.com/repos/tools4swgoh/swgoh-icons/git/trees/master?recursive=1";

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
   NORMALIZE
========================================================= */

function normalize(text) {

  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]/gi, "");

}


/* =========================================================
   LOAD ICONS
========================================================= */

async function loadIconFiles() {

  if (iconFiles) {
    return iconFiles;
  }

  console.log("Loading SWGOH icon list...");


  const response =
    await fetch(ICONS_API, {
      headers: {
        "User-Agent":
          "arena-tracker"
      }
    });


  if (!response.ok) {

    throw new Error(
      `Icon API HTTP ${response.status}`
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


  console.log(
    `Loaded ${iconFiles.length} PNG files`
  );


  return iconFiles;

}


/* =========================================================
   LOAD GAMEDATA
========================================================= */

async function loadGameData() {

  if (gameData) {
    return gameData;
  }


  console.log(
    "Loading SWGOH gamedata..."
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


  console.log(
    "Gamedata loaded"
  );


  return gameData;

}


/* =========================================================
   BUILD FUSE INDEX
========================================================= */

async function buildFuseIndex() {

  if (fuse) {
    return fuse;
  }


  const files =
    await loadIconFiles();


  /*
   * Нам нужны именно character portraits.
   *
   * Это сильно уменьшает количество мусора
   * для fuzzy search.
   */
  const characterFiles =
    files.filter(file => {

      const lower =
        file.toLowerCase();

      return (
        lower.includes("character") &&
        lower.includes("portrait")
      );

    });


  console.log(
    `Character portraits: ${characterFiles.length}`
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

        threshold: 0.55,

        ignoreLocation: true,

        minMatchCharLength: 3

      }
    );


  return fuse;

}


/* =========================================================
   FIND UNIT IN GAMEDATA
========================================================= */

function findUnitDefinition(unitDefId) {

  const data =
    gameData;


  if (!data) {
    return null;
  }


  const baseId =
    unitDefId
      ?.split(":")[0];


  if (!baseId) {
    return null;
  }


  /*
   * В gameDataItems.json структура может
   * отличаться между версиями.
   *
   * Поэтому пробуем несколько распространённых
   * вариантов.
   */

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
      return found;
    }

  }


  return null;

}


/* =========================================================
   EXTRACT POSSIBLE NAMES
========================================================= */

function getPossibleNames(
  unitDefId,
  definition
) {

  const names = [];


  /*
   * Сам ID.
   */
  const baseId =
    unitDefId
      ?.split(":")[0];


  if (baseId) {
    names.push(baseId);
  }


  if (!definition) {
    return names;
  }


  /*
   * Пробуем различные поля
   * из разных версий gamedata.
   */

  const possibleFields = [

    "name",

    "displayName",

    "characterName",

    "localizedName",

    "unitName",

    "shortName",

    "baseName"

  ];


  for (
    const field
    of possibleFields
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


  /*
   * Иногда название лежит глубже.
   */
  if (
    definition.nameKey
  ) {

    names.push(
      definition.nameKey
    );

  }


  return [
    ...new Set(names)
  ];

}


/* =========================================================
   FUZZY SEARCH
========================================================= */

async function findCharacterImage(
  unitDefId
) {

  const database =
    await loadGameData();


  const search =
    await buildFuseIndex();


  const definition =
    findUnitDefinition(
      unitDefId
    );


  const names =
    getPossibleNames(
      unitDefId,
      definition
    );


  console.log(
    "Searching image for:",
    unitDefId
  );


  console.log(
    "Possible names:",
    names
  );


  let bestResult =
    null;


  /*
   * Пробуем каждое известное имя.
   */
  for (
    const name
    of names
  ) {

    const results =
      search.search(name);


    if (!results.length) {
      continue;
    }


    const candidate =
      results[0];


    if (
      !bestResult ||
      candidate.score <
      bestResult.score
    ) {

      bestResult = {

        result:
          candidate,

        searchedName:
          name

      };

    }

  }


  if (!bestResult) {

    console.log(
      "No portrait found."
    );

    return null;

  }


  const file =
    bestResult.result.item.path;


  const score =
    bestResult.result.score;


  console.log(
    `Best match: ${file}`
  );


  console.log(
    `Score: ${score}`
  );


  /*
   * Не принимаем совсем плохие совпадения.
   */
  if (score > 0.45) {

    console.log(
      "Match rejected: score too high."
    );

    return null;

  }


  return {

    url:
      "https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/master/" +
      file
        .split("/")
        .map(
          encodeURIComponent
        )
        .join("/"),

    file,

    score,

    searchedName:
      bestResult.searchedName

  };

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
        req.method ===
        "OPTIONS"
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

        try {

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

              const data =
                JSON.parse(body);


              const image =
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

                  image

                })
              );

            }
          );


        } catch (error) {

          console.error(error);


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
                error.toString()

            })
          );

        }


        return;

      }


      /* ===================================================
         COMLINK PROXY
      =================================================== */

      const targetPath =
        ALLOWED_ROUTES[
          req.url
        ];


      if (
        req.method === "POST" &&
        targetPath
      ) {

        try {

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

            }
          );


        } catch (error) {

          console.error(error);


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
                error.toString()

            })
          );

        }


        return;

      }


      /* ===================================================
         404
      =================================================== */

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
