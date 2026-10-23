// Shared game configuration. Kept in sync with the Roblox build.
export const CONFIG = Object.freeze({
  gameName: "VIBE CLICKER",
  tagline: "CLICK TO IMPROVE",
  clanCreateCost: 25000,
  maxClanMembers: 20,
  clanBonusPerMember: 0.02,
  maxClans: 100,
  clickRatePerSecond: 25,
  clickBurst: 40,
  maxUsernameLength: 16,
  minUsernameLength: 3,
  minPasswordLength: 6,
  upgrades: [
    { id: "u01", amount: 1, cost: 20 },
    { id: "u02", amount: 100, cost: 150 },
    { id: "u03", amount: 1000, cost: 8000 },
    { id: "u04", amount: 10000, cost: 80000 },
    { id: "u05", amount: 100000, cost: 800000 },
    { id: "u06", amount: 1000000, cost: 8000000 },
    { id: "u07", amount: 1000000000, cost: 80000000 },
    { id: "u08", amount: 100000000000, cost: 80000000000 },
    { id: "u09", amount: 1000000000000, cost: 8000000000000 },
    { id: "u10", amount: 10000000000000, cost: 80000000000000 },
    { id: "u11", amount: 100000000000000, cost: 800000000000000 },
    { id: "u12", amount: 1000000000000000, cost: 8000000000000000 },
    { id: "u13", amount: 10000000000000000, cost: 80000000000000000 },
    { id: "u14", amount: 100000000000000000, cost: 800000000000000000 },
    { id: "u15", amount: 1000000000000000000, cost: 8000000000000000000 },
    { id: "u16", amount: 10000000000000000000, cost: 80000000000000000000 },
    { id: "u17", amount: 100000000000000000000, cost: 800000000000000000000 },
    { id: "u18", amount: 1000000000000000000000, cost: 8000000000000000000000 },
  ],
});

CONFIG.upgrades.forEach((upgrade, index) => {
  upgrade.index = index + 1;
});

export const UPGRADE_BY_ID = new Map(
  CONFIG.upgrades.map((upgrade) => [upgrade.id, upgrade]),
);

export const UNIT_LABELS = [
  [1e21, "секст"],
  [1e18, "квинт"],
  [1e15, "квадр"],
  [1e12, "трлн"],
  [1e9, "млрд"],
  [1e6, "млн"],
  [1e3, "тыс"],
];

export function formatFull(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
    Math.floor(number),
  );
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  const abs = Math.abs(number);

  if (abs < 1000) {
    const rounded = Math.round(number);
    if (Math.abs(number - rounded) < 0.005) return formatFull(rounded);
    return String(Number(number.toFixed(2))).replace(".", ",");
  }

  for (const [size, label] of UNIT_LABELS) {
    if (abs >= size) {
      const scaled = number / size;
      const decimals = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      const text = scaled
        .toFixed(decimals)
        .replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")
        .replace(".", ",");
      return `${text} ${label}`;
    }
  }

  return formatFull(number);
}

export function upgradeLabel(upgrade) {
  return `+${formatNumber(upgrade.amount)}`;
}

export function basePerClick(levels) {
  let total = 1;
  for (const upgrade of CONFIG.upgrades) {
    const level = Number(levels?.[upgrade.id]) || 0;
    if (level > 0) total += upgrade.amount * level;
  }
  return total;
}

export function totalLevels(levels) {
  let total = 0;
  for (const upgrade of CONFIG.upgrades) {
    total += Number(levels?.[upgrade.id]) || 0;
  }
  return total;
}
