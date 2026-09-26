import http from "http";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  "https://arena-tracker-2uod.onrender.com";

const ICONS_REPO =
  "https://api.github.com/repos/tools4swgoh/swgoh-icons/git/trees/master?recursive=1";

const ALLOWED_ROUTES = {
  "/playerArena": "/playerArena",
  "/player": "/player"
};

let iconFiles = null;


/*
 * Получаем список всех файлов с иконками.
 *
 * Он загружается один раз после запуска proxy,
 * а не при каждом запросе пользователя.
 */
async function loadIconFiles() {

  if (iconFiles) {
    return iconFiles;
  }

  console.log("Loading SWGOH icon list...");

  const response = await fetch(ICONS_REPO, {
    headers: {
      "User-Agent": "arena-tracker"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Cannot load icon repository: HTTP ${response.status}`
    );
  }

  const data = await response.json();

  iconFiles = data.tree
    .filter(file =>
      file.type === "blob" &&
      file.path.toLowerCase().endsWith(".png")
    )
    .map(file => file.path);

  console.log(
    `Loaded ${iconFiles.length} icon files`
  );

  return iconFiles;
}


/*
 * Нормализуем текст:
 *
 * Captain Rex
 * Captain_Rex
 * CAPTAINREX
 *
 * превращаются примерно в одну форму.
 */
function normalize(text) {

  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

}


/*
 * Пока здесь небольшой intelligent mapping
 * для тестовых персонажей.
 *
 * В дальнейшем перенесём mapping в полноценный
 * game-data слой, чтобы покрыть весь ростер.
 */
const KNOWN_NAMES = {

  GLLEIA:
    "Princess_Leia",

  CAPTAINDROGAN:
    "Captain_Drogan",

  R2D2_LEGENDARY:
    "R2-D2",

  CAPTAINREX:
    "Captain_Rex",

  C3POCHEWBACCA:
    "C-3PO"

};


/*
 * Ищем подходящий файл.
 */
async function findCharacterImage(unitDefId) {

  const baseId =
    unitDefId
      ?.split(":")[0]
      ?.toUpperCase();

  if (!baseId) {
    return null;
  }

  const files =
    await loadIconFiles();


  /*
   * Сначала используем известное имя.
   */
  if (KNOWN_NAMES[baseId]) {

    const target =
      normalize(KNOWN_NAMES[baseId]);

    const found =
      files.find(file => {

        const filename =
          file
            .split("/")
            .pop()
            .replace(/\.png$/i, "");

        return normalize(filename)
          .includes(target);

      });

    if (found) {

      return {
        url:
          `https://raw.githubusercontent.com/tools4swgoh/swgoh-icons/master/${encodeURI(found)}`,

        file:
          found
      };

    }

  }


  return null;

}


/*
 * HTTP server
 */
const server =
  http.createServer(async (req, res) => {

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


    if (req.method === "OPTIONS") {

      res.writeHead(204);
      res.end();

      return;
    }


    /*
     * Новый endpoint:
     *
     * POST /characterImage
     *
     * body:
     * {
     *   "unitDefId": "CAPTAINREX:SEVEN_STAR"
     * }
     */
    if (
      req.method === "POST" &&
      req.url === "/characterImage"
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


            res.writeHead(200, {
              "Content-Type":
                "application/json"
            });


            res.end(
              JSON.stringify({
                unitDefId:
                  data.unitDefId,

                image:
                  image
              })
            );

          }
        );


      } catch (error) {

        console.error(error);

        res.writeHead(500, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              error.toString()
          })
        );

      }

      return;
    }


    /*
     * Обычный proxy Comlink
     */
    const targetPath =
      ALLOWED_ROUTES[req.url];


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


        res.writeHead(500, {
          "Content-Type":
            "application/json"
        });


        res.end(
          JSON.stringify({
            error:
              error.toString()
          })
        );

      }

      return;
    }


    res.writeHead(404, {
      "Content-Type":
        "application/json"
    });


    res.end(
      JSON.stringify({
        message:
          "Route not found"
      })
    );

  });


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Proxy listening on port ${PORT}`
    );

  }
);

