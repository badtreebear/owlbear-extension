/**
 * Owlbear Rodeo Extension — Claude MCP Bridge
 *
 * Runs inside an iframe within Owlbear Rodeo.
 * Opens a WebSocket to the local MCP server and handles
 * commands by calling the OBR SDK APIs.
 */

import OBR, { buildShape, buildLabel, buildImage, isImage } from "@owlbear-rodeo/sdk";

// ─── Token image URLs ─────────────────────────────────────────────────────────
const TOKEN_BASE = "https://raw.githubusercontent.com/Agamador/OwlBear-llm-chat/main/public/tokens";
const TOKEN_URLS = {
  KNIGHT: `${TOKEN_BASE}/knight.png`, ARCHER: `${TOKEN_BASE}/archer.png`,
  HUMAN:  `${TOKEN_BASE}/human.png`,  WOMAN:  `${TOKEN_BASE}/woman.png`,
  CHILD:  `${TOKEN_BASE}/child.png`,  ORC:    `${TOKEN_BASE}/orc.png`,
  GOBLIN: `${TOKEN_BASE}/goblin.png`, DRAGON: `${TOKEN_BASE}/dragon.png`,
  GOLEM:  `${TOKEN_BASE}/golem.png`,  BOOK:   `${TOKEN_BASE}/book.png`,
  CHEST:  `${TOKEN_BASE}/chest.png`,  SWORD:  `${TOKEN_BASE}/sword.png`,
  TORCH:  `${TOKEN_BASE}/torch.png`,
};

const MCP_SERVER_URL = "ws://localhost:3457";
const EXTENSION_ID   = "com.claude.dm-assistant";

// ─── State ────────────────────────────────────────────────────────────────────

let initiativeOrder  = [];
let currentTurnIndex = 0;
let round            = 0;
let inCombat         = false;
let aoeItemIds       = [];
let movementRangeIds = [];
let lightAttachments = {};

// ─── WebSocket connection ─────────────────────────────────────────────────────

let ws = null;

function connectWS() {
  ws = new WebSocket(MCP_SERVER_URL);
  ws.onopen  = () => { updateStatus("Connected to Claude", "green"); };
  ws.onclose = () => { updateStatus("Reconnecting...", "orange"); setTimeout(connectWS, 3000); };
  ws.onerror = (e) => { console.error("[claude-bridge] WS error:", e); };
  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    try {
      const result = await handleCommand(msg.command, msg.payload || {});
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, error: err.message }));
    }
  };
}

// ─── Command handler ──────────────────────────────────────────────────────────

async function handleCommand(command, payload) {
  switch (command) {

    // ── Initiative ────────────────────────────────────────────────────────────
    case "GET_INITIATIVE":
      return { order: initiativeOrder, currentTurn: initiativeOrder[currentTurnIndex]?.name ?? null, round, inCombat };

    case "SET_INITIATIVE": {
      const { token_name, initiative } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      const existing = initiativeOrder.find((e) => e.tokenId === token.id);
      if (existing) { existing.initiative = initiative; }
      else {
        initiativeOrder.push({
          tokenId: token.id, name: token_name, initiative,
          hp: token.metadata?.[`${EXTENSION_ID}/hp`] ?? null,
          maxHp: token.metadata?.[`${EXTENSION_ID}/maxHp`] ?? null,
          conditions: token.metadata?.[`${EXTENSION_ID}/conditions`] ?? [],
          speed: token.metadata?.[`${EXTENSION_ID}/speed`] ?? 30,
          movementUsed: 0, actionUsed: false, bonusActionUsed: false, reactionUsed: false,
        });
      }
      initiativeOrder.sort((a, b) => b.initiative - a.initiative);
      renderInitiativeUI();
      return { success: true };
    }

    case "START_COMBAT":
      inCombat = true; round = 1; currentTurnIndex = 0;
      initiativeOrder.forEach((e) => { e.movementUsed = 0; e.actionUsed = false; e.bonusActionUsed = false; e.reactionUsed = false; });
      await highlightActiveTurn();
      renderInitiativeUI();
      await OBR.notification.show(`⚔️ Combat begins! Round 1 — ${initiativeOrder[0]?.name ?? "nobody"}'s turn`, "INFO");
      return { firstTurn: initiativeOrder[0]?.name ?? null };

    case "NEXT_TURN": {
      if (!inCombat) throw new Error("Not in combat");
      const ending = initiativeOrder[currentTurnIndex];
      if (ending) { ending.movementUsed = 0; ending.actionUsed = false; ending.bonusActionUsed = false; ending.reactionUsed = false; }
      currentTurnIndex = (currentTurnIndex + 1) % initiativeOrder.length;
      if (currentTurnIndex === 0) round++;
      await clearMovementRange();
      await highlightActiveTurn();
      renderInitiativeUI();
      const current = initiativeOrder[currentTurnIndex];
      await OBR.notification.show(`🎲 Round ${round} — ${current?.name}'s turn`, "INFO");
      return { currentTurn: current?.name, round };
    }

    case "END_COMBAT":
      inCombat = false; round = 0; currentTurnIndex = 0; initiativeOrder = [];
      await clearMovementRange(); await clearAOE();
      renderInitiativeUI();
      return { success: true };

    // ── Token position ────────────────────────────────────────────────────────
    case "GET_TOKEN_POSITION": {
      const { token_name } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      const gridInfo = await OBR.scene.grid.getInfo();
      return { name: token_name, pixel_x: token.position.x, pixel_y: token.position.y, grid_x: Math.round(token.position.x / gridInfo.dpi), grid_y: Math.round(token.position.y / gridInfo.dpi) };
    }

    case "MOVE_TOKEN": {
      const { token_name, grid_x, grid_y } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      const gridInfo = await OBR.scene.grid.getInfo();
      const dpi = gridInfo.dpi;
      const distanceFt = Math.max(Math.abs(grid_x - Math.round(token.position.x / dpi)), Math.abs(grid_y - Math.round(token.position.y / dpi))) * (gridInfo.measurement?.feet ?? 5);
      const combatEntry = initiativeOrder.find((e) => e.tokenId === token.id);
      if (combatEntry) {
        const remaining = (combatEntry.speed ?? 30) - combatEntry.movementUsed;
        if (distanceFt > remaining) throw new Error(`Not enough movement. ${token_name} has ${remaining}ft remaining but needs ${distanceFt}ft.`);
        combatEntry.movementUsed += distanceFt;
      }
      await OBR.scene.items.updateItems([token.id], (items) => { for (const item of items) item.position = { x: grid_x * dpi, y: grid_y * dpi }; });
      return { success: true, distance_ft: distanceFt, remaining_ft: combatEntry ? (combatEntry.speed ?? 30) - combatEntry.movementUsed : null };
    }

    case "GET_DISTANCE": {
      const { token_a, token_b } = payload;
      const a = await findTokenByName(token_a); const b = await findTokenByName(token_b);
      if (!a) throw new Error(`Token not found: ${token_a}`);
      if (!b) throw new Error(`Token not found: ${token_b}`);
      const gridInfo = await OBR.scene.grid.getInfo();
      const dpi = gridInfo.dpi; const fps = gridInfo.measurement?.feet ?? 5;
      const squares = Math.max(Math.abs(a.position.x - b.position.x) / dpi, Math.abs(a.position.y - b.position.y) / dpi);
      return { distance_ft: squares * fps, grid_squares: squares };
    }

    case "GET_TOKENS_IN_RANGE": {
      const { token_name, range_ft } = payload;
      const center = await findTokenByName(token_name);
      if (!center) throw new Error(`Token not found: ${token_name}`);
      const gridInfo = await OBR.scene.grid.getInfo();
      const dpi = gridInfo.dpi; const fps = gridInfo.measurement?.feet ?? 5;
      const rangeSquares = range_ft / fps;
      const allTokens = await OBR.scene.items.getItems((item) => item.layer === "CHARACTER" && isImage(item));
      const nearby = allTokens
        .filter((t) => t.id !== center.id && Math.max(Math.abs(t.position.x - center.position.x) / dpi, Math.abs(t.position.y - center.position.y) / dpi) <= rangeSquares)
        .map((t) => ({ name: t.name, distance_ft: Math.max(Math.abs(t.position.x - center.position.x) / dpi, Math.abs(t.position.y - center.position.y) / dpi) * fps }));
      return { tokens: nearby, center: token_name, range_ft };
    }

    // ── HP & Conditions ───────────────────────────────────────────────────────
    case "GET_TOKEN_STATS": {
      const { token_name } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      return { name: token_name, hp: token.metadata?.[`${EXTENSION_ID}/hp`] ?? "not set", maxHp: token.metadata?.[`${EXTENSION_ID}/maxHp`] ?? "not set", conditions: token.metadata?.[`${EXTENSION_ID}/conditions`] ?? [], speed: token.metadata?.[`${EXTENSION_ID}/speed`] ?? 30 };
    }

    case "UPDATE_HP": {
      const { token_name, new_hp, max_hp } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      await OBR.scene.items.updateItems([token.id], (items) => { for (const item of items) { item.metadata[`${EXTENSION_ID}/hp`] = new_hp; if (max_hp !== undefined) item.metadata[`${EXTENSION_ID}/maxHp`] = max_hp; } });
      const entry = initiativeOrder.find((e) => e.tokenId === token.id);
      if (entry) { entry.hp = new_hp; if (max_hp !== undefined) entry.maxHp = max_hp; }
      if (new_hp <= 0) await OBR.notification.show(`💀 ${token_name} is down!`, "ERROR");
      renderInitiativeUI();
      return { success: true, hp: new_hp, max_hp: max_hp ?? token.metadata?.[`${EXTENSION_ID}/maxHp`] ?? null };
    }

    case "ADD_CONDITION": {
      const { token_name, condition, duration_rounds } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      const current = token.metadata?.[`${EXTENSION_ID}/conditions`] ?? [];
      if (!current.includes(condition)) current.push(condition);
      await OBR.scene.items.updateItems([token.id], (items) => { for (const item of items) { item.metadata[`${EXTENSION_ID}/conditions`] = current; if (duration_rounds) item.metadata[`${EXTENSION_ID}/condition_${condition}_expires`] = round + duration_rounds; } });
      const entry = initiativeOrder.find((e) => e.tokenId === token.id);
      if (entry) entry.conditions = current;
      renderInitiativeUI();
      return { success: true };
    }

    case "REMOVE_CONDITION": {
      const { token_name, condition } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      const current = (token.metadata?.[`${EXTENSION_ID}/conditions`] ?? []).filter((c) => c !== condition);
      await OBR.scene.items.updateItems([token.id], (items) => { for (const item of items) item.metadata[`${EXTENSION_ID}/conditions`] = current; });
      const entry = initiativeOrder.find((e) => e.tokenId === token.id);
      if (entry) entry.conditions = current;
      renderInitiativeUI();
      return { success: true };
    }

    // ── Scene overlays ────────────────────────────────────────────────────────
    case "SHOW_AOE": {
      const { shape, center_token, grid_x, grid_y, radius_ft, length_ft, color = "#ff6600", label } = payload;
      const gridInfo = await OBR.scene.grid.getInfo();
      const dpi = gridInfo.dpi; const fps = gridInfo.measurement?.feet ?? 5;
      let cx = (grid_x ?? 0) * dpi; let cy = (grid_y ?? 0) * dpi;
      if (center_token) { const t = await findTokenByName(center_token); if (t) { cx = t.position.x; cy = t.position.y; } }
      const radiusPx = ((radius_ft ?? length_ft ?? 20) / fps) * dpi;
      const aoeShape = buildShape().width(radiusPx * 2).height(radiusPx * 2).shapeType(shape === "circle" ? "CIRCLE" : "RECTANGLE").position({ x: cx - radiusPx, y: cy - radiusPx }).fillColor(color).fillOpacity(0.3).strokeColor(color).strokeOpacity(0.8).strokeWidth(2).layer("DRAWING").locked(true).build();
      await OBR.scene.items.addItems([aoeShape]);
      aoeItemIds.push(aoeShape.id);
      if (label) { const lbl = buildLabel().plainText(label).position({ x: cx, y: cy }).layer("TEXT").build(); await OBR.scene.items.addItems([lbl]); aoeItemIds.push(lbl.id); }
      const allTokens = await OBR.scene.items.getItems((item) => item.layer === "CHARACTER" && isImage(item));
      const tokensHit = allTokens.filter((t) => Math.max(Math.abs(t.position.x - cx) / dpi, Math.abs(t.position.y - cy) / dpi) <= radiusPx / dpi).map((t) => t.name);
      return { success: true, tokens_hit: tokensHit };
    }

    case "CLEAR_AOE": await clearAOE(); return { success: true };

    case "SHOW_MOVEMENT_RANGE": {
      const { token_name, remaining_ft } = payload;
      await clearMovementRange();
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      const gridInfo = await OBR.scene.grid.getInfo();
      const radiusPx = (remaining_ft / (gridInfo.measurement?.feet ?? 5)) * gridInfo.dpi;
      const overlay = buildShape().width(radiusPx * 2).height(radiusPx * 2).shapeType("CIRCLE").position({ x: token.position.x - radiusPx, y: token.position.y - radiusPx }).fillColor("#4488ff").fillOpacity(0.15).strokeColor("#4488ff").strokeOpacity(0.6).strokeWidth(2).layer("DRAWING").locked(true).build();
      await OBR.scene.items.addItems([overlay]);
      movementRangeIds.push(overlay.id);
      return { success: true };
    }

    case "PING_LOCATION": {
      const { grid_x, grid_y, color = "#ffff00" } = payload;
      const gridInfo = await OBR.scene.grid.getInfo(); const dpi = gridInfo.dpi;
      const ping = buildShape().width(dpi * 0.6).height(dpi * 0.6).shapeType("CIRCLE").position({ x: grid_x * dpi - dpi * 0.3, y: grid_y * dpi - dpi * 0.3 }).fillColor(color).fillOpacity(0.7).strokeColor("#ffffff").strokeWidth(2).layer("DRAWING").locked(true).build();
      await OBR.scene.items.addItems([ping]);
      setTimeout(async () => { await OBR.scene.items.deleteItems([ping.id]); }, 3000);
      return { success: true };
    }

    // ── Scene info ────────────────────────────────────────────────────────────
    case "GET_ALL_TOKENS": {
      const tokens = await OBR.scene.items.getItems((item) => item.layer === "CHARACTER" && isImage(item));
      const gridInfo = await OBR.scene.grid.getInfo(); const dpi = gridInfo.dpi;
      return tokens.map((t) => ({ id: t.id, name: t.name, grid_x: Math.round(t.position.x / dpi), grid_y: Math.round(t.position.y / dpi), hp: t.metadata?.[`${EXTENSION_ID}/hp`] ?? null, maxHp: t.metadata?.[`${EXTENSION_ID}/maxHp`] ?? null, conditions: t.metadata?.[`${EXTENSION_ID}/conditions`] ?? [], speed: t.metadata?.[`${EXTENSION_ID}/speed`] ?? 30, visible: t.visible }));
    }

    case "GET_PLAYERS": {
      const party = await OBR.party.getPlayers(); const me = await OBR.player.getName();
      return { players: party.map((p) => ({ name: p.name, role: p.role, color: p.color, connected: true })), gm: me };
    }

    case "GET_GRID_INFO": {
      const info = await OBR.scene.grid.getInfo();
      return { dpi: info.dpi, type: info.type, feet_per_square: info.measurement?.feet ?? 5 };
    }

    case "NOTIFY": {
      const { message, type = "INFO" } = payload;
      await OBR.notification.show(message, type);
      return { success: true };
    }

    // ── Scene setup ───────────────────────────────────────────────────────────
    case "LOAD_MAP": {
      const { map_type } = payload;
      const MAP_URLS = {
        FOREST: "https://i.imgur.com/forest_map.jpg", VILLAGE: "https://i.imgur.com/village_map.jpg",
        LONELY_CABIN: "https://i.imgur.com/cabin_map.jpg", BATTLE_ARENA: "https://i.imgur.com/arena_map.jpg",
        DUNGEON: "https://i.imgur.com/dungeon_map.jpg", TAVERN: "https://i.imgur.com/tavern_map.jpg",
        CAVE: "https://i.imgur.com/cave_map.jpg", RUINS: "https://i.imgur.com/ruins_map.jpg",
      };
      const url = MAP_URLS[map_type];
      if (!url) throw new Error(`Unknown map type: ${map_type}`);
      const existing = await OBR.scene.items.getItems((item) => item.layer === "MAP");
      if (existing.length > 0) await OBR.scene.items.deleteItems(existing.map((i) => i.id));
      const mapImage = buildImage({ url, width: 2048, height: 2048 }, { dpi: 150, offset: { x: 0, y: 0 } }).position({ x: 0, y: 0 }).layer("MAP").locked(true).name(map_type).build();
      await OBR.scene.items.addItems([mapImage]);
      return { success: true };
    }

    case "CLEAR_SCENE": {
      const allItems = await OBR.scene.items.getItems((item) => item.layer !== "MAP");
      if (allItems.length > 0) await OBR.scene.items.deleteItems(allItems.map((i) => i.id));
      initiativeOrder = []; currentTurnIndex = 0; round = 0; inCombat = false;
      aoeItemIds = []; movementRangeIds = []; lightAttachments = {};
      renderInitiativeUI();
      return { success: true };
    }

    // ── Token spawning ────────────────────────────────────────────────────────
    case "SPAWN_TOKEN": {
      const { name, type, grid_x, grid_y, size = 1, hp, max_hp, speed = 30, is_player = false } = payload;
      const gridInfo = await OBR.scene.grid.getInfo(); const dpi = gridInfo.dpi;
      const token = buildImage({ url: TOKEN_URLS[type] ?? TOKEN_URLS.HUMAN, width: dpi * size, height: dpi * size }, { dpi, offset: { x: dpi * size / 2, y: dpi * size / 2 } }).position({ x: grid_x * dpi, y: grid_y * dpi }).layer("CHARACTER").name(name).metadata({ [`${EXTENSION_ID}/hp`]: hp ?? null, [`${EXTENSION_ID}/maxHp`]: max_hp ?? hp ?? null, [`${EXTENSION_ID}/speed`]: speed, [`${EXTENSION_ID}/conditions`]: [], [`${EXTENSION_ID}/isPlayer`]: is_player }).build();
      await OBR.scene.items.addItems([token]);
      return { success: true, tokenId: token.id };
    }

    case "SPAWN_ENCOUNTER": {
      const { encounter_name, tokens } = payload;
      const gridInfo = await OBR.scene.grid.getInfo(); const dpi = gridInfo.dpi;
      const items = tokens.map(({ name, type, grid_x, grid_y, size = 1, hp, max_hp, speed = 30, is_player = false }) =>
        buildImage({ url: TOKEN_URLS[type] ?? TOKEN_URLS.HUMAN, width: dpi * size, height: dpi * size }, { dpi, offset: { x: dpi * size / 2, y: dpi * size / 2 } }).position({ x: grid_x * dpi, y: grid_y * dpi }).layer("CHARACTER").name(name).metadata({ [`${EXTENSION_ID}/hp`]: hp ?? null, [`${EXTENSION_ID}/maxHp`]: max_hp ?? hp ?? null, [`${EXTENSION_ID}/speed`]: speed, [`${EXTENSION_ID}/conditions`]: [], [`${EXTENSION_ID}/isPlayer`]: is_player }).build()
      );
      await OBR.scene.items.addItems(items);
      await OBR.notification.show(`⚔️ Encounter "${encounter_name}" loaded — ${items.length} tokens placed`, "INFO");
      return { success: true, spawned: items.length };
    }

    case "DELETE_TOKEN": {
      const { token_name } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      await OBR.scene.items.deleteItems([token.id]);
      initiativeOrder = initiativeOrder.filter((e) => e.tokenId !== token.id);
      renderInitiativeUI();
      return { success: true };
    }

    // ── Fog of war ────────────────────────────────────────────────────────────
    case "FILL_FOG":  await OBR.scene.fog.setFilled(true);  return { success: true };
    case "CLEAR_FOG": await OBR.scene.fog.setFilled(false); return { success: true };

    case "REVEAL_AREA": {
      const { grid_x, grid_y, radius_ft } = payload;
      const gridInfo = await OBR.scene.grid.getInfo();
      const radiusPx = (radius_ft / (gridInfo.measurement?.feet ?? 5)) * gridInfo.dpi;
      const visionCircle = buildShape().position({ x: grid_x * gridInfo.dpi - radiusPx, y: grid_y * gridInfo.dpi - radiusPx }).width(radiusPx * 2).height(radiusPx * 2).shapeType("CIRCLE").fillColor("#000000").fillOpacity(0).strokeOpacity(0).layer("FOG").locked(true).build();
      await OBR.scene.items.addItems([visionCircle]);
      return { success: true };
    }

    // ── Lighting ──────────────────────────────────────────────────────────────
    case "ADD_LIGHT": {
      const { token_name, radius_ft, color = "#ffcc66" } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      const gridInfo = await OBR.scene.grid.getInfo();
      const radiusPx = (radius_ft / (gridInfo.measurement?.feet ?? 5)) * gridInfo.dpi;
      if (lightAttachments[token.id]) await OBR.scene.items.deleteItems([lightAttachments[token.id]]);
      const light = buildShape().width(radiusPx * 2).height(radiusPx * 2).shapeType("CIRCLE").position({ x: token.position.x - radiusPx, y: token.position.y - radiusPx }).fillColor(color).fillOpacity(0.12).strokeColor(color).strokeOpacity(0.3).strokeWidth(1).layer("DRAWING").attachedTo(token.id).locked(true).build();
      await OBR.scene.items.addItems([light]);
      lightAttachments[token.id] = light.id;
      return { success: true };
    }

    case "REMOVE_LIGHT": {
      const { token_name } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      if (lightAttachments[token.id]) { await OBR.scene.items.deleteItems([lightAttachments[token.id]]); delete lightAttachments[token.id]; }
      return { success: true };
    }

    // ── Camera ────────────────────────────────────────────────────────────────
    case "FOCUS_CAMERA": {
      const { token_name } = payload;
      const token = await findTokenByName(token_name);
      if (!token) throw new Error(`Token not found: ${token_name}`);
      await OBR.viewport.animateTo({ position: token.position, scale: 1.5 });
      return { success: true };
    }

    default: throw new Error(`Unknown command: ${command}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findTokenByName(name) {
  const tokens = await OBR.scene.items.getItems((item) => item.layer === "CHARACTER" && isImage(item));
  return tokens.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
}

async function clearAOE() { if (aoeItemIds.length > 0) { await OBR.scene.items.deleteItems(aoeItemIds); aoeItemIds = []; } }
async function clearMovementRange() { if (movementRangeIds.length > 0) { await OBR.scene.items.deleteItems(movementRangeIds); movementRangeIds = []; } }
async function highlightActiveTurn() { const c = initiativeOrder[currentTurnIndex]; if (c) await OBR.player.select([c.tokenId]); }

// ─── UI ───────────────────────────────────────────────────────────────────────

function updateStatus(text, color) { const el = document.getElementById("status"); if (el) { el.textContent = text; el.style.color = color; } }

function renderInitiativeUI() {
  const list = document.getElementById("initiative-list");
  if (!list) return;
  if (initiativeOrder.length === 0) { list.innerHTML = `<div class="empty">No initiative set.<br>Right-click tokens to add.</div>`; return; }
  list.innerHTML = initiativeOrder.map((entry, i) => {
    const isActive = inCombat && i === currentTurnIndex;
    const hpText = entry.hp !== null ? `${entry.hp}${entry.maxHp ? `/${entry.maxHp}` : ""} HP` : "";
    const condText = entry.conditions?.length > 0 ? entry.conditions.join(", ") : "";
    return `<div class="initiative-entry ${isActive ? "active" : ""}">
      <span class="init-num">${entry.initiative}</span>
      <div class="init-info">
        <span class="init-name">${entry.name}</span>
        ${hpText ? `<span class="init-hp">${hpText}</span>` : ""}
        ${condText ? `<span class="init-conditions">${condText}</span>` : ""}
      </div>
      ${isActive ? '<span class="turn-arrow">▶</span>' : ""}
    </div>`;
  }).join("");
}

function setupContextMenu() {
  OBR.contextMenu.create({ id: `${EXTENSION_ID}/set-speed`, icons: [{ icon: "/icon.svg", label: "Set Speed (ft)", filter: { roles: ["GM"] } }], async onClick(context) {
    const speed = parseInt(window.prompt("Movement speed in feet:", "30"), 10);
    if (isNaN(speed)) return;
    await OBR.scene.items.updateItems(context.items, (items) => { for (const item of items) item.metadata[`${EXTENSION_ID}/speed`] = speed; });
    const entry = initiativeOrder.find((e) => e.tokenId === context.items[0]?.id);
    if (entry) entry.speed = speed;
  }});
  OBR.contextMenu.create({ id: `${EXTENSION_ID}/set-hp`, icons: [{ icon: "/icon.svg", label: "Set HP", filter: { roles: ["GM"] } }], async onClick(context) {
    const input = window.prompt("Enter HP (e.g. 45/52):", "");
    if (!input) return;
    const [cur, max] = input.split("/").map(Number);
    await OBR.scene.items.updateItems(context.items, (items) => { for (const item of items) { item.metadata[`${EXTENSION_ID}/hp`] = cur; if (max) item.metadata[`${EXTENSION_ID}/maxHp`] = max; } });
    const entry = initiativeOrder.find((e) => e.tokenId === context.items[0]?.id);
    if (entry) { entry.hp = cur; if (max) entry.maxHp = max; }
    renderInitiativeUI();
  }});
}

function watchTokenMovement() {
  let previousPositions = {};
  OBR.scene.items.onChange(async (items) => {
    for (const item of items) {
      if (item.layer !== "CHARACTER" || !isImage(item)) continue;
      const prev = previousPositions[item.id];
      if (!prev) { previousPositions[item.id] = { ...item.position }; continue; }
      if (prev.x === item.position.x && prev.y === item.position.y) continue;
      previousPositions[item.id] = { ...item.position };
      const entry = initiativeOrder.find((e) => e.tokenId === item.id);
      if (!entry || !inCombat) continue;
      const gridInfo = await OBR.scene.grid.getInfo();
      const dpi = gridInfo.dpi; const fps = gridInfo.measurement?.feet ?? 5;
      const ftMoved = Math.max(Math.abs(item.position.x - prev.x) / dpi, Math.abs(item.position.y - prev.y) / dpi) * fps;
      entry.movementUsed += ftMoved;
      const remaining = Math.max(0, (entry.speed ?? 30) - entry.movementUsed);
      await OBR.notification.show(`${entry.name} moved ${ftMoved}ft — ${remaining}ft remaining`, remaining === 0 ? "WARNING" : "INFO");
      if (remaining > 0) {
        await clearMovementRange();
        const radiusPx = (remaining / fps) * dpi;
        const overlay = buildShape().width(radiusPx * 2).height(radiusPx * 2).shapeType("CIRCLE").position({ x: item.position.x - radiusPx, y: item.position.y - radiusPx }).fillColor("#4488ff").fillOpacity(0.15).strokeColor("#4488ff").strokeOpacity(0.6).strokeWidth(2).layer("DRAWING").locked(true).build();
        await OBR.scene.items.addItems([overlay]);
        movementRangeIds.push(overlay.id);
      }
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

OBR.onReady(async () => {
  setupContextMenu();
  watchTokenMovement();
  connectWS();
  renderInitiativeUI();
});
