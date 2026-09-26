const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const COMLINK_URL = process.env.COMLINK_URL || "https://arena-tracker-2uod.onrender.com";

app.use(express.json());

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/arena", async (req, res) => {
  try {
    const { allyCode } = req.query;

    if (!allyCode) {
      return res.status(400).json({ error: "allyCode is required" });
    }

    const response = await fetch(`${COMLINK_URL}/playerArena`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          allyCode: String(allyCode),
          playerDetailsOnly: false
        }
      })
    });

    const text = await response.text();

    res.status(response.status).send(text);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/arena", async (req, res) => {
  try {
    const { allyCode } = req.body;

    if (!allyCode) {
      return res.status(400).json({ error: "allyCode is required" });
    }

    const response = await fetch(`${COMLINK_URL}/playerArena`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          allyCode: String(allyCode),
          playerDetailsOnly: false
        }
      })
    });

    const text = await response.text();

    res.status(response.status).send(text);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/profile", async (req, res) => {
  try {
    const { allyCode } = req.body;

    if (!allyCode) {
      return res.status(400).json({ error: "allyCode is required" });
    }

    const response = await fetch(`${COMLINK_URL}/player`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          allyCode: String(allyCode)
        }
      })
    });

    const text = await response.text();

    res.status(response.status).send(text);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
