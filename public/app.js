/* =========================================================
   VIBE CLICKER — client
   ========================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const dom = {
  app: $("#app"),
  loading: $("#loadingOverlay"),
  authOverlay: $("#authOverlay"),
  authForm: $("#authForm"),
  authUsername: $("#authUsername"),
  authPassword: $("#authPassword"),
  authSubmit: $("#authSubmit"),
  authError: $("#authError"),
  authTabs: $$("[data-auth]"),
  core: $("#core"),
  coreStage: $("#coreStage"),
  balance: $("#balance"),
  topBalance: $("#topBalance"),
  topPerClick: $("#topPerClick"),
  perClick: $("#perClick"),
  series: $("#series"),
  seriesBar: $("#seriesBar"),
  sideLevels: $("#sideLevels"),
  sideBar: $("#sideBar"),
  sideTarget: $("#sideTarget"),
  sideClanTag: $("#sideClanTag"),
  sideClanName: $("#sideClanName"),
  sideClanBonus: $("#sideClanBonus"),
  profileName: $("#profileName"),
  profileClan: $("#profileClan"),
  avatarLetter: $("#avatarLetter"),
  navItems: $$(".navItem"),
  panes: $$(".pane"),
  nextIndex: $("#nextIndex"),
  nextAmount: $("#nextAmount"),
  nextCost: $("#nextCost"),
  nextBar: $("#nextBar"),
  nextBuy: $("#nextBuy"),
  statClicks: $("#statClicks"),
  statLevels: $("#statLevels"),
  statBonus: $("#statBonus"),
  playClanTag: $("#playClanTag"),
  playClanName: $("#playClanName"),
  playClanBonus: $("#playClanBonus"),
  playClanAction: $("#playClanAction"),
  playClanCard: $("#playClanCard"),
  shopGrid: $("#shopGrid"),
  shopProgress: $("#shopProgress"),
  shopBar: $("#shopBar"),
  shopScroll: $("#shopScroll"),
  clanList: $("#clanList"),
  clanEmpty: $("#clanEmpty"),
  clanCount: $("#clanCount"),
  myClanCard: $("#myClanCard"),
  refreshClans: $("#refreshClans"),
  clanName: $("#clanName"),
  clanTag: $("#clanTag"),
  previewTag: $("#previewTag"),
  previewName: $("#previewName"),
  createCost: $("#createCost"),
  createBalance: $("#createBalance"),
  createClanBtn: $("#createClanBtn"),
  createBlocked: $("#createBlocked"),
  logoutBtn: $("#logoutBtn"),
  quickShop: $("#quickShop"),
  toasts: $("#toasts"),
  clickHint: $("#clickHint"),
};

let config = null;
let state = null;
let localCoins = 0;
let pendingClicks = 0;
let clickInFlight = false;
let clickTimer = null;
let series = 0;
let lastClickAt = 0;
let purchasing = false;
let authMode = "login";
let clanData = null;
let audioContext = null;
let toastTimer = null;

/* ---------------- helpers ---------------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

const UNIT_LABELS = [
  [1e21, "секст"],
  [1e18, "квинт"],
  [1e15, "квадр"],
  [1e12, "трлн"],
  [1e9, "млрд"],
  [1e6, "млн"],
  [1e3, "тыс"],
];

function formatFull(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
    Math.floor(number),
  );
}

function formatNumber(value) {
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

function pad(index) {
  return String(index).padStart(2, "0");
}

function plural(number, one, few, many) {
  const value = Math.abs(number) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function basePerClick(levels) {
  let total = 1;
  for (const upgrade of config.upgrades) {
    total += upgrade.amount * (Number(levels?.[upgrade.id]) || 0);
  }
  return total;
}

function ownedLevels() {
  return state ? state.totalLevels : 0;
}

function nextUpgrade() {
  if (!state) return config.upgrades[0];
  const unowned = config.upgrades.find((upgrade) => (state.levels[upgrade.id] || 0) === 0);
  return unowned || config.upgrades[0];
}

function clanBonusPercent() {
  if (!state?.clan) return 0;
  return Math.round(state.clan.memberCount * config.clanBonusPerMember * 100);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("Нет связи с сервером", 0);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new ApiError(data?.error || "Что-то пошло не так", response.status);
  }
  return data;
}

function toast(message, kind = "info") {
  if (!message) return;
  const element = document.createElement("div");
  element.className = `toast${kind === "error" ? " is-error" : ""}`;
  element.textContent = message;
  dom.toasts.append(element);
  while (dom.toasts.children.length > 4) dom.toasts.firstElementChild.remove();
  setTimeout(() => {
    element.classList.add("is-out");
    setTimeout(() => element.remove(), 320);
  }, 3200);
}

/* ---------------- auth ---------------- */

function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";
  for (const tab of dom.authTabs) {
    tab.classList.toggle("is-active", tab.dataset.auth === authMode);
  }
  dom.authSubmit.textContent = authMode === "login" ? "ВОЙТИ" : "СОЗДАТЬ АККАУНТ";
  dom.authPassword.autocomplete = authMode === "login" ? "current-password" : "new-password";
  dom.authError.textContent = "";
  dom.authError.classList.remove("is-warn");
}

function showAuth() {
  dom.authOverlay.hidden = false;
  dom.app.classList.add("is-hidden");
  dom.loading.classList.add("is-done");
  setTimeout(() => {
    dom.authUsername.focus();
  }, 450);
}

function authError(message) {
  dom.authError.textContent = message;
  dom.authError.classList.remove("is-warn");
  void dom.authError.offsetWidth;
  dom.authError.classList.add("is-warn");
}

async function submitAuth(event) {
  event.preventDefault();
  const username = dom.authUsername.value.trim();
  const password = dom.authPassword.value;

  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    authError("Ник: 3–16 символов, A–Z, 0–9 и _");
    dom.authUsername.focus();
    return;
  }
  if (password.length < 6) {
    authError("Пароль должен быть не короче 6 символов");
    dom.authPassword.focus();
    return;
  }

  dom.authSubmit.disabled = true;
  dom.authSubmit.textContent = authMode === "login" ? "ВХОДИМ..." : "СОЗДАЁМ...";

  try {
    const data = await api(`/api/auth/${authMode}`, {
      method: "POST",
      body: { username, password },
    });
    dom.authError.textContent = "";
    dom.authPassword.value = "";
    enterGame(data.state);
    toast(
      authMode === "login"
        ? `С возвращением, ${data.state.user.username}`
        : `Аккаунт ${data.state.user.username} создан`,
    );
  } catch (error) {
    authError(error.message);
    if (error.status === 401) {
      dom.authPassword.select();
    }
  } finally {
    dom.authSubmit.disabled = false;
    setAuthMode(authMode);
  }
}

async function logout() {
  dom.logoutBtn.disabled = true;
  try {
    await flushClicks();
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    // The cookie can be cleared locally anyway.
  } finally {
    dom.logoutBtn.disabled = false;
    state = null;
    clanData = null;
    localCoins = 0;
    pendingClicks = 0;
    series = 0;
    dom.app.classList.add("is-hidden");
    dom.authOverlay.hidden = false;
    dom.authUsername.value = "";
    dom.authPassword.value = "";
    setAuthMode("login");
    switchTab("play");
    dom.loading.classList.add("is-done");
    setTimeout(() => dom.authUsername.focus(), 300);
  }
}

/* ---------------- game state ---------------- */

function enterGame(nextState) {
  state = nextState;
  localCoins = Number(state.coins) || 0;
  pendingClicks = 0;
  clickInFlight = false;
  series = 0;
  clanData = state.clan ? { mine: state.clan, clans: [] } : null;

  dom.app.classList.remove("is-hidden");
  dom.authOverlay.hidden = true;
  dom.loading.classList.add("is-done");
  dom.shopGrid.innerHTML = "";

  renderAll();
  renderShop();
  renderClans();
  switchTab("play");
  updateStats();
  updateSeries();
}

function syncFromServer(nextState) {
  if (!nextState) return;
  state = nextState;
  localCoins = state.coins + pendingClicks * state.perClick;
  updateStats();
  updateShopLevels();
  updateSeries();
}

function updateStats() {
  if (!state) return;

  const displayedCoins = Math.max(0, localCoins);
  const clicks = state.totalClicks + pendingClicks;
  const totalLevels = state.totalLevels;
  const next = nextUpgrade();
  const bonus = clanBonusPercent();

  dom.balance.textContent = formatNumber(displayedCoins);
  dom.topBalance.textContent = formatNumber(displayedCoins);
  dom.perClick.textContent = `+${formatNumber(state.perClick)}`;
  dom.topPerClick.textContent = formatNumber(state.perClick);
  dom.sideLevels.textContent = totalLevels;
  dom.statClicks.textContent = formatNumber(clicks);
  dom.statLevels.textContent = `${totalLevels} УР.`;
  dom.statBonus.textContent = state.clan ? `+${bonus}%` : "—";

  const progress = Math.max(0, Math.min(1, displayedCoins / next.cost));
  dom.nextIndex.textContent = `${pad(next.index)} / ${pad(config.upgrades.length)}`;
  dom.nextAmount.textContent = `+${formatNumber(next.amount)}`;
  dom.nextCost.textContent = formatNumber(next.cost);
  dom.nextBar.style.width = `${progress * 100}%`;
  dom.nextBuy.disabled = displayedCoins < next.cost;
  dom.nextBuy.textContent = displayedCoins >= next.cost ? "КУПИТЬ" : "НЕ ХВАТАЕТ";

  dom.sideTarget.textContent = `ЦЕЛЬ: +${formatNumber(next.amount)}`;
  dom.sideBar.style.width = `${progress * 100}%`;

  dom.profileName.textContent = state.user.username;
  dom.avatarLetter.textContent = state.user.username.slice(0, 1).toUpperCase();
  dom.profileClan.textContent = state.clan ? `[${state.clan.tag}] ${state.clan.name}` : "БЕЗ КЛАНА";

  if (state.clan) {
    dom.sideClanTag.textContent = state.clan.tag;
    dom.sideClanName.textContent = state.clan.name;
    dom.sideClanBonus.textContent = `+${bonus}% К КЛИКУ`;
    dom.playClanTag.textContent = state.clan.tag;
    dom.playClanName.textContent = state.clan.name;
    dom.playClanBonus.textContent = `${state.clan.memberCount} ${plural(state.clan.memberCount, "УЧАСТНИК", "УЧАСТНИКА", "УЧАСТНИКОВ")} • +${bonus}%`;
    dom.playClanAction.textContent = "ОТКРЫТЬ →";
  } else {
    dom.sideClanTag.textContent = "—";
    dom.sideClanName.textContent = "НЕТ";
    dom.sideClanBonus.textContent = `+${Math.round(config.clanBonusPerMember * 100)}% ЗА УЧАСТНИКА`;
    dom.playClanTag.textContent = "";
    dom.playClanName.textContent = "БЕЗ КЛАНА";
    dom.playClanBonus.textContent = `+${Math.round(config.clanBonusPerMember * 100)}% ЗА КАЖДОГО УЧАСТНИКА`;
    dom.playClanAction.textContent = "ВСТУПИТЬ →";
  }

  updateCreateForm();
  updateAffordability();
}

function bumpBalance() {
  dom.balance.classList.add("is-bumped");
  setTimeout(() => dom.balance.classList.remove("is-bumped"), 140);
}

/* ---------------- clicks ---------------- */

function scheduleClickSend(delay = 80) {
  if (clickTimer) return;
  clickTimer = setTimeout(() => {
    clickTimer = null;
    sendClickBatch();
  }, delay);
}

async function sendClickBatch() {
  if (clickInFlight || pendingClicks <= 0 || !state) return;
  clickInFlight = true;
  const count = Math.min(40, pendingClicks);
  pendingClicks -= count;

  try {
    const data = await api("/api/click", { method: "POST", body: { count } });
    if (data?.state) {
      state = data.state;
      localCoins = state.coins + pendingClicks * state.perClick;
      updateStats();
      if (data.accepted === 0) {
        // Rate limited: let the server's authoritative value win.
        localCoins = state.coins;
        pendingClicks = 0;
      }
    }
  } catch (error) {
    pendingClicks += count;
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (error.status !== 429) toast(error.message, "error");
  } finally {
    clickInFlight = false;
    if (pendingClicks > 0) scheduleClickSend(90);
  }
}

async function flushClicks() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  let guard = 0;
  while (state && (pendingClicks > 0 || clickInFlight) && guard < 12) {
    guard += 1;
    if (!clickInFlight && pendingClicks > 0) {
      await sendClickBatch();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
}

function playClickSound() {
  try {
    if (!audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioContext = new Ctor();
    }
    if (audioContext.state === "suspended") audioContext.resume();
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(280, now);
    oscillator.frequency.exponentialRampToValueAtTime(94, now + 0.07);
    gain.gain.setValueAtTime(0.045, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
  } catch {
    // Audio is optional.
  }
}

function spawnClickEffects() {
  const stageRect = dom.coreStage.getBoundingClientRect();
  const coreRect = dom.core.getBoundingClientRect();
  const centerX = coreRect.left - stageRect.left + coreRect.width / 2;
  const centerY = coreRect.top - stageRect.top + coreRect.height / 2;

  const gain = document.createElement("span");
  gain.className = "floatGain";
  gain.textContent = `+${formatNumber(state?.perClick || 1)}`;
  gain.style.left = `${centerX + (Math.random() * 60 - 30)}px`;
  gain.style.top = `${centerY - coreRect.height * 0.16}px`;
  dom.coreStage.append(gain);
  setTimeout(() => gain.remove(), 900);

  const amount = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < amount; i += 1) {
    const spark = document.createElement("i");
    spark.className = "spark";
    const angle = Math.random() * Math.PI * 2;
    const distance = coreRect.width * (0.44 + Math.random() * 0.24);
    spark.style.left = `${centerX}px`;
    spark.style.top = `${centerY}px`;
    spark.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    spark.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
    dom.coreStage.append(spark);
    setTimeout(() => spark.remove(), 680);
  }

  const ripple = document.createElement("span");
  ripple.className = "coreRipple";
  ripple.style.left = `${centerX}px`;
  ripple.style.top = `${centerY}px`;
  ripple.style.width = `${coreRect.width}px`;
  ripple.style.height = `${coreRect.width}px`;
  ripple.style.marginLeft = `${-coreRect.width / 2}px`;
  ripple.style.marginTop = `${-coreRect.width / 2}px`;
  dom.coreStage.append(ripple);
  setTimeout(() => ripple.remove(), 750);
}

function registerClick(event) {
  if (!state) return;
  if (event?.pointerType !== undefined) event.preventDefault();

  pendingClicks += 1;
  localCoins += state.perClick;

  const now = Date.now();
  series = now - lastClickAt < 1600 ? series + 1 : 1;
  lastClickAt = now;

  bumpBalance();
  updateStats();
  updateSeries();
  spawnClickEffects();
  playClickSound();
  scheduleClickSend(75);
}

function updateSeries() {
  if (!dom.series) return;
  dom.series.textContent = series;
  dom.seriesBar.style.width = `${Math.min(100, (series / 40) * 100)}%`;
}

/* ---------------- shop ---------------- */

function renderShop() {
  if (!config || !state) return;
  dom.shopGrid.innerHTML = config.upgrades
    .map((upgrade) => {
      const level = state.levels[upgrade.id] || 0;
      return `
        <article class="shopItem${level > 0 ? " is-owned" : ""}" data-item="${upgrade.id}">
          <div class="shopTop">
            <span class="shopIndex">${pad(upgrade.index)}</span>
            <span class="shopBadge">ПОВТОРЯЕМО</span>
          </div>
          <strong class="shopAmount">+${formatNumber(upgrade.amount)}</strong>
          <span class="shopSub">К КЛИКУ ЗА ПОКУПКУ</span>
          <span class="shopLevel" data-level="${upgrade.id}">${level > 0 ? `УРОВЕНЬ ${level}` : "НЕ КУПЛЕНО"}</span>
          <button type="button" class="shopBuy" data-buy="${upgrade.id}">
            <span>КУПИТЬ</span>
            <span class="buyPrice"><span class="coin">V</span>${formatNumber(upgrade.cost)}</span>
          </button>
        </article>
      `;
    })
    .join("");
  updateShopLevels();
  updateAffordability();
}

function updateShopLevels() {
  if (!state) return;
  for (const upgrade of config.upgrades) {
    const element = dom.shopGrid.querySelector(`[data-level="${upgrade.id}"]`);
    if (!element) continue;
    const level = state.levels[upgrade.id] || 0;
    element.textContent = level > 0 ? `УРОВЕНЬ ${level}` : "НЕ КУПЛЕНО";
    element.closest(".shopItem")?.classList.toggle("is-owned", level > 0);
  }

  const owned = config.upgrades.filter((upgrade) => (state.levels[upgrade.id] || 0) > 0).length;
  dom.shopProgress.textContent = `КУПЛЕНО ${owned} ИЗ ${config.upgrades.length} ТИРОВ`;
  dom.shopBar.style.width = `${(owned / config.upgrades.length) * 100}%`;
}

function updateAffordability() {
  if (!state) return;
  const coins = Math.max(0, localCoins);
  for (const upgrade of config.upgrades) {
    const button = dom.shopGrid.querySelector(`[data-buy="${upgrade.id}"]`);
    if (!button) continue;
    const affordable = coins >= upgrade.cost;
    button.disabled = !affordable || purchasing;
    button.classList.toggle("is-unaffordable", !affordable);
  }
  dom.nextBuy.disabled = coins < nextUpgrade().cost || purchasing;
  dom.createClanBtn.disabled =
    purchasing || coins < config.clanCreateCost || Boolean(state.clan);
}

async function buyUpgrade(upgradeId) {
  if (!state || purchasing) return;
  const upgrade = config.upgrades.find((entry) => entry.id === upgradeId);
  if (!upgrade) return;
  if (localCoins < upgrade.cost) {
    toast("Недостаточно монет", "error");
    return;
  }

  purchasing = true;
  updateAffordability();

  try {
    await flushClicks();
    const data = await api("/api/purchase", {
      method: "POST",
      body: { upgradeId },
    });
    state = data.state;
    localCoins = state.coins + pendingClicks * state.perClick;
    renderShop();
    updateStats();
    toast(data.message || `Уровень ${data.level} куплен`);
    bumpBalance();
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    toast(error.message, "error");
    await refreshMe().catch(() => {});
  } finally {
    purchasing = false;
    updateAffordability();
  }
}

/* ---------------- tabs ---------------- */

function switchTab(name) {
  const target = ["play", "shop", "clans", "create"].includes(name) ? name : "play";
  for (const item of dom.navItems) {
    item.classList.toggle("is-active", item.dataset.tab === target);
  }
  for (const pane of dom.panes) {
    pane.classList.toggle("is-active", pane.id === `pane-${target}`);
  }

  if (target === "shop") renderShop();
  if (target === "clans") loadClans();
  if (target === "create") updateCreateForm();
}

/* ---------------- clans ---------------- */

async function loadClans() {
  if (!state) return;
  dom.refreshClans.disabled = true;
  try {
    await flushClicks();
    const data = await api("/api/clans");
    clanData = data;
    if (data.state) {
      state = data.state;
      localCoins = state.coins + pendingClicks * state.perClick;
    }
    renderClans();
    updateStats();
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    toast(error.message, "error");
  } finally {
    dom.refreshClans.disabled = false;
  }
}

function renderClans() {
  if (!state) return;
  renderClanList();
  renderMyClan();
}

function renderClanList() {
  const clans = clanData?.clans || [];
  dom.clanCount.textContent = `${clans.length} ${plural(clans.length, "КЛАН", "КЛАНА", "КЛАНОВ")} // ОБЩИЙ РЕЙТИНГ`;
  dom.clanEmpty.hidden = clans.length > 0;

  if (!clans.length) {
    dom.clanList.innerHTML = "";
    return;
  }

  dom.clanList.innerHTML = clans
    .map((clan, index) => {
      const isMine = state.clan?.id === clan.id;
      const full = clan.memberCount >= config.maxClanMembers;
      const inClan = Boolean(state.clan);
      const label = isMine ? "ТЫ" : full ? "ПОЛОН" : inClan ? "В КЛАНЕ" : "ВСТУПИТЬ";
      const disabled = isMine || full || inClan;
      return `
        <div class="clanRow">
          <span class="clanRank">${pad(index + 1)}</span>
          <div>
            <div class="clanRowTop">
              <span class="tagChip">${escapeHtml(clan.tag)}</span>
              <span class="clanRowName">${escapeHtml(clan.name)}</span>
            </div>
            <span class="clanRowMeta">ВЛАДЕЛЕЦ: ${escapeHtml(clan.ownerName)} • ${formatNumber(clan.totalClicks)} КЛИКОВ</span>
          </div>
          <div class="clanMembers">
            <strong>${clan.memberCount}/${config.maxClanMembers}</strong>
            <span>МЕСТ</span>
          </div>
          <button type="button" class="joinBtn" data-join="${clan.id}" ${disabled ? "disabled" : ""}>${label}</button>
        </div>
      `;
    })
    .join("");
}

function renderMyClan() {
  if (!state.clan) {
    dom.myClanCard.innerHTML = `
      <div class="noClanState">
        <span class="bigGlyph">V</span>
        <strong>ТЫ БЕЗ КЛАНА</strong>
        <p>Вступи в клан из списка или создай свой.<br />Каждый участник даёт +${Math.round(config.clanBonusPerMember * 100)}% к клику.</p>
        <button type="button" class="primaryBtn" data-create-clan>СОЗДАТЬ КЛАН</button>
      </div>
    `;
    return;
  }

  const clan = state.clan;
  const members = clan.members || [];
  const bonus = Math.round(clan.memberCount * config.clanBonusPerMember * 100);
  const isOwner = clan.ownerId === state.user.id;

  dom.myClanCard.innerHTML = `
    <div class="myClanHead">
      <div>
        <span class="eyebrow">ТВОЙ КЛАН</span>
        <h3 class="myClanTitle">${escapeHtml(clan.name)}</h3>
        <span class="myClanSub">${isOwner ? "ТЫ ВЛАДЕЛЕЦ" : "УЧАСТНИК"} • ${clan.memberCount}/${config.maxClanMembers} МЕСТ</span>
      </div>
      <span class="myClanTag">${escapeHtml(clan.tag)}</span>
    </div>
    <div class="bonusBox">
      <span>БОНУС К КЛИКУ</span>
      <strong>+${bonus}%</strong>
    </div>
    <ul class="memberList">
      ${members
        .map(
          (member) => `
            <li>
              <span class="memberAvatar">${escapeHtml(member.username.slice(0, 1).toUpperCase())}</span>
              <span class="memberName">${escapeHtml(member.username)}</span>
              ${member.isOwner ? '<span class="ownerTag">ВЛАДЕЛЕЦ</span>' : ""}
              <span class="memberClicks">${formatNumber(member.totalClicks)}</span>
            </li>
          `,
        )
        .join("")}
    </ul>
    <button type="button" class="dangerBtn" data-leave-clan>ВЫЙТИ ИЗ КЛАНА</button>
  `;
}

async function joinClan(clanId) {
  if (!state || state.clan) return;
  try {
    await flushClicks();
    const data = await api(`/api/clans/${clanId}/join`, {
      method: "POST",
      body: {},
    });
    state = data.state;
    localCoins = state.coins + pendingClicks * state.perClick;
    toast(data.message);
    await loadClans();
    updateStats();
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    toast(error.message, "error");
  }
}

let leaveArmed = false;
let leaveTimer = null;

async function leaveClan(button) {
  if (!state?.clan) return;
  if (!leaveArmed) {
    leaveArmed = true;
    button.textContent = "ТОЧНО ВЫЙТИ? НАЖМИ ЕЩЁ РАЗ";
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      leaveArmed = false;
      button.textContent = "ВЫЙТИ ИЗ КЛАНА";
    }, 3500);
    return;
  }

  leaveArmed = false;
  clearTimeout(leaveTimer);
  button.disabled = true;
  button.textContent = "ВЫХОДИМ...";

  try {
    await flushClicks();
    const data = await api("/api/clans/leave", { method: "POST", body: {} });
    state = data.state;
    localCoins = state.coins + pendingClicks * state.perClick;
    toast(data.message);
    await loadClans();
    updateStats();
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = "ВЫЙТИ ИЗ КЛАНА";
  }
}

function updateCreateForm() {
  if (!config || !state) return;
  dom.createCost.textContent = formatFull(config.clanCreateCost);
  dom.createBalance.textContent = `У ТЕБЯ: ${formatNumber(Math.max(0, localCoins))}`;

  const hasClan = Boolean(state.clan);
  const enough = localCoins >= config.clanCreateCost;
  dom.createClanBtn.disabled = hasClan || !enough || purchasing;
  dom.createBlocked.classList.toggle("is-warn", hasClan || !enough);
  dom.createBlocked.textContent = hasClan
    ? "ТЫ УЖЕ В КЛАНЕ — СНАЧАЛА ВЫЙДИ ИЗ ТЕКУЩЕГО"
    : enough
      ? "ГОТОВО К СОЗДАНИЮ"
      : `НЕ ХВАТАЕТ ${formatNumber(config.clanCreateCost - localCoins)} МОНЕТ`;

  const name = dom.clanName.value.trim();
  const tag = dom.clanTag.value.trim().toUpperCase();
  dom.previewName.textContent = name ? name.toUpperCase() : "НАЗВАНИЕ КЛАНА";
  dom.previewTag.textContent = tag || "??";
}

async function createClan() {
  if (!state || purchasing) return;
  const name = dom.clanName.value.trim();
  const tag = dom.clanTag.value.trim().toUpperCase();

  if (name.length < 3 || name.length > 20) {
    toast("Название: от 3 до 20 символов", "error");
    dom.clanName.focus();
    return;
  }
  if (!/^[A-Z0-9]{2,4}$/.test(tag)) {
    toast("Тег: 2–4 символа, только A–Z и 0–9", "error");
    dom.clanTag.focus();
    return;
  }
  if (state.clan) {
    toast("Ты уже в клане", "error");
    return;
  }

  purchasing = true;
  dom.createClanBtn.disabled = true;
  dom.createClanBtn.textContent = "СОЗДАЁМ...";

  try {
    await flushClicks();
    const data = await api("/api/clans", {
      method: "POST",
      body: { name, tag },
    });
    state = data.state;
    localCoins = state.coins + pendingClicks * state.perClick;
    dom.clanName.value = "";
    dom.clanTag.value = "";
    updateCreateForm();
    updateStats();
    toast(data.message);
    await loadClans();
    switchTab("clans");
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    toast(error.message, "error");
  } finally {
    purchasing = false;
    dom.createClanBtn.textContent = "СОЗДАТЬ КЛАН";
    updateCreateForm();
    updateAffordability();
  }
}

/* ---------------- misc ---------------- */

async function refreshMe() {
  const data = await api("/api/me");
  if (data?.state) {
    state = data.state;
    localCoins = state.coins + pendingClicks * state.perClick;
    updateStats();
    renderShop();
    renderClans();
  }
}

function handleUnauthorized() {
  state = null;
  pendingClicks = 0;
  dom.app.classList.add("is-hidden");
  dom.authOverlay.hidden = false;
  dom.loading.classList.add("is-done");
  authError("Сессия истекла — войди снова");
  toast("Сессия истекла", "error");
}

async function bootstrap() {
  try {
    config = await api("/api/config");
  } catch {
    dom.loading.querySelector("em").textContent = "СЕРВЕР НЕДОСТУПЕН — ОБНОВИ СТРАНИЦУ";
    return;
  }

  setAuthMode("login");
  dom.createCost.textContent = formatFull(config.clanCreateCost);

  try {
    const data = await api("/api/me");
    enterGame(data.state);
  } catch (error) {
    if (error.status === 401) {
      ctxDelayAuth();
    } else {
      dom.loading.querySelector("em").textContent = "НЕ УДАЛОСЬ ЗАГРУЗИТЬ ПРОФИЛЬ";
      setTimeout(ctxDelayAuth, 1400);
    }
  }
}

function ctxDelayAuth() {
  setTimeout(showAuth, 420);
}

/* ---------------- events ---------------- */

dom.authTabs.forEach((tab) => {
  tab.addEventListener("click", () => setAuthMode(tab.dataset.auth));
});
dom.authForm.addEventListener("submit", submitAuth);
dom.logoutBtn.addEventListener("click", logout);

dom.core.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  dom.core.classList.add("is-pressed");
  registerClick(event);
});

dom.core.addEventListener("pointerup", () => dom.core.classList.remove("is-pressed"));
dom.core.addEventListener("pointercancel", () => dom.core.classList.remove("is-pressed"));
dom.core.addEventListener("pointerleave", () => dom.core.classList.remove("is-pressed"));
dom.core.addEventListener("contextmenu", (event) => event.preventDefault());
dom.core.addEventListener("click", (event) => {
  // Keyboard activation produces a click with detail 0; pointer clicks are
  // already handled on pointerdown so they are not counted twice.
  if (event.detail === 0) registerClick(event);
});

for (const item of dom.navItems) {
  item.addEventListener("click", () => switchTab(item.dataset.tab));
}
dom.quickShop.addEventListener("click", () => switchTab("shop"));
dom.playClanCard.addEventListener("click", () => switchTab("clans"));

dom.nextBuy.addEventListener("click", () => buyUpgrade(nextUpgrade().id));

dom.shopGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-buy]");
  if (!button) return;
  buyUpgrade(button.dataset.buy);
});

dom.refreshClans.addEventListener("click", loadClans);

dom.clanList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-join]");
  if (!button) return;
  joinClan(Number(button.dataset.join));
});

dom.myClanCard.addEventListener("click", (event) => {
  if (event.target.closest("[data-leave-clan]")) {
    leaveClan(event.target.closest("[data-leave-clan]"));
  }
  if (event.target.closest("[data-create-clan]")) {
    switchTab("create");
  }
});

dom.clanName.addEventListener("input", updateCreateForm);
dom.clanTag.addEventListener("input", () => {
  const clean = dom.clanTag.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (dom.clanTag.value !== clean) dom.clanTag.value = clean;
  updateCreateForm();
});
dom.createClanBtn.addEventListener("click", createClan);

document.addEventListener("keydown", (event) => {
  if (!state) return;
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    registerClick();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state) flushClicks();
});

window.addEventListener("pagehide", () => {
  if (!state || clickInFlight || pendingClicks <= 0) return;
  try {
    const blob = new Blob([JSON.stringify({ count: Math.min(40, pendingClicks) })], {
      type: "application/json",
    });
    navigator.sendBeacon("/api/click", blob);
  } catch {
    // Ignore unload failures.
  }
});

setInterval(() => {
  if (series > 0 && Date.now() - lastClickAt > 1600) {
    series = 0;
    updateSeries();
  }
}, 250);

setInterval(() => {
  if (!state) return;
  updateAffordability();
  updateCreateForm();
}, 1500);

bootstrap();
