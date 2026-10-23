import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { CONFIG, upgradeLabel } from "./src/config.js";
import { closeDb, initDb, query } from "./src/db.js";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  createSessionToken,
  hashPassword,
  parseCookies,
  sessionCookie,
  verifyPassword,
  verifySessionToken,
} from "./src/auth.js";
import {
  GameError,
  applyClicks,
  createClan,
  flushAll,
  flushState,
  getState,
  joinClan,
  leaveClan,
  listClans,
  publicState,
  purchase,
  refreshClan,
} from "./src/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[auth] SESSION_SECRET is not set — sessions will reset when the server restarts.",
  );
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const authAttempts = new Map();

function authRateLimit(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const entry = authAttempts.get(key);

  if (!entry || now - entry.startedAt > windowMs) {
    authAttempts.set(key, { startedAt: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > 40) {
    return res.status(429).json({ error: "Слишком много попыток. Подожди немного." });
  }
  return next();
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, entry] of authAttempts) {
    if (entry.startedAt < cutoff) authAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

function isSecure(req) {
  return req.secure || process.env.NODE_ENV === "production";
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const payload = token ? verifySessionToken(token, SESSION_SECRET) : null;
  if (!payload) {
    return res.status(401).json({ error: "Требуется вход" });
  }

  getState(payload.uid)
    .then((state) => {
      if (!state) return res.status(401).json({ error: "Сессия устарела" });
      req.state = state;
      next();
    })
    .catch(next);
}

function clientConfig() {
  return {
    gameName: CONFIG.gameName,
    tagline: CONFIG.tagline,
    clanCreateCost: CONFIG.clanCreateCost,
    maxClanMembers: CONFIG.maxClanMembers,
    clanBonusPerMember: CONFIG.clanBonusPerMember,
    maxClans: CONFIG.maxClans,
    clickRatePerSecond: CONFIG.clickRatePerSecond,
    upgrades: CONFIG.upgrades.map((upgrade) => ({
      id: upgrade.id,
      index: upgrade.index,
      amount: upgrade.amount,
      cost: upgrade.cost,
    })),
  };
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get("/api/config", (req, res) => {
  res.json(clientConfig());
});

app.post(
  "/api/auth/register",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      throw new GameError("Ник: 3–16 символов, только A–Z, 0–9 и _");
    }
    if (password.length < CONFIG.minPasswordLength || password.length > 72) {
      throw new GameError("Пароль: от 6 до 72 символов");
    }

    const lower = username.toLowerCase();
    const existing = await query("SELECT 1 FROM users WHERE username_lower = $1", [lower]);
    if (existing[0]) throw new GameError("Этот ник уже занят", 409);

    const passwordHash = await hashPassword(password);
    let userId;
    try {
      const rows = await query(
        `INSERT INTO users (username, username_lower, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [username, lower, passwordHash],
      );
      userId = Number(rows[0].id);
    } catch (error) {
      if (error?.code === "23505") throw new GameError("Этот ник уже занят", 409);
      throw error;
    }

    const state = await getState(userId);
    res.setHeader(
      "Set-Cookie",
      sessionCookie(createSessionToken(userId, SESSION_SECRET), isSecure(req)),
    );
    res.status(201).json({ state: publicState(state) });
  }),
);

app.post(
  "/api/auth/login",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!username || !password) {
      throw new GameError("Введи ник и пароль");
    }

    const rows = await query(
      `SELECT id, username, password_hash
       FROM users WHERE username_lower = $1`,
      [username.toLowerCase()],
    );
    if (!rows[0]) throw new GameError("Неверный ник или пароль", 401);

    const valid = await verifyPassword(password, rows[0].password_hash);
    if (!valid) throw new GameError("Неверный ник или пароль", 401);

    const userId = Number(rows[0].id);
    const state = await getState(userId);
    res.setHeader(
      "Set-Cookie",
      sessionCookie(createSessionToken(userId, SESSION_SECRET), isSecure(req)),
    );
    res.json({ state: publicState(state, { withMembers: true }) });
  }),
);

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearedSessionCookie(isSecure(req)));
  res.json({ ok: true });
});

app.get(
  "/api/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.state;
    await refreshClan(state, true);
    res.json({ state: publicState(state, { withMembers: true }) });
  }),
);

app.post(
  "/api/click",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.state;
    const result = applyClicks(state, req.body?.count);
    res.json({
      accepted: result.accepted,
      gain: result.gain,
      state: publicState(state),
    });
  }),
);

app.post(
  "/api/purchase",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.state;
    await flushState(state);
    const result = await purchase(state, String(req.body?.upgradeId || ""));
    res.json({
      state: publicState(state),
      upgrade: {
        id: result.upgrade.id,
        amount: result.upgrade.amount,
        label: upgradeLabel(result.upgrade),
      },
      level: result.level,
      message: `${upgradeLabel(result.upgrade)} к клику · уровень ${result.level}`,
    });
  }),
);

app.get(
  "/api/clans",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.state;
    await flushState(state);
    const data = await listClans(state);
    res.json({ ...data, state: publicState(state, { withMembers: true }) });
  }),
);

app.post(
  "/api/clans",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.state;
    await flushState(state);
    const clan = await createClan(state, req.body?.name, req.body?.tag);
    res.status(201).json({
      clan,
      state: publicState(state, { withMembers: true }),
      message: `Клан [${clan.tag}] создан`,
    });
  }),
);

app.post(
  "/api/clans/:id/join",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.state;
    await flushState(state);
    const clan = await joinClan(state, req.params.id);
    res.json({
      clan,
      state: publicState(state, { withMembers: true }),
      message: `Ты вступил в клан [${clan.tag}]`,
    });
  }),
);

app.post(
  "/api/clans/leave",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.state;
    await flushState(state);
    await leaveClan(state);
    res.json({
      state: publicState(state, { withMembers: true }),
      message: "Ты вышел из клана",
    });
  }),
);

app.use(
  express.static(publicDir, {
    maxAge: "1h",
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    return res.sendFile(path.join(publicDir, "index.html"));
  }
  return res.status(404).json({ error: "Не найдено" });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof GameError) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Некорректный запрос" });
  }
  console.error("[server]", error);
  return res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

await initDb();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[vibe] http://localhost:${PORT}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[vibe] ${signal} received, saving profiles...`);
  const forceTimer = setTimeout(() => process.exit(0), 9_000);
  forceTimer.unref?.();

  server.close();
  try {
    await flushAll();
    await closeDb();
  } catch (error) {
    console.error("[shutdown]", error);
  }
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
