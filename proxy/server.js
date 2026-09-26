import http from "http";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  "https://arena-tracker-2uod.onrender.com";

const ALLOWED_ROUTES = {
  "/playerArena": "/playerArena",
  "/player": "/player"
};

const server = http.createServer(async (req, res) => {

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Проверяем endpoint
  const targetPath = ALLOWED_ROUTES[req.url];

  if (req.method === "POST" && targetPath) {

    try {
      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", async () => {

        console.log(
          `POST ${req.url}`
        );

        const response = await fetch(
          `${COMLINK_URL}${targetPath}`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json"
            },

            body
          }
        );

        const text = await response.text();

        res.writeHead(response.status, {
          "Content-Type": "application/json"
        });

        res.end(text);
      });

    } catch (error) {

      console.error(error);

      res.writeHead(500, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          error: error.toString()
        })
      );
    }

    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json"
  });

  res.end(
    JSON.stringify({
      message: "Route not found"
    })
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Proxy listening on port ${PORT}`
  );
});
