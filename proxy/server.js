const express = require("express");
const cors = require("cors");
const zlib = require("zlib");

const app = express();
const PORT = process.env.PORT || 3000;
const COMLINK_URL = (process.env.COMLINK_URL || "https://arena-tracker-2uod.onrender.com").replace(/\/+$/, "");
const ASSET_URL = (process.env.ASSET_URL || "https://arena-tracker-assets.onrender.com").replace(/\/+$/, "");
const UNITS_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/units.json.br";
const VERSIONS_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/allVersions.json";
const PLAYER_TITLES_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/playerTitle.json";
const CATEGORIES_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/category.json";
const ENG_LOCALE_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/Loc_ENG_US.txt.json.br";
const RUS_LOCALE_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/Loc_RUS_RU.txt.json.br";

app.use(cors());
app.use(express.json());

const cache = new Map();

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

function collectionData(parsed) {
    if (Array.isArray(parsed)) {
        return parsed;
    }

    if (Array.isArray(parsed?.data)) {
        return parsed.data;
    }

    if (parsed?.data && typeof parsed.data === "object") {
        return Object.values(parsed.data);
    }

    if (parsed && typeof parsed === "object") {
        return Object.values(parsed).filter(value => value && typeof value === "object");
    }

    return [];
}

function normalizeIds(value) {
    if (Array.isArray(value)) {
        return value.flatMap(normalizeIds);
    }

    if (typeof value === "string" || typeof value === "number") {
        return [String(value)];
    }

    if (value && typeof value === "object") {
        if (value.id !== undefined) {
            return normalizeIds(value.id);
        }

        return Object.values(value).flatMap(normalizeIds);
    }

    return [];
}

function indexById(items) {
    const map = new Map();

    for (const item of items) {
        if (item?.id !== undefined) {
            map.set(String(item.id), item);
        }
    }

    return map;
}

async function getCached(key, loader, ttl) {
    const current = cache.get(key);

    if (current && Date.now() - current.time < ttl) {
        return current.value;
    }

    const value = await loader();
    cache.set(key, { value, time: Date.now() });

    return value;
}

async function getUnits() {
    return getCached("units", async () => {
        const parsed = await fetchBrotliJson(UNITS_URL);
        const units = collectionData(parsed);

        if (!units.length) {
            throw new Error("Invalid units data");
        }

        return units;
    }, 3600000);
}

async function getAssetVersion() {
    return getCached("assetVersion", async () => {
        const data = await fetchJson(VERSIONS_URL);
        const version = data?.assetVersion;

        if (!version) {
            throw new Error("assetVersion not found");
        }

        return version;
    }, 300000);
}

async function getPlayerTitles() {
    return getCached("playerTitles", async () => {
        const parsed = await fetchJson(PLAYER_TITLES_URL);
        return indexById(collectionData(parsed));
    }, 3600000);
}

async function getCategories() {
    return getCached("categories", async () => {
        const parsed = await fetchJson(CATEGORIES_URL);
        return indexById(collectionData(parsed));
    }, 3600000);
}

function buildLocalizationMap(node, map = {}) {
    if (!node) {
        return map;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            buildLocalizationMap(item, map);
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

async function getLocalization(language = "ENG") {
    const key = language === "RUS" ? "localization_rus" : "localization_eng";
    const url = language === "RUS" ? RUS_LOCALE_URL : ENG_LOCALE_URL;

    return getCached(key, async () => {
        const parsed = await fetchBrotliJson(url);
        return buildLocalizationMap(parsed.data || parsed);
    }, 3600000);
}

function resolvePlayerTitle(player, playerTitles, localization) {
    const id = String(player?.selectedPlayerTitle?.id || "");

    if (!id) {
        return "";
    }

    const definition = playerTitles.get(id);

    if (!definition) {
        return id;
    }

    const nameKey = definition.nameKey || definition.titleKey || definition.textKey || "";

    return localization[nameKey] || definition.name || definition.title || nameKey || id;
}

function getUnitCategoryIds(unit) {
    return [
        ...normalizeIds(unit?.categoryId),
        ...normalizeIds(unit?.categoryIdList),
        ...normalizeIds(unit?.categoryIds),
        ...normalizeIds(unit?.categories)
    ];
}

function getUnitAlignment(unit, categories) {
    const ids = getUnitCategoryIds(unit);
    const resolved = [];

    for (const id of ids) {
        resolved.push(id.toLowerCase());

        const category = categories.get(id);

        if (category) {
            for (const value of Object.values(category)) {
                if (typeof value === "string") {
                    resolved.push(value.toLowerCase());
                }
            }
        }
    }

    const text = resolved.join("|");

    if (
        resolved.includes("alignment_light") ||
        text.includes("alignment_light") ||
        text.includes("light_side") ||
        text.includes("lightside")
    ) {
        return "light";
    }

    if (
        resolved.includes("alignment_dark") ||
        text.includes("alignment_dark") ||
        text.includes("dark_side") ||
        text.includes("darkside")
    ) {
        return "dark";
    }

    if (
        resolved.includes("alignment_neutral") ||
        text.includes("alignment_neutral")
    ) {
        return "neutral";
    }

    const force = String(unit?.forceAlignment ?? "").toLowerCase();

    if (force === "light" || force === "light_side" || force === "lightside") {
        return "light";
    }

    if (force === "dark" || force === "dark_side" || force === "darkside") {
        return "dark";
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
    const [units, categories, localizationEng, localizationRus, playerTitles] = await Promise.all([
        getUnits(),
        getCategories(),
        getLocalization("ENG"),
        getLocalization("RUS"),
        getPlayerTitles()
    ]);

    const unitMap = new Map();

    for (const unit of units) {
        if (unit?.baseId) {
            unitMap.set(unit.baseId, unit);
        }
    }

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
                    const categoryIds = getUnitCategoryIds(unit);
                    const isGalacticLegend = Boolean(
                        unit.legend === true ||
                        unit.legend === 1 ||
                        String(unit.legend).toLowerCase() === "true" ||
                        categoryIds.some(id => id.toLowerCase() === "galactic_legend")
                    );
                    const nameKey = unit.nameKey || "";
                    const name = localizationRus[nameKey] || localizationEng[nameKey] || nameKey || baseId;
                    const alignment = isGalacticLegend ? "galactic_legend" : getUnitAlignment(unit, categories);

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

    return {
        ...arena,
        name: player.name || arena.name,
        allyCode: player.allyCode || arena.allyCode,
        guildName: player.guildName || arena.guildName,
        selectedPlayerTitle: player.selectedPlayerTitle || null,
        title: resolvePlayerTitle(player, playerTitles, localizationRus),
        pvpProfile
    };
}

async function requestComlink(path, payload = {}) {
    return fetchJson(`${COMLINK_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, enums: false })
    });
}

async function requestArena(allyCode) {
    const [arena, player] = await Promise.all([
        requestComlink("/playerArena", {
            allyCode: String(allyCode),
            playerDetailsOnly: false
        }),
        requestComlink("/player", {
            allyCode: String(allyCode)
        })
    ]);

    return enrichArena(arena, player);
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

        res.json(await requestArena(allyCode));
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

        res.json(await requestArena(allyCode));
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

        const [player, playerTitles, localizationRus] = await Promise.all([
            requestComlink("/player", {
                allyCode: String(allyCode)
            }),
            getPlayerTitles(),
            getLocalization("RUS")
        ]);

        res.json({
            ...player,
            title: resolvePlayerTitle(player, playerTitles, localizationRus)
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

        const [player, playerTitles, localizationRus] = await Promise.all([
            requestComlink("/player", {
                allyCode: String(allyCode)
            }),
            getPlayerTitles(),
            getLocalization("RUS")
        ]);

        res.json({
            ...player,
            title: resolvePlayerTitle(player, playerTitles, localizationRus)
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

        res.json(await getUnit(definitionId));
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
