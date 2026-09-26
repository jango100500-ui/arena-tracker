import http from "http";

const PORT = process.env.PORT || 10000;

const COMLINK_URL =
  "https://arena-tracker-2uod.onrender.com";

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

  // Preflight request
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Player Arena
  if (
    req.method === "POST" &&
    req.url === "/playerArena"
  ) {

    try {
      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", async () => {

        const response = await fetch(
          `${COMLINK_URL}/playerArena`,
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

      res.end(JSON.stringify({
        error: error.toString()
      }));
    }

    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify({
    message: "Route not found"
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on port ${PORT}`);
});
