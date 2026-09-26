// LILA BLACK — Player Journey Visualization Tool
// Vanilla JS, canvas-based. No build step, no framework.

const EVENT = { POSITION: 0, BOT_POSITION: 1, KILL: 2, KILLED: 3, BOT_KILL: 4, BOT_KILLED: 5, STORM: 6, LOOT: 7 };
const ELIMINATION_CODES = [EVENT.KILL, EVENT.BOT_KILL];
const DEATH_CODES = [EVENT.KILLED, EVENT.BOT_KILLED];
const STORM_CODES = [EVENT.STORM];
const LOOT_CODES = [EVENT.LOOT];
const TRAFFIC_CODES = [EVENT.POSITION, EVENT.BOT_POSITION];

const MAP_DISPLAY_ORDER = ["AmbroseValley", "Lockdown", "GrandRift"];
const DATE_LABELS = { February_10: "Feb 10", February_11: "Feb 11", February_12: "Feb 12", February_13: "Feb 13", February_14: "Feb 14 (partial)" };

const state = {
  data: null,
  mode: "playback", // 'playback' | 'heatmap'
  map: null,
  dateIdx: "all", // 'all' or index
  matchId: null,
  layers: { humans: true, bots: true, elim: true, death: true, storm: true, loot: true, grid: true },
  heat: { category: "traffic", scope: "match" },
  playback: { playing: false, t: 0, speed: 20 },
  images: {},
};

const PLAYER_PALETTE_HUMAN = ["#ff8a4c", "#ffb020", "#ff5f7e"];
const PLAYER_PALETTE_BOT = ["#35c7e6", "#6ee7d8", "#7aa2ff", "#a0e6ff", "#4fd0a5"];

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtClock(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().substr(11, 5);
}

async function boot() {
  let data, imageSources;
  if (window.__EMBEDDED_DATASET__) {
    // Single-file published artifact: data + images are inlined as globals.
    data = window.__EMBEDDED_DATASET__;
    imageSources = window.__EMBEDDED_IMAGES__;
  } else {
    // Multi-file repo/static-host version: fetch normally.
    const res = await fetch("data/dataset.json");
    data = await res.json();
    imageSources = {};
    Object.keys(data.maps).forEach(mapId => { imageSources[mapId] = `assets/${mapId}.jpg`; });
  }
  state.data = data;

  // preload minimap images
  await Promise.all(Object.keys(data.maps).map(mapId => new Promise(resolve => {
    const img = new Image();
    img.onload = () => { state.images[mapId] = img; resolve(); };
    img.onerror = resolve;
    img.src = imageSources[mapId];
  })));

  state.map = MAP_DISPLAY_ORDER.find(m => data.maps[m]) || Object.keys(data.maps)[0];
  buildMapButtons();
  buildDateOptions();
  buildMatchOptions();
  pickDefaultMatch();
  bindGlobalControls();
  renderAll();
  requestAnimationFrame(tick);
}

function matchesForFilter(map, dateIdx) {
  return state.data.matches.filter(m => m.map === map && (dateIdx === "all" || m.date === dateIdx));
}

function currentMatch() {
  if (!state.matchId) return null;
  return state.data.matches.find(m => m.fullId === state.matchId) || null;
}

// ---------------- UI construction ----------------

function buildMapButtons() {
  const el = document.getElementById("mapButtons");
  el.innerHTML = "";
  const counts = {};
  state.data.matches.forEach(m => counts[m.map] = (counts[m.map] || 0) + 1);
  MAP_DISPLAY_ORDER.filter(m => state.data.maps[m]).forEach(mapId => {
    const btn = document.createElement("button");
    btn.className = "map-btn" + (mapId === state.map ? " active" : "");
    btn.innerHTML = `<span>${state.data.maps[mapId].name}</span><span class="n">${counts[mapId] || 0}</span>`;
    btn.onclick = () => {
      state.map = mapId;
      state.dateIdx = "all";
      buildMapButtons();
      buildDateOptions();
      buildMatchOptions();
      pickDefaultMatch();
      renderAll();
    };
    el.appendChild(btn);
  });
}

function buildDateOptions() {
  const sel = document.getElementById("dateSelect");
  const counts = {};
  state.data.matches.filter(m => m.map === state.map).forEach(m => counts[m.date] = (counts[m.date] || 0) + 1);
  let html = `<option value="all">All dates (${state.data.matches.filter(m => m.map === state.map).length})</option>`;
  state.data.dates.forEach((d, i) => {
    if (!counts[i]) return;
    html += `<option value="${i}">${DATE_LABELS[d] || d} (${counts[i]})</option>`;
  });
  sel.innerHTML = html;
  sel.value = state.dateIdx;
  sel.onchange = () => {
    state.dateIdx = sel.value === "all" ? "all" : parseInt(sel.value, 10);
    buildMatchOptions();
    pickDefaultMatch();
    renderAll();
  };
}

function buildMatchOptions() {
  const sel = document.getElementById("matchSelect");
  const list = matchesForFilter(state.map, state.dateIdx).slice().sort((a, b) => a.startTs - b.startTs);
  if (list.length === 0) {
    sel.innerHTML = `<option value="">No matches</option>`;
    sel.onchange = null;
    return;
  }
  sel.innerHTML = list.map(m => {
    const label = `${fmtClock(m.startTs)} · ${m.humans}H/${m.bots}B · ${fmtTime(m.dur)}`;
    return `<option value="${m.fullId}">${label}</option>`;
  }).join("");
  sel.onchange = () => {
    state.matchId = sel.value;
    resetPlayback();
    renderAll();
  };
}

function pickDefaultMatch() {
  const list = matchesForFilter(state.map, state.dateIdx).slice().sort((a, b) => a.startTs - b.startTs);
  state.matchId = list.length ? list[0].fullId : null;
  document.getElementById("matchSelect").value = state.matchId || "";
  resetPlayback();
}

function resetPlayback() {
  state.playback.playing = false;
  state.playback.t = 0;
  updateTransportUI();
}

function bindGlobalControls() {
  document.getElementById("modePlayback").onclick = () => setMode("playback");
  document.getElementById("modeHeatmap").onclick = () => setMode("heatmap");

  ["humans", "bots", "elim", "death", "storm", "loot", "grid"].forEach(key => {
    const cb = document.getElementById("layer_" + key);
    cb.checked = state.layers[key];
    cb.onchange = () => { state.layers[key] = cb.checked; renderAll(); };
  });

  document.querySelectorAll('input[name="heatCategory"]').forEach(r => {
    r.onchange = () => { state.heat.category = r.value; renderAll(); };
  });
  document.querySelectorAll('input[name="heatScope"]').forEach(r => {
    r.onchange = () => { state.heat.scope = r.value; renderAll(); };
  });

  const playBtn = document.getElementById("playBtn");
  playBtn.onclick = () => {
    const m = currentMatch();
    if (!m) return;
    if (state.playback.t >= m.dur) state.playback.t = 0;
    state.playback.playing = !state.playback.playing;
    updateTransportUI();
  };

  const scrubber = document.getElementById("scrubber");
  scrubber.oninput = () => {
    state.playback.t = parseFloat(scrubber.value);
    state.playback.playing = false;
    updateTransportUI();
    renderAll();
  };

  document.getElementById("speedSelect").onchange = (e) => {
    state.playback.speed = parseFloat(e.target.value);
  };

  window.addEventListener("resize", () => renderAll());
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("modePlayback").classList.toggle("active", mode === "playback");
  document.getElementById("modeHeatmap").classList.toggle("active", mode === "heatmap");
  document.getElementById("playbackPanel").style.display = mode === "playback" ? "" : "none";
  document.getElementById("heatmapPanel").style.display = mode === "heatmap" ? "" : "none";
  document.getElementById("transport").classList.toggle("hidden", mode !== "playback");
  document.getElementById("matchFieldWrap").style.display = "";
  renderAll();
}

function updateTransportUI() {
  const m = currentMatch();
  const dur = m ? m.dur : 0;
  document.getElementById("scrubber").max = dur;
  document.getElementById("scrubber").value = state.playback.t;
  document.getElementById("timeNow").textContent = fmtTime(state.playback.t);
  document.getElementById("timeTotal").textContent = fmtTime(dur);
  const playBtn = document.getElementById("playBtn");
  playBtn.innerHTML = state.playback.playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}

// ---------------- Playback ticking ----------------
let lastFrameTime = null;
function tick(ts) {
  if (lastFrameTime == null) lastFrameTime = ts;
  const dt = (ts - lastFrameTime) / 1000;
  lastFrameTime = ts;

  if (state.mode === "playback" && state.playback.playing) {
    const m = currentMatch();
    if (m) {
      state.playback.t += dt * state.playback.speed;
      if (state.playback.t >= m.dur) {
        state.playback.t = m.dur;
        state.playback.playing = false;
      }
      updateTransportUI();
      drawPlayback();
    }
  }
  requestAnimationFrame(tick);
}

// ---------------- Coordinate mapping ----------------
function worldToPixel(mapCfg, x, z, canvasSize) {
  const u = (x - mapCfg.originX) / mapCfg.scale;
  const v = (z - mapCfg.originZ) / mapCfg.scale;
  return [u * canvasSize, (1 - v) * canvasSize];
}

// ---------------- Canvas setup ----------------
function getCanvas() {
  const canvas = document.getElementById("mapCanvas");
  const frame = document.getElementById("mapFrame");
  const rect = frame.getBoundingClientRect();
  const size = Math.round(rect.width);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, size };
}

function drawBackground(ctx, size, mapId) {
  ctx.fillStyle = "#05070a";
  ctx.fillRect(0, 0, size, size);
  const img = state.images[mapId];
  if (img) ctx.drawImage(img, 0, 0, size, size);
  if (state.layers.grid) {
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    const step = size / 8;
    for (let i = 1; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke();
    }
  }
}

function playerColor(p, idx) {
  const palette = p.bot ? PLAYER_PALETTE_BOT : PLAYER_PALETTE_HUMAN;
  return palette[idx % palette.length];
}

function drawMarkerShape(ctx, x, y, isBot, color, r) {
  ctx.fillStyle = color;
  if (isBot) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r * 0.85);
    ctx.lineTo(x - r, y + r * 0.85);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawEventIcon(ctx, x, y, code) {
  ctx.save();
  ctx.translate(x, y);
  if (ELIMINATION_CODES.includes(code)) {
    ctx.strokeStyle = "#ff5a4e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, 0); ctx.lineTo(6, 0);
    ctx.moveTo(0, -6); ctx.lineTo(0, 6);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.stroke();
  } else if (DEATH_CODES.includes(code)) {
    ctx.fillStyle = "#b3324f";
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(7, 0); ctx.lineTo(0, 7); ctx.lineTo(-7, 0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#f3d0da"; ctx.lineWidth = 1; ctx.stroke();
  } else if (STORM_CODES.includes(code)) {
    ctx.fillStyle = "rgba(155,107,255,0.85)";
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI * 2) / 3);
      ctx.beginPath();
      ctx.moveTo(0, -3); ctx.lineTo(8, -2); ctx.lineTo(0, 8); ctx.lineTo(-8, -2);
      ctx.closePath(); ctx.fill();
    }
  } else if (LOOT_CODES.includes(code)) {
    ctx.fillStyle = "#f2c14e";
    ctx.beginPath();
    ctx.moveTo(0, -5); ctx.lineTo(5, 0); ctx.lineTo(0, 5); ctx.lineTo(-5, 0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function layerAllowsEvent(code) {
  if (ELIMINATION_CODES.includes(code)) return state.layers.elim;
  if (DEATH_CODES.includes(code)) return state.layers.death;
  if (STORM_CODES.includes(code)) return state.layers.storm;
  if (LOOT_CODES.includes(code)) return state.layers.loot;
  return true;
}

// ---------------- Playback rendering ----------------
function drawPlayback() {
  const m = currentMatch();
  const frameEl = document.getElementById("mapFrame");
  const emptyEl = document.getElementById("mapEmpty");
  const captionEl = document.getElementById("mapCaption");
  if (!m) {
    emptyEl.style.display = "flex";
    emptyEl.textContent = "No match selected for this filter.";
    document.getElementById("mapCanvas").style.display = "none";
    return;
  }
  emptyEl.style.display = "none";
  document.getElementById("mapCanvas").style.display = "block";
  captionEl.textContent = `${state.data.maps[m.map].name} · ${DATE_LABELS[state.data.dates[m.date]]} · ${fmtClock(m.startTs)}`;

  const { ctx, size } = getCanvas();
  drawBackground(ctx, size, m.map);
  const mapCfg = state.data.maps[m.map];
  const t = state.playback.t;

  m.players.forEach((p, idx) => {
    if (p.bot && !state.layers.bots) return;
    if (!p.bot && !state.layers.humans) return;
    const color = playerColor(p, idx);
    const pts = p.rows.map(r => {
      const [px, py] = worldToPixel(mapCfg, r[1], r[2], size);
      return { t: r[0], x: px, y: py, code: r[3] };
    });
    if (pts.length === 0) return;

    // faint full path
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // traveled-so-far bold path
    const traveled = pts.filter(pt => pt.t <= t);
    if (traveled.length > 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      traveled.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // event markers up to current time
    pts.forEach(pt => {
      if (pt.t > t) return;
      if (pt.code === EVENT.POSITION || pt.code === EVENT.BOT_POSITION) return;
      if (!layerAllowsEvent(pt.code)) return;
      drawEventIcon(ctx, pt.x, pt.y, pt.code);
    });

    // current position marker (last known position at/ before t)
    if (traveled.length > 0) {
      const last = traveled[traveled.length - 1];
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      drawMarkerShape(ctx, last.x, last.y, p.bot, color, p.bot ? 5 : 5.5);
      ctx.restore();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (p.bot) {
        ctx.moveTo(last.x, last.y - 5); ctx.lineTo(last.x + 5, last.y + 4.25); ctx.lineTo(last.x - 5, last.y + 4.25); ctx.closePath();
      } else {
        ctx.arc(last.x, last.y, 5.5, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  });
}

// ---------------- Heatmap rendering ----------------
function collectHeatPoints() {
  const cat = state.heat.category;
  const codes = { traffic: TRAFFIC_CODES, elim: ELIMINATION_CODES, death: DEATH_CODES, storm: STORM_CODES, loot: LOOT_CODES }[cat];
  let matches;
  if (state.heat.scope === "match") {
    const m = currentMatch();
    matches = m ? [m] : [];
  } else {
    matches = matchesForFilter(state.map, state.dateIdx);
  }
  const pts = [];
  matches.forEach(m => {
    const mapCfg = state.data.maps[m.map];
    m.players.forEach(p => {
      p.rows.forEach(r => {
        if (codes.includes(r[3])) {
          pts.push(worldToPixel(mapCfg, r[1], r[2], 1024));
        }
      });
    });
  });
  return { pts, matchCount: matches.length };
}

const HEAT_GRADIENT_STOPS = [
  [0.0, [0, 0, 0, 0]],
  [0.35, [53, 199, 230, 140]],
  [0.6, [242, 193, 78, 190]],
  [1.0, [255, 90, 78, 235]],
];
function heatColorFor(t) {
  for (let i = 0; i < HEAT_GRADIENT_STOPS.length - 1; i++) {
    const [t0, c0] = HEAT_GRADIENT_STOPS[i];
    const [t1, c1] = HEAT_GRADIENT_STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return c0.map((v, i2) => Math.round(v + (c1[i2] - v) * f));
    }
  }
  return HEAT_GRADIENT_STOPS[HEAT_GRADIENT_STOPS.length - 1][1];
}

function drawHeatmap() {
  const emptyEl = document.getElementById("mapEmpty");
  const captionEl = document.getElementById("mapCaption");
  if (!state.map) return;
  emptyEl.style.display = "none";
  document.getElementById("mapCanvas").style.display = "block";

  const { ctx, size } = getCanvas();
  drawBackground(ctx, size, state.map);

  const { pts, matchCount } = collectHeatPoints();
  const scopeLabel = state.heat.scope === "match" ? (currentMatch() ? "this match" : "no match") : `${matchCount} matches`;
  captionEl.textContent = `${state.data.maps[state.map].name} · heatmap (${scopeLabel}) · ${pts.length.toLocaleString()} pts`;

  if (pts.length === 0) return;

  // ---- Float accumulator grid (avoids 8-bit canvas alpha saturation) ----
  const GRID = 220;
  const grid = new Float32Array(GRID * GRID);
  const sigma = state.heat.category === "traffic" ? 2.1 : 3.4;
  const kernelRadius = Math.ceil(sigma * 3);
  // precompute gaussian kernel offsets
  const kernel = [];
  for (let dy = -kernelRadius; dy <= kernelRadius; dy++) {
    for (let dx = -kernelRadius; dx <= kernelRadius; dx++) {
      const d2 = dx * dx + dy * dy;
      const w = Math.exp(-d2 / (2 * sigma * sigma));
      if (w > 0.01) kernel.push([dx, dy, w]);
    }
  }
  pts.forEach(([x, y]) => {
    const gx = Math.round((x / 1024) * GRID);
    const gy = Math.round((y / 1024) * GRID);
    for (let k = 0; k < kernel.length; k++) {
      const [dx, dy, w] = kernel[k];
      const cx = gx + dx, cy = gy + dy;
      if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) continue;
      grid[cy * GRID + cx] += w;
    }
  });

  // normalize using a high percentile (robust to single hot outlier cells)
  const sorted = Float32Array.from(grid).sort();
  const pIdx = Math.floor(sorted.length * 0.985);
  const norm = Math.max(sorted[pIdx], 1e-6);

  const off = document.createElement("canvas");
  off.width = GRID; off.height = GRID;
  const octx = off.getContext("2d");
  const imgData = octx.createImageData(GRID, GRID);
  const d = imgData.data;
  for (let i = 0; i < grid.length; i++) {
    const v = Math.min(1, grid[i] / norm);
    if (v <= 0.015) { d[i * 4 + 3] = 0; continue; }
    const t = Math.pow(v, 0.42); // gamma: lift mid/low values for a visible gradient
    const [r, g, b] = heatColorFor(t);
    const alpha = Math.round(60 + t * 190);
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = alpha;
  }
  octx.putImageData(imgData, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 0.9;
  ctx.drawImage(off, 0, 0, size, size);
  ctx.globalAlpha = 1;
}

// ---------------- Right panel ----------------
function renderDetails() {
  const wrap = document.getElementById("detailsContent");
  if (state.mode === "heatmap") {
    const { pts, matchCount } = collectHeatPoints();
    wrap.innerHTML = `
      <div class="card">
        <div class="card-title">HEATMAP SCOPE</div>
        <div class="kv"><span>Map</span><b>${state.data.maps[state.map]?.name || "—"}</b></div>
        <div class="kv"><span>Date filter</span><b>${state.dateIdx === "all" ? "All" : DATE_LABELS[state.data.dates[state.dateIdx]]}</b></div>
        <div class="kv"><span>Matches included</span><b>${state.heat.scope === "match" ? 1 : matchCount}</b></div>
        <div class="kv"><span>Points plotted</span><b>${pts.length.toLocaleString()}</b></div>
      </div>
      <div class="card">
        <div class="card-title">INTENSITY</div>
        <div class="legend-grad"></div>
        <div class="legend-grad-labels"><span>Low</span><span>High</span></div>
      </div>
      <div class="hint">${infoIcon()}<span>Heatmaps aggregate every tracked player/bot sample matching the current category — use scope "All matches" to see zone patterns across the whole filtered set, not just one match.</span></div>
    `;
    return;
  }

  const m = currentMatch();
  if (!m) {
    wrap.innerHTML = `<div class="card"><div class="card-title">MATCH</div><div class="kv"><span>No match available for this filter.</span></div></div>`;
    return;
  }
  const c = m.counts;
  wrap.innerHTML = `
    <div class="card">
      <div class="card-title">MATCH ${m.id}</div>
      <div class="kv"><span>Map</span><b>${state.data.maps[m.map].name}</b></div>
      <div class="kv"><span>Date</span><b>${DATE_LABELS[state.data.dates[m.date]]}</b></div>
      <div class="kv"><span>Start (UTC)</span><b>${fmtClock(m.startTs)}</b></div>
      <div class="kv"><span>Duration</span><b>${fmtTime(m.dur)}</b></div>
      <div class="kv"><span>Tracked</span><b>${m.humans}H / ${m.bots}B</b></div>
      <div class="hint">${infoIcon()}<span>Counts reflect telemetry files exported for this match, not the full player roster — LILA BLACK matches typically include many more untracked bots/players.</span></div>
    </div>
    <div class="card">
      <div class="card-title">EVENTS THIS MATCH</div>
      <div class="count-row">${icoElim()}<span>Eliminations</span><span class="num">${c.kill + c.botkill}</span></div>
      <div class="count-row">${icoDeath()}<span>Deaths</span><span class="num">${c.killed + c.botkilled}</span></div>
      <div class="count-row">${icoStorm()}<span>Storm deaths</span><span class="num">${c.storm}</span></div>
      <div class="count-row">${icoLoot()}<span>Loot pickups</span><span class="num">${c.loot}</span></div>
    </div>
    <div class="card">
      <div class="card-title">TRACKED PLAYERS</div>
      ${m.players.map((p, idx) => `
        <div class="player-row">
          <span class="dot" style="background:${playerColor(p, idx)}"></span>
          <span class="id">${p.id}</span>
          <span class="role">${p.bot ? "bot" : "human"}</span>
          <span class="rows-n">${p.rows.length} pts</span>
        </div>
      `).join("")}
    </div>
  `;
}

function infoIcon() { return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>`; }
function icoElim() { return `<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#ff5a4e" stroke-width="1.6"/><path d="M8 3v10M3 8h10" stroke="#ff5a4e" stroke-width="1.6"/></svg>`; }
function icoDeath() { return `<svg class="icon" viewBox="0 0 16 16"><path d="M8 2l6 6-6 6-6-6z" fill="#b3324f"/></svg>`; }
function icoStorm() { return `<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#9b6bff" opacity="0.85"/></svg>`; }
function icoLoot() { return `<svg class="icon" viewBox="0 0 16 16"><path d="M8 3l5 5-5 5-5-5z" fill="#f2c14e"/></svg>`; }

// ---------------- Master render ----------------
function renderAll() {
  if (state.mode === "playback") {
    drawPlayback();
  } else {
    drawHeatmap();
  }
  renderDetails();
  updateTransportUI();
}

boot();
