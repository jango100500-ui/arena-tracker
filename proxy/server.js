import http from "http";
import Fuse from "fuse.js";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  "https://arena-tracker-2uod.onrender.com";

const GAMEDATA_URL =
  "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/gameDataItems.json";


const ALLOWED_ROUTES = {
  "/playerArena": "/playerArena",
  "/player": "/player"
};


/*
 * Портреты из публичного swgoh-icons.
 *
 * Репозиторий:
 * tools4swgoh/swgoh-icons
 *
 * Важно:
 * URL строятся напрямую через raw.githubusercontent.com.
 */

const CHARACTER_PORTRAITS = [

  {
    name: "Leia Organa",
    file: "65px-Unit-Character-Leia_Organa-portrait.png"
  },

  {
    name: "Captain Drogan",
    file: "65px-Unit-Character-Captain_Drogan-portrait.png"
  },

  {
    name: "Captain Rex",
    file: '65px-Unit-Character-CT-7567_%22Rex%22-portrait.png'
  },

  {
    name: "R2-D2",
    file: "65px-Unit-Character-R2-D2-portrait.png"
  },

  {
    name: "C-3PO",
    file: "65px-Unit-Character-C-3PO-portrait.png"
  },

  {
    name: "Threepio & Chewie",
    file: "65px-Unit-Character-Threepio_%26_Chewie-portrait.png"
  },

  {
    name: "Chewbacca",
    file: "65px-Unit-Character-Chewbacca-portrait.png"
  },

  {
    name: "Han Solo",
    file: "65px-Unit-Character-Han_Solo-portrait.png"
  },

  {
    name: "Luke Skywalker",
    file: "65px-Unit-Character-Luke_Skywalker_%28Farmboy%29-portrait.png"
  },

  {
    name: "Darth Vader",
    file: "65px-Unit-Character-Darth_Vader-portrait.png"
  },

  {
    name: "Emperor Palpatine",
    file: "65px-Unit-Character-Emperor_Palpatine-portrait.png"
  },

  {
    name: "General Kenobi",
    file: "65px-Unit-Character-General_Kenobi-portrait.png"
  },

  {
    name: "General Skywalker",
    file: "65px-Unit-Character-General_Skywalker-portrait.png"
  },

  {
    name: "Jedi Master Kenobi",
    file: "65px-Unit-Character-Jedi_Master_Kenobi-portrait.png"
  },

  {
    name: "Jedi Master Luke Skywalker",
    file: "65px-Unit-Character-Jedi_Master_Luke_Skywalker-portrait.png"
  },

  {
    name: "Rey",
    file: "65px-Unit-Character-Rey-portrait.png"
  },

  {
    name: "Kylo Ren",
    file: "65px-Unit-Character-Kylo_Ren-portrait.png"
  },

  {
    name: "Supreme Leader Kylo Ren",
    file: "65px-Unit-Character-Supreme_Leader_Kylo_Ren-portrait.png"
  },

  {
    name: "Darth Revan",
    file: "65px-Unit-Character-Darth_Revan-portrait.png"
  },

  {
    name: "Darth Malgus",
    file: "65px-Unit-Character-Darth_Malgus-portrait.png"
  },

  {
    name: "Jabba the Hutt",
    file: "65px-Unit-Character-Jabba_the_Hutt-portrait.png"
  },

  {
    name: "Grand Admiral Thrawn",
    file: "65px-Unit-Character-Grand_Admiral_Thrawn-portrait.png"
  },

  {
    name: "Grand Master Yoda",
    file: "65px-Unit-Character-Grand_Master_Yoda-portrait.png"
  },

  {
    name: "Mace Windu",
    file: "65px-Unit-Character-Mace_Windu-portrait.png"
  },

  {
    name: "Ahsoka Tano",
    file: "65px-Unit-Character-Ahsoka_Tano_%28Snips%29-portrait.png"
  },

  {
    name: "Commander Ahsoka Tano",
    file: "65px-Unit-Character-Commander_Ahsoka_Tano-portrait.png"
  }

];


let gameData = null;
let fuse = null;


/* =========================================================
   HELPERS
========================================================= */

function makePortraitUrl(file) {

  return (
    "https://raw.githubusercontent.com/" +
    "tools4swgoh/swgoh-icons/main/" +
    encodeURIComponent(file)
  );

}


/*
 * encodeURIComponent всего имени файла превращает
 * / и другие символы в URL encoding.
 *
 * Здесь файловый путь находится в корне, поэтому это нормально.
 */

function normalize(text) {

  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]/gi, "");

}


/* =========================================================
   GAMEDATA
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
   FUSE
========================================================= */

function buildFuse(debug) {

  if (fuse) {

    debug.push(
      "Fuse index: cache"
    );

    return fuse;

  }


  debug.push(
    `Портретов в локальном индексе: ${CHARACTER_PORTRAITS.length}`
  );


  fuse =
    new Fuse(
      CHARACTER_PORTRAITS,
      {

        keys: [
          {
            name: "name",
            weight: 1
          }
        ],

        includeScore: true,

        threshold: 0.60,

        ignoreLocation: true,

        minMatchCharLength: 2

      }
    );


  debug.push(
    "Fuse index создан ✓"
  );


  return fuse;

}


/* =========================================================
   UNIT DEFINITION
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


  /*
   * Иногда UnitDefinitions — массив.
   */

  if (
    Array.isArray(
      data.UnitDefinitions
    )
  ) {

    const found =
      data.UnitDefinitions.find(
        unit => {

          const id =
            unit.id ||
            unit.unitId ||
            unit.defId ||
            unit.baseId;

          return (
            id === baseId ||
            id === unitDefId
          );

        }
      );


    if (found) {

      debug.push(
        "UnitDefinition найден ✓"
      );

      return found;

    }

  }


  /*
   * Иногда это объект.
   */

  if (
    data.UnitDefinitions &&
    typeof data.UnitDefinitions ===
      "object" &&
    !Array.isArray(
      data.UnitDefinitions
    )
  ) {

    const found =
      data.UnitDefinitions[
        baseId
      ];


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
   NAMES
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

    names.push(
      baseId
    );

  }


  if (definition) {

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
        typeof value === "string" &&
        value.length > 1
      ) {

        names.push(
          value
        );

      }

    }

  }


  /*
   * Надёжные алиасы для наших текущих
   * пяти персонажей.
   *
   * Это не заменяет Fuse — наоборот,
   * даёт ему нормальное человеческое
   * имя для поиска.
   */

  const aliases = {

    GLLEIA: [
      "Leia Organa"
    ],

    CAPTAINDROGAN: [
      "Captain Drogan"
    ],

    R2D2_LEGENDARY: [
      "R2-D2"
    ],

    CAPTAINREX: [
      "Captain Rex",
      "CT-7567 Rex"
    ],

    C3POCHEWBACCA: [
      "Threepio & Chewie",
      "C-3PO",
      "Chewbacca"
    ]

  };


  const aliasList =
    aliases[baseId];


  if (aliasList) {

    names.push(
      ...aliasList
    );

  }


  return [
    ...new Set(names)
  ];

}


/* =========================================================
   FIND PORTRAIT
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


    const search =
      buildFuse(debug);


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


      /*
       * Показываем первые 3 кандидата.
       * Это очень удобно для диагностики.
       */

      results
        .slice(0, 3)
        .forEach(
          result => {

            debug.push(
              `  → ${result.item.name} | score: ${result.score}`
            );

          }
        );


      const candidate =
        results[0];


      if (
        !bestResult ||
        candidate.score <
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
      bestResult.item.file;


    const score =
      bestResult.score;


    debug.push(
      `Лучшее совпадение: ${bestResult.item.name}`
    );


    debug.push(
      `Файл: ${file}`
    );


    debug.push(
      `Итоговый score: ${score}`
    );


    /*
     * 0 = идеально.
     * Чем ближе к 1 — тем хуже.
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
          name:
            bestResult.item.name,

          file,

          score,

          searchedName:
            bestSearchName
        }
      };

    }


    const url =
      makePortraitUrl(
        file
      );


    debug.push(
      `URL: ${url}`
    );


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
