const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const COMLINK_URL = process.env.COMLINK_URL || "https://arena-tracker-2uod.onrender.com";

app.use(cors());
app.use(express.json());

async function requestComlink(path, allyCode) {
  const response = await fetch(`${COMLINK_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: {
        allyCode: String(allyCode),
        ...(path === "/playerArena" ? { playerDetailsOnly: false } : {})
      }
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      status: response.status,
      data: { error: text }
    };
  }

  return {
    status: response.status,
    data
  };
}

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/arena", async (req, res) => {
  try {
    const { allyCode } = req.query;

    if (!allyCode) {
      return res.status(400).json({ error: "allyCode is required" });
    }

    const result = await requestComlink("/playerArena", allyCode);
    res.status(result.status).json(result.data);
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

    const result = await requestComlink("/playerArena", allyCode);
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/profile", async (req, res) => {
  try {
    const { allyCode } = req.query;

    if (!allyCode) {
      return res.status(400).json({ error: "allyCode is required" });
    }

    const result = await requestComlink("/player", allyCode);
    res.status(result.status).json(result.data);
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

    const result = await requestComlink("/player", allyCode);
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
