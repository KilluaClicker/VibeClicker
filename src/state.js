import {
  CONFIG,
  UPGRADE_BY_ID,
  basePerClick,
  totalLevels,
} from "./config.js";
import { query, withTransaction } from "./db.js";

const cache = new Map();
const queues = new Map();

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function enqueue(key, task) {
  const id = String(key);
  const previous = queues.get(id) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  queues.set(id, tail);
  tail.finally(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

function emptyLevels() {
  const levels = {};
  for (const upgrade of CONFIG.upgrades) levels[upgrade.id] = 0;
  return levels;
}

async function loadState(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return null;

  const rows = await query(
    "SELECT id, username, coins, total_clicks, clan_id FROM users WHERE id = $1",
    [id],
  );
  if (!rows[0]) return null;

  const row = rows[0];
  const state = {
    id: Number(row.id),
    username: row.username,
    coins: Number(row.coins) || 0,
    totalClicks: Number(row.total_clicks) || 0,
    clanId: row.clan_id === null || row.clan_id === undefined ? null : Number(row.clan_id),
    levels: emptyLevels(),
    clan: null,
    tokens: CONFIG.clickBurst,
    lastToken: Date.now(),
    lastSeen: Date.now(),
    dirty: false,
  };

  const levels = await query(
    "SELECT upgrade_id, level FROM upgrade_levels WHERE user_id = $1",
    [id],
  );
  for (const entry of levels) {
    if (state.levels[entry.upgrade_id] !== undefined) {
      state.levels[entry.upgrade_id] = Number(entry.level) || 0;
    }
  }

  await refreshClan(state, false);
  cache.set(state.id, state);
  return state;
}

export async function getState(userId) {
  const id = Number(userId);
  const cached = cache.get(id);
  if (cached) {
    cached.lastSeen = Date.now();
    return cached;
  }
  return loadState(id);
}

export async function refreshClan(state, withMembers = false) {
  if (!state.clanId) {
    state.clan = null;
    return state.clan;
  }

  const rows = await query(
    `SELECT c.id, c.name, c.tag, c.owner_id,
       (SELECT COUNT(*)::int FROM users u WHERE u.clan_id = c.id) AS member_count
     FROM clans c
     WHERE c.id = $1`,
    [state.clanId],
  );

  if (!rows[0]) {
    state.clanId = null;
    state.clan = null;
    return null;
  }

  const row = rows[0];
  const memberCount = Number(row.member_count) || 0;
  const clan = {
    id: Number(row.id),
    name: row.name,
    tag: row.tag,
    ownerId: Number(row.owner_id),
    memberCount,
    bonusPercent: Math.round(memberCount * CONFIG.clanBonusPerMember * 100),
    bonus: memberCount * CONFIG.clanBonusPerMember,
  };

  if (withMembers) {
    const members = await query(
      `SELECT id, username, total_clicks, (id = $2) AS is_owner
       FROM users
       WHERE clan_id = $1
       ORDER BY (id = $2) DESC, total_clicks DESC, id ASC`,
      [state.clanId, clan.ownerId],
    );
    clan.members = members.map((member) => ({
      id: Number(member.id),
      username: member.username,
      totalClicks: Number(member.total_clicks) || 0,
      isOwner: member.is_owner === true,
    }));
  }

  state.clan = clan;
  return clan;
}

function publicClan(clan, withMembers) {
  if (!clan) return null;
  const result = {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    ownerId: clan.ownerId,
    memberCount: clan.memberCount,
    bonusPercent: clan.bonusPercent,
    bonus: clan.bonus,
  };
  if (withMembers && Array.isArray(clan.members)) result.members = clan.members;
  return result;
}

export function publicState(state, options = {}) {
  const base = basePerClick(state.levels);
  const clanBonus = state.clan
    ? state.clan.memberCount * CONFIG.clanBonusPerMember
    : 0;
  return {
    user: { id: state.id, username: state.username },
    coins: state.coins,
    perClick: base * (1 + clanBonus),
    basePerClick: base,
    totalClicks: state.totalClicks,
    totalLevels: totalLevels(state.levels),
    levels: { ...state.levels },
    clan: publicClan(state.clan, options.withMembers === true),
    maxClanMembers: CONFIG.maxClanMembers,
  };
}

export async function flushState(state) {
  return enqueue(state.id, async () => {
    if (!state.dirty) return true;
    const coins = state.coins;
    const totalClicks = state.totalClicks;
    try {
      await query(
        "UPDATE users SET coins = $1, total_clicks = $2 WHERE id = $3",
        [coins, totalClicks, state.id],
      );
      if (state.coins === coins && state.totalClicks === totalClicks) {
        state.dirty = false;
      }
      return true;
    } catch (error) {
      console.warn(`[save] player ${state.id}: ${error.message}`);
      return false;
    }
  });
}

export async function flushAll() {
  await Promise.allSettled(
    [...cache.values()].map((state) => flushState(state)),
  );
}

export function applyClicks(state, requestedCount) {
  const count = Math.max(0, Math.min(CONFIG.clickBurst, Math.floor(Number(requestedCount) || 0)));
  if (count === 0) {
    return { accepted: 0, gain: 0 };
  }

  const now = Date.now();
  const elapsed = Math.max(0, now - state.lastToken) / 1000;
  state.tokens = Math.min(
    CONFIG.clickBurst,
    state.tokens + elapsed * CONFIG.clickRatePerSecond,
  );
  state.lastToken = now;

  const accepted = Math.min(count, Math.floor(state.tokens + 1e-9));
  if (accepted <= 0) {
    return { accepted: 0, gain: 0 };
  }

  state.tokens -= accepted;
  const clanBonus = state.clan
    ? state.clan.memberCount * CONFIG.clanBonusPerMember
    : 0;
  const gainPerClick = basePerClick(state.levels) * (1 + clanBonus);
  const gain = gainPerClick * accepted;
  state.coins += gain;
  state.totalClicks += accepted;
  state.dirty = true;
  state.lastSeen = Date.now();

  return { accepted, gain };
}

export async function purchase(state, upgradeId) {
  return enqueue(state.id, async () => {
    const upgrade = UPGRADE_BY_ID.get(upgradeId);
    if (!upgrade) throw new GameError("Улучшение не найдено", 404);
    if (state.coins < upgrade.cost) {
      throw new GameError("Недостаточно монет");
    }

    state.coins -= upgrade.cost;
    const newLevel = (state.levels[upgrade.id] || 0) + 1;
    state.levels[upgrade.id] = newLevel;
    state.dirty = true;

    const coinsSnapshot = state.coins;
    const clicksSnapshot = state.totalClicks;

    try {
      await withTransaction(async (tx) => {
        await tx.query(
          "UPDATE users SET coins = $1, total_clicks = $2 WHERE id = $3",
          [coinsSnapshot, clicksSnapshot, state.id],
        );
        await tx.query(
          `INSERT INTO upgrade_levels (user_id, upgrade_id, level)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, upgrade_id)
           DO UPDATE SET level = EXCLUDED.level`,
          [state.id, upgrade.id, newLevel],
        );
      });
      if (state.coins === coinsSnapshot && state.totalClicks === clicksSnapshot) {
        state.dirty = false;
      }
      return { upgrade, level: newLevel };
    } catch (error) {
      state.coins += upgrade.cost;
      state.levels[upgrade.id] = newLevel - 1;
      state.dirty = true;
      console.error(`[purchase] player ${state.id}: ${error.message}`);
      throw new GameError("Не удалось сохранить покупку. Попробуй ещё раз.", 500);
    }
  });
}

function normaliseClanName(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  const length = Array.from(name).length;
  if (length < 3 || length > 20) {
    throw new GameError("Название: от 3 до 20 символов");
  }
  if (/[\u0000-\u001f<>]/.test(name)) {
    throw new GameError("В названии есть запрещённые символы");
  }
  return name;
}

function normaliseClanTag(raw) {
  const tag = String(raw || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(tag)) {
    throw new GameError("Тег: 2–4 символа, только A–Z и 0–9");
  }
  return tag;
}

export async function createClan(state, rawName, rawTag) {
  return enqueue(state.id, async () => {
    const name = normaliseClanName(rawName);
    const tag = normaliseClanTag(rawTag);

    if (state.clanId) throw new GameError("Ты уже в клане");
    if (state.coins < CONFIG.clanCreateCost) {
      throw new GameError(`Нужно ${CONFIG.clanCreateCost.toLocaleString("ru-RU")} монет`);
    }

    const existing = await query(
      "SELECT 1 FROM clans WHERE name_lower = $1 OR tag_lower = $2 LIMIT 1",
      [name.toLowerCase(), tag.toLowerCase()],
    );
    if (existing[0]) {
      throw new GameError("Такое название или тег уже заняты");
    }

    const countRows = await query("SELECT COUNT(*)::int AS count FROM clans");
    if ((Number(countRows[0]?.count) || 0) >= CONFIG.maxClans) {
      throw new GameError("Достигнут лимит кланов");
    }

    state.coins -= CONFIG.clanCreateCost;
    state.dirty = true;
    const coinsSnapshot = state.coins;

    try {
      const clan = await withTransaction(async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO clans (name, name_lower, tag, tag_lower, owner_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, tag, owner_id`,
          [name, name.toLowerCase(), tag, tag.toLowerCase(), state.id],
        );
        const row = inserted[0];
        await tx.query("UPDATE users SET coins = $1, clan_id = $2 WHERE id = $3", [
          coinsSnapshot,
          row.id,
          state.id,
        ]);
        return row;
      });

      if (state.coins === coinsSnapshot) {
        state.dirty = false;
      }
      state.clanId = Number(clan.id);
      state.clan = {
        id: Number(clan.id),
        name: clan.name,
        tag: clan.tag,
        ownerId: state.id,
        memberCount: 1,
        bonusPercent: Math.round(CONFIG.clanBonusPerMember * 100),
        bonus: CONFIG.clanBonusPerMember,
        members: [
          {
            id: state.id,
            username: state.username,
            totalClicks: state.totalClicks,
            isOwner: true,
          },
        ],
      };
      return state.clan;
    } catch (error) {
      state.coins += CONFIG.clanCreateCost;
      state.dirty = true;
      if (error?.code === "23505") {
        throw new GameError("Такое название или тег уже заняты");
      }
      console.error(`[clan create] ${error.message}`);
      throw new GameError("Не удалось создать клан. Попробуй ещё раз.", 500);
    }
  });
}

export async function joinClan(state, clanId) {
  const id = Number(clanId);
  if (!Number.isInteger(id)) throw new GameError("Клан не найден", 404);

  return enqueue(state.id, async () => {
    if (state.clanId) throw new GameError("Сначала выйди из текущего клана");

    let clanRow;
    try {
      clanRow = await withTransaction(async (tx) => {
        const rows = await tx.query(
          "SELECT id, name, tag, owner_id FROM clans WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!rows[0]) throw new GameError("Клан не найден", 404);

        const countRows = await tx.query(
          "SELECT COUNT(*)::int AS count FROM users WHERE clan_id = $1",
          [id],
        );
        if ((Number(countRows[0]?.count) || 0) >= CONFIG.maxClanMembers) {
          throw new GameError("В клане уже 20 участников");
        }

        await tx.query("UPDATE users SET clan_id = $1 WHERE id = $2", [id, state.id]);
        return rows[0];
      });
    } catch (error) {
      if (error instanceof GameError) throw error;
      console.error(`[clan join] ${error.message}`);
      throw new GameError("Не удалось вступить в клан", 500);
    }

    state.clanId = Number(clanRow.id);
    for (const other of cache.values()) {
      if (other.clanId === state.clanId && other.id !== state.id && other.clan) {
        other.clan.memberCount += 1;
        other.clan.bonus = other.clan.memberCount * CONFIG.clanBonusPerMember;
        other.clan.bonusPercent = Math.round(other.clan.bonus * 100);
      }
    }
    await refreshClan(state, true);
    return state.clan;
  });
}

export async function leaveClan(state) {
  return enqueue(state.id, async () => {
    if (!state.clanId) throw new GameError("Ты не в клане");

    const clanId = state.clanId;
    let transferTo = null;
    let deleted = false;

    try {
      const info = await withTransaction(async (tx) => {
        const clanRows = await tx.query(
          "SELECT id, owner_id FROM clans WHERE id = $1 FOR UPDATE",
          [clanId],
        );
        if (!clanRows[0]) {
          await tx.query("UPDATE users SET clan_id = NULL WHERE id = $1", [state.id]);
          return { missing: true };
        }

        const isOwner = Number(clanRows[0].owner_id) === state.id;
        let nextOwner = null;

        if (isOwner) {
          const members = await tx.query(
            "SELECT id FROM users WHERE clan_id = $1 AND id <> $2 ORDER BY id ASC LIMIT 1",
            [clanId, state.id],
          );
          nextOwner = members[0] ? Number(members[0].id) : null;
          if (nextOwner) {
            await tx.query("UPDATE clans SET owner_id = $1 WHERE id = $2", [
              nextOwner,
              clanId,
            ]);
          } else {
            await tx.query("DELETE FROM clans WHERE id = $1", [clanId]);
            deleted = true;
          }
        }

        await tx.query("UPDATE users SET clan_id = NULL WHERE id = $1", [state.id]);
        return { nextOwner, deleted };
      });

      if (info?.nextOwner) transferTo = info.nextOwner;
    } catch (error) {
      console.error(`[clan leave] ${error.message}`);
      throw new GameError("Не удалось выйти из клана", 500);
    }

    for (const other of cache.values()) {
      if (other.id === state.id || other.clanId !== clanId) continue;
      if (deleted) {
        other.clanId = null;
        other.clan = null;
        continue;
      }
      if (!other.clan) continue;
      other.clan.memberCount = Math.max(0, other.clan.memberCount - 1);
      other.clan.bonus = other.clan.memberCount * CONFIG.clanBonusPerMember;
      other.clan.bonusPercent = Math.round(other.clan.bonus * 100);
      if (transferTo) other.clan.ownerId = transferTo;
    }

    state.clanId = null;
    state.clan = null;
    return { left: true };
  });
}

export async function listClans(state) {
  const rows = await query(
    `SELECT c.id, c.name, c.tag, c.owner_id, owner.username AS owner_name,
       (SELECT COUNT(*)::int FROM users m WHERE m.clan_id = c.id) AS member_count,
       COALESCE((SELECT SUM(m.total_clicks) FROM users m WHERE m.clan_id = c.id), 0) AS total_clicks
     FROM clans c
     LEFT JOIN users owner ON owner.id = c.owner_id
     ORDER BY total_clicks DESC, c.created_at ASC
     LIMIT 50`,
  );

  const clans = rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    tag: row.tag,
    ownerId: Number(row.owner_id),
    ownerName: row.owner_name || "?",
    memberCount: Number(row.member_count) || 0,
    totalClicks: Number(row.total_clicks) || 0,
  }));

  let mine = null;
  if (state.clanId) {
    const clan = await refreshClan(state, true);
    mine = publicClan(clan, true);
  }

  return {
    clans,
    mine,
    maxMembers: CONFIG.maxClanMembers,
    maxClans: CONFIG.maxClans,
  };
}

// Persist active players regularly. A crash can lose at most a few seconds.
const saveTimer = setInterval(() => {
  for (const state of cache.values()) {
    if (state.dirty) flushState(state);
  }
}, 2500);
saveTimer.unref?.();

// Drop idle profiles from memory after a quarter of an hour.
const evictTimer = setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [userId, state] of cache.entries()) {
    if (state.lastSeen > cutoff) continue;
    if (state.dirty) {
      flushState(state).finally(() => {
        if ((cache.get(userId)?.lastSeen || cutoff) <= cutoff) cache.delete(userId);
      });
    } else {
      cache.delete(userId);
    }
  }
}, 60_000);
evictTimer.unref?.();
