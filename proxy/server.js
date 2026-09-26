const express = require("express");
const cors = require("cors");
const zlib = require("zlib");

const app = express();
const PORT = process.env.PORT || 3000;
const COMLINK_URL = (process.env.COMLINK_URL || "https://arena-tracker-2uod.onrender.com").replace(/\/+$/, "");
const ASSET_URL = (process.env.ASSET_URL || "https://arena-tracker-assets.onrender.com").replace(/\/+$/, "");
const UNITS_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/units.json.br";
const VERSIONS_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/allVersions.json";
const LOCALE_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/Loc_ENG_US.txt.json.br";

app.use(cors());
app.use(express.json());

let unitsCache = null;
let unitsCacheTime = 0;
let versionsCache = null;
let versionsCacheTime = 0;
let localizationCache = null;
let localizationCacheTime = 0;

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

async function fetchBrotliJson(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    try {
        return JSON.parse(zlib.brotliDecompressSync(buffer).toString("utf8"));
    } catch {
        return JSON.parse(buffer.toString("utf8"));
    }
}

async function requestComlink(path, payload = {}) {
    return fetchJson(`${COMLINK_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload })
    });
}

async function getUnits() {
    if (unitsCache && Date.now() - unitsCacheTime < 3600000) {
        return unitsCache;
    }

    const parsed = await fetchBrotliJson(UNITS_URL);
    const units = Array.isArray(parsed) ? parsed : parsed.data;

    if (!Array.isArray(units)) {
        throw new Error("Invalid units data");
    }

    unitsCache = units;
    unitsCacheTime = Date.now();

    return units;
}

async function getAssetVersion() {
    if (versionsCache && Date.now() - versionsCacheTime < 300000) {
        return versionsCache;
    }

    const data = await fetchJson(VERSIONS_URL);
    const version = data?.assetVersion;

    if (!version) {
        throw new Error("assetVersion not found");
    }

    versionsCache = version;
    versionsCacheTime = Date.now();

    return version;
}

function buildLocalizationMap(node, map = {}) {
    if (!node) {
        return map;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            if (item && typeof item === "object") {
                const key = item.key || item.nameKey || item.id;
                const value = item.value ?? item.text ?? item.valueText;

                if (typeof key === "string" && typeof value === "string") {
                    map[key] = value;
                }

                buildLocalizationMap(item, map);
            }
        }

        return map;
    }

    if (typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (typeof value === "string") {
                map[key] = value;
            } else if (value && typeof value === "object") {
                buildLocalizationMap(value, map);
            }
        }
    }

    return map;
}

async function getLocalization() {
    if (localizationCache && Date.now() - localizationCacheTime < 3600000) {
        return localizationCache;
    }

    const parsed = await fetchBrotliJson(LOCALE_URL);
    localizationCache = buildLocalizationMap(parsed.data || parsed);
    localizationCacheTime = Date.now();

    return localizationCache;
}

async function localize(key) {
    if (!key) {
        return "";
    }

    const localization = await getLocalization();
    return localization[key] || key;
}

function getUnitAlignment(unit) {
    const categories = unit?.categoryId || unit?.categoryIdList || [];

    if (categories.includes("alignment_light")) {
        return "light";
    }

    if (categories.includes("alignment_dark")) {
        return "dark";
    }

    if (categories.includes("alignment_neutral")) {
        return "neutral";
    }

    if (unit?.forceAlignment === 1) {
        return "dark";
    }

    if (unit?.forceAlignment === 2) {
        return "light";
    }

    return "neutral";
}

function getRelicLevel(relic) {
    const tier = Number(relic?.currentTier || 0);

    if (tier > 2) {
        return tier - 2;
    }

    return 0;
}

async function enrichArena(arena, player) {
    const [units, localization] = await Promise.all([
        getUnits(),
        getLocalization()
    ]);

    const unitMap = new Map(units.map(unit => [unit.baseId, unit]));
    const rosterMap = new Map((player.rosterUnit || []).map(unit => [unit.definitionId, unit]));

    const pvpProfile = (arena.pvpProfile || []).map(profile => ({
        ...profile,
        squad: profile.squad
            ? {
                ...profile.squad,
                cell: (profile.squad.cell || []).map(cell => {
                    const definitionId = cell.unitDefId || cell.definitionId || "";
                    const baseId = definitionId.split(":")[0];
                    const unit = unitMap.get(baseId) || {};
                    const roster = rosterMap.get(definitionId) || {};
                    const categories = unit.categoryId || unit.categoryIdList || [];
                    const isGalacticLegend = Boolean(unit.legend || categories.includes("galactic_legend"));
                    const name = localization[unit.nameKey] || unit.nameKey || baseId;
                    const alignment = isGalacticLegend ? "galactic_legend" : getUnitAlignment(unit);

                    return {
                        ...cell,
                        baseId,
                        name,
                        alignment,
                        isGalacticLegend,
                        rarity: Number(roster.currentRarity || 0),
                        gearTier: Number(roster.currentTier || 0),
                        relicTier: getRelicLevel(roster.relic)
                    };
                })
            }
            : profile.squad
    }));

    const titleKey = player.selectedPlayerTitle?.nameKey || "";
    const title = localization[titleKey] || titleKey || "";

    return {
        ...arena,
        name: player.name || arena.name,
        allyCode: player.allyCode || arena.allyCode,
        guildName: player.guildName || arena.guildName,
        selectedPlayerTitle: player.selectedPlayerTitle || null,
        title,
        pvpProfile
    };
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

function detectAssetOS(req) {
    const requested = Number(req.query.assetOS);

    if ([0, 1, 2].includes(requested)) {
        return requested;
    }

    const userAgent = String(req.headers["user-agent"] || "");

    if (/iPhone|iPad|iPod/i.test(userAgent)) {
        return 2;
    }

    if (/Android/i.test(userAgent)) {
        return 1;
    }

    return 0;
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

        const [arena, player] = await Promise.all([
            requestComlink("/playerArena", {
                allyCode: String(allyCode),
                playerDetailsOnly: false
            }),
            requestComlink("/player", {
                allyCode: String(allyCode)
            })
        ]);

        res.json(await enrichArena(arena, player));
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

        const [arena, player] = await Promise.all([
            requestComlink("/playerArena", {
                allyCode: String(allyCode),
                playerDetailsOnly: false
            }),
            requestComlink("/player", {
                allyCode: String(allyCode)
            })
        ]);

        res.json(await enrichArena(arena, player));
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

        const player = await requestComlink("/player", {
            allyCode: String(allyCode)
        });

        const localization = await getLocalization();
        const titleKey = player.selectedPlayerTitle?.nameKey || "";

        res.json({
            ...player,
            title: localization[titleKey] || titleKey || ""
        });
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

        const player = await requestComlink("/player", {
            allyCode: String(allyCode)
        });

        const localization = await getLocalization();
        const titleKey = player.selectedPlayerTitle?.nameKey || "";

        res.json({
            ...player,
            title: localization[titleKey] || titleKey || ""
        });
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
        const { definitionId } = req.query;

        if (!definitionId) {
            return res.status(400).json({ error: "definitionId is required" });
        }

        const unit = await getUnit(definitionId);

        if (!unit.thumbnailName) {
            return res.status(404).json({
                error: "thumbnailName not found",
                definitionId,
                unit
            });
        }

        const version = await getAssetVersion();
        const assetOS = detectAssetOS(req);

        const assetName = String(unit.thumbnailName)
            .replace(/^tex\./, "")
            .replace(/\.[^/.]+$/, "");

        const url = new URL(`${ASSET_URL}/Asset/single`);
        url.searchParams.set("assetName", assetName);
        url.searchParams.set("version", String(version));
        url.searchParams.set("forceReDownload", "false");
        url.searchParams.set("assetOS", String(assetOS));

        const response = await fetch(url);

        if (!response.ok) {
            const text = await response.text();

            return res.status(response.status).json({
                error: "Asset extractor error",
                details: text.slice(0, 500),
                definitionId,
                baseId: unit.baseId,
                thumbnailName: unit.thumbnailName,
                assetName,
                version,
                assetOS
            });
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        res.set("Cache-Control", "public, max-age=86400");
        res.set("Content-Type", "image/png");
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
