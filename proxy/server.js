const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const COMLINK_URL = (process.env.COMLINK_URL || "https://arena-tracker-2uod.onrender.com").replace(/\/+$/, "");
const ASSET_URL = (process.env.ASSET_URL || "https://arena-tracker-assets.onrender.com").replace(/\/+$/, "");

app.use(cors());
app.use(express.json());

let unitsCache = null;
let unitsCacheTime = 0;
let metadataCache = null;
let metadataCacheTime = 0;

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    }

    if (!response.ok) {
        throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }

    return data;
}

async function requestComlink(path, payload) {
    return fetchJson(`${COMLINK_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload })
    });
}

function findUnits(value) {
    if (!value || typeof value !== "object") return null;

    if (
        Array.isArray(value) &&
        value.some(item =>
            item &&
            typeof item === "object" &&
            typeof item.baseId === "string" &&
            typeof item.thumbnailName === "string"
        )
    ) {
        return value;
    }

    for (const child of Object.values(value)) {
        const found = findUnits(child);
        if (found) return found;
    }

    return null;
}

async function getUnits() {
    if (unitsCache && Date.now() - unitsCacheTime < 3600000) {
        return unitsCache;
    }

    const data = await requestComlink("/data", {
        collection: "unitsList",
        language: "eng_us",
        enums: true,
        match: { rarity: 7 },
        project: {
            baseId: 1,
            nameKey: 1,
            thumbnailName: 1,
            combatType: 1
        }
    });

    const units = findUnits(data);

    if (!units) {
        throw new Error("Units data not found in Comlink response");
    }

    unitsCache = units;
    unitsCacheTime = Date.now();

    return units;
}

async function getMetadata() {
    if (metadataCache && Date.now() - metadataCacheTime < 300000) {
        return metadataCache;
    }

    metadataCache = await fetchJson(`${COMLINK_URL}/metadata`);
    metadataCacheTime = Date.now();

    return metadataCache;
}

async function getUnit(definitionId) {
    const baseId = String(definitionId).split(":")[0];
    const units = await getUnits();

    const unit = units.find(item => item.baseId === baseId);

    if (!unit) {
        throw new Error(`Unit not found: ${baseId}`);
    }

    return {
        ...unit,
        definitionId
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

        const data = await requestComlink("/playerArena", {
            allyCode: String(allyCode),
            playerDetailsOnly: false
        });

        res.json(data);
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

        const data = await requestComlink("/playerArena", {
            allyCode: String(allyCode),
            playerDetailsOnly: false
        });

        res.json(data);
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

        const data = await requestComlink("/player", {
            allyCode: String(allyCode)
        });

        res.json(data);
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

        const data = await requestComlink("/player", {
            allyCode: String(allyCode)
        });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/unit", async (req, res) => {
    try {
        const { definitionId } = req.query;

        if (!definitionId) {
            return res.status(400).json({ error: "definitionId is required" });
        }

        const unit = await getUnit(definitionId);
        res.json(unit);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/characterImage", async (req, res) => {
    try {
        const { definitionId, baseId } = req.query;
        const id = definitionId || baseId;

        if (!id) {
            return res.status(400).json({ error: "definitionId or baseId is required" });
        }

        const unit = await getUnit(id);
        const metadata = await getMetadata();
        const version = metadata.assetVersion;

        if (!version) {
            return res.status(500).json({ error: "assetVersion not found in Comlink metadata" });
        }

        const assetName = String(unit.thumbnailName).replace(/^tex\./, "");

        const url = new URL(`${ASSET_URL}/Asset/single`);
        url.searchParams.set("forceReDownload", "false");
        url.searchParams.set("version", String(version));
        url.searchParams.set("assetName", assetName);
        url.searchParams.set("assetOS", "1");

        const response = await fetch(url);

        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({
                error: "Asset extractor error",
                details: text.slice(0, 500),
                unit,
                version,
                assetName
            });
        }

        const contentType = response.headers.get("content-type") || "image/png";
        const buffer = Buffer.from(await response.arrayBuffer());

        res.set("Cache-Control", "public, max-age=86400");
        res.set("Content-Type", contentType);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
