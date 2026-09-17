const R = 6371008.8;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const la1 = rad(a.lat), la2 = rad(b.lat), dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function buildTimeline(route) {
  const w = route.waypoints, segs = []; let t = 0, dist = 0, pause = 0, move = 0;
  for (let i = 1; i < w.length; i++) {
    const from = w[i - 1], to = w[i], d = distM(from, to);
    const sp = Math.max(0.05, from.speedMps ?? route.speedMps), p = Math.max(0, from.pauseSec ?? 0), ms = d / sp;
    segs.push({ index: i - 1, from, to, distM: d, bearingDeg: bearing(from, to), speedMps: sp, pauseBeforeSec: p, startT: t, moveStartT: t + p, endT: t + p + ms });
    t += p + ms; dist += d; pause += p; move += ms;
  }
  const fp = w.length ? Math.max(0, w[w.length - 1].pauseSec ?? 0) : 0;
  pause += fp; t += fp;
  return { segments: segs, totalDistM: dist, totalTimeSec: t, totalPauseSec: pause, totalMoveSec: move, avgSpeedMps: move > 0 ? dist / move : 0 };
}
function positionAt(route, tl, t) {
  const w = route.waypoints; if (!w.length) return null;
  if (!tl.segments.length) return { ...w[0], segIndex: 0, paused: true, finished: true, speedMps: 0, distDoneM: 0 };
  let done = 0;
  for (const s of tl.segments) {
    if (t < s.moveStartT) return { lat: s.from.lat, lon: s.from.lon, segIndex: s.index, paused: true, finished: false, speedMps: 0, distDoneM: done };
    if (t < s.endT) { const f = (t - s.moveStartT) / (s.endT - s.moveStartT); return { lat: s.from.lat + (s.to.lat - s.from.lat) * f, lon: s.from.lon + (s.to.lon - s.from.lon) * f, segIndex: s.index, paused: false, finished: false, speedMps: s.speedMps, distDoneM: done + s.distM * f }; }
    done += s.distM;
  }
  const l = tl.segments[tl.segments.length - 1];
  return { lat: l.to.lat, lon: l.to.lon, segIndex: l.index, paused: t < tl.totalTimeSec, finished: t >= tl.totalTimeSec, speedMps: 0, distDoneM: tl.totalDistM };
}
const fmtT = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}ч ${m}м ${x}с` : m ? `${m}м ${x}с` : `${x}с`; };
const fmtD = m => m >= 1000 ? (m / 1000).toFixed(2) + " км" : Math.round(m) + " м";
const kmh = mps => (mps * 3.6).toFixed(1) + " км/ч";
const $ = id => document.getElementById(id);

const savedView = JSON.parse(localStorage.getItem("mapView") || "null");
const DEFAULT_CENTER = savedView ? savedView.center : [51.5074, -0.1278];
const map = L.map("map", { doubleClickZoom: false }).setView(DEFAULT_CENTER, savedView ? savedView.zoom : 13);
map.on("moveend", () => localStorage.setItem("mapView", JSON.stringify({ center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() })));
if (!savedView && navigator.geolocation) navigator.geolocation.getCurrentPosition(g => map.setView([g.coords.latitude, g.coords.longitude], 16), () => {});
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
const layer = L.layerGroup().addTo(map);
const line = L.polyline([], { color: "#3d8bfd", weight: 4, opacity: .85 }).addTo(map);
const doneLine = L.polyline([], { color: "#33c17a", weight: 5, opacity: .9 }).addTo(map);
const ghost = L.marker(DEFAULT_CENTER, { icon: L.divIcon({ className: "ghost-icon", iconSize: [12, 12] }), interactive: false, opacity: 0 }).addTo(map);
const phone = L.marker(DEFAULT_CENTER, { icon: L.divIcon({ className: "phone-icon", iconSize: [16, 16] }), interactive: false, opacity: 0, zIndexOffset: 1000 }).addTo(map);
const confirmM = L.marker(DEFAULT_CENTER, { icon: L.divIcon({ className: "confirm-icon", iconSize: [10, 10] }), interactive: false, opacity: 0, zIndexOffset: 900 }).addTo(map);

let route = blankRoute();
let savedJson = JSON.stringify(route);
let routes = [];
let tl = buildTimeline(route);
let markers = [];
let playerState = null;
let ws;

function blankRoute() {
  return { id: null, name: "Маршрут " + new Date().toLocaleString("ru", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }), speedMps: 1.4, noisePosM: 1.5, noiseSpeedPct: 15, accuracyMin: 3, accuracyMax: 8, waypoints: [] };
}

function readForm() {
  route.name = $("routeName").value;
  const v = Number($("speedKmh").value) / 3.6 || 1.4;
  if (Math.abs(v - route.speedMps) > 0.02) route.speedMps = v;
  route.noisePosM = Number($("noisePos").value) || 0;
  route.noiseSpeedPct = Number($("noiseSpeed").value) || 0;
  route.accuracyMin = Number($("accMin").value) || 3;
  route.accuracyMax = Math.max(route.accuracyMin, Number($("accMax").value) || 8);
}
function writeForm() {
  $("routeName").value = route.name;
  $("speedKmh").value = (route.speedMps * 3.6).toFixed(1);
  $("noisePos").value = route.noisePosM;
  $("noiseSpeed").value = route.noiseSpeedPct;
  $("accMin").value = route.accuracyMin;
  $("accMax").value = route.accuracyMax;
}

function render() {
  tl = buildTimeline(route);
  const pts = route.waypoints.map(w => [w.lat, w.lon]);
  line.setLatLngs(pts);
  layer.clearLayers();
  markers = route.waypoints.map((w, i) => {
    const cls = "wp-icon" + (i === 0 ? " first" : i === route.waypoints.length - 1 ? " last" : "") + (w.pauseSec ? " paused" : "");
    const m = L.marker([w.lat, w.lon], { draggable: true, icon: L.divIcon({ className: cls, iconSize: [14, 14] }) });
    m.bindTooltip(`#${i + 1}` + (w.pauseSec ? ` · пауза ${w.pauseSec}с` : "") + (w.speedMps ? ` · ${kmh(w.speedMps)}` : ""), { direction: "top" });
    m.on("drag", e => { const ll = e.target.getLatLng(); w.lat = ll.lat; w.lon = ll.lng; line.setLatLngs(route.waypoints.map(x => [x.lat, x.lon])); });
    m.on("dragend", () => render());
    m.on("contextmenu", () => { route.waypoints.splice(i, 1); render(); });
    m.addTo(layer);
    return m;
  });
  $("mDist").textContent = fmtD(tl.totalDistM);
  $("mTime").textContent = fmtT(tl.totalTimeSec);
  $("mMove").textContent = fmtT(tl.totalMoveSec);
  $("mPause").textContent = fmtT(tl.totalPauseSec);
  $("mSpeed").textContent = kmh(tl.avgSpeedMps);
  $("mPts").textContent = route.waypoints.length;
  renderTable();
  renderDirty();
  updatePreview(pvT);
}

function renderTable() {
  const tb = $("ptsTable").querySelector("tbody");
  tb.innerHTML = "";
  route.waypoints.forEach((w, i) => {
    const s = tl.segments[i];
    const tr = document.createElement("tr");
    tr.dataset.i = i;
    tr.innerHTML = `<td>${i + 1}</td><td>${s ? `${fmtD(s.distM)} · ${Math.round(s.bearingDeg)}° · ${fmtT(s.endT - s.moveStartT)}` : "финиш"}</td>
      <td><input type="number" min="0" value="${w.pauseSec || ""}" placeholder="0" data-k="pauseSec"></td>
      <td><input type="number" min="0.3" step="0.1" value="${w.speedMps ? (w.speedMps * 3.6).toFixed(1) : ""}" placeholder="${(route.speedMps * 3.6).toFixed(1)}" data-k="speedKmh"></td>
      <td><button class="small" data-act="zoom">⌖</button><button class="small danger" data-act="del">✕</button></td>`;
    tr.querySelectorAll("input").forEach(inp => inp.addEventListener("change", () => {
      if (inp.dataset.k === "pauseSec") w.pauseSec = Number(inp.value) || 0;
      else w.speedMps = inp.value === "" ? null : Number(inp.value) / 3.6;
      render();
    }));
    tr.querySelector('[data-act="zoom"]').onclick = () => map.panTo([w.lat, w.lon]);
    tr.querySelector('[data-act="del"]').onclick = () => { route.waypoints.splice(i, 1); render(); };
    tb.appendChild(tr);
  });
}

function renderDirty() {
  const cur = JSON.stringify({ ...route, updatedAt: 0 });
  const dirty = cur !== savedJson;
  $("dirty").textContent = dirty ? "есть несохранённые изменения, для проигрывания на телефоне нужно сохранить" : "";
  $("play").disabled = dirty || !route.id || route.waypoints.length < 2;
}
function markSaved() { savedJson = JSON.stringify({ ...route, updatedAt: 0 }); }

map.on("click", e => {
  if (playerState && playerState.status === "playing" && playerState.routeId === route.id) return;
  route.waypoints.push({ lat: e.latlng.lat, lon: e.latlng.lng, pauseSec: 0, speedMps: null });
  render();
});
line.on("click", e => {
  L.DomEvent.stop(e);
  const p = e.latlng; let best = 0, bd = Infinity;
  for (let i = 1; i < route.waypoints.length; i++) {
    const a = route.waypoints[i - 1], b = route.waypoints[i];
    const q = { lat: p.lat, lon: p.lng };
    const d = distM(a, q) + distM(b, q) - distM(a, b);
    if (d < bd) { bd = d; best = i; }
  }
  route.waypoints.splice(best, 0, { lat: p.lat, lon: p.lng, pauseSec: 0, speedMps: null });
  render();
});

["routeName", "speedKmh", "noisePos", "noiseSpeed", "accMin", "accMax"].forEach(id => $(id).addEventListener("input", () => { readForm(); render(); }));
$("clearPts").onclick = () => { if (confirm("Удалить все точки?")) { route.waypoints = []; render(); } };

async function loadRoutes(selectId) {
  routes = await (await fetch("/api/routes")).json();
  const sel = $("routeSelect");
  sel.innerHTML = '<option value="">— новый —</option>' + routes.map(r => `<option value="${r.id}">${r.name} (${r.waypoints.length} т.)</option>`).join("");
  sel.value = selectId ?? route.id ?? "";
}
$("routeSelect").onchange = () => {
  const r = routes.find(x => x.id === $("routeSelect").value);
  route = r ? structuredClone(r) : blankRoute();
  markSaved(); writeForm(); render();
  if (route.waypoints.length) map.fitBounds(line.getBounds(), { padding: [40, 40] });
};
$("newRoute").onclick = () => { route = blankRoute(); markSaved(); writeForm(); render(); $("routeSelect").value = ""; };
$("saveRoute").onclick = async () => {
  readForm();
  const res = await fetch(route.id ? `/api/routes/${route.id}` : "/api/routes", { method: route.id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(route) });
  route = await res.json();
  markSaved(); writeForm(); render(); await loadRoutes(route.id);
};
$("deleteRoute").onclick = async () => {
  if (!route.id || !confirm(`Удалить "${route.name}"?`)) return;
  await fetch(`/api/routes/${route.id}`, { method: "DELETE" });
  route = blankRoute(); markSaved(); writeForm(); render(); await loadRoutes("");
};

let pvT = 0, pvTimer = null, pvLast = 0;
function updatePreview(t) {
  pvT = Math.max(0, Math.min(t, tl.totalTimeSec || 0));
  const p = positionAt(route, tl, pvT);
  if (!p) { ghost.setOpacity(0); $("pvInfo").textContent = "—"; $("pvSlider").value = 0; return; }
  ghost.setLatLng([p.lat, p.lon]).setOpacity(1);
  $("pvSlider").value = tl.totalTimeSec ? Math.round(pvT / tl.totalTimeSec * 1000) : 0;
  $("pvInfo").textContent = `${fmtT(pvT)} / ${fmtT(tl.totalTimeSec)} · ${fmtD(p.distDoneM)} · ${p.paused ? "пауза" : kmh(p.speedMps)} · сегмент ${p.segIndex + 1}`;
  highlightRow(p.segIndex);
}
function highlightRow(i) { $("ptsTable").querySelectorAll("tr").forEach(tr => tr.classList.toggle("active", tr.dataset.i == i)); }
$("pvSlider").oninput = () => updatePreview(Number($("pvSlider").value) / 1000 * tl.totalTimeSec);
$("pvPlay").onclick = () => {
  if (pvTimer) { cancelAnimationFrame(pvTimer); pvTimer = null; $("pvPlay").textContent = "▶"; return; }
  if (pvT >= tl.totalTimeSec) pvT = 0;
  pvLast = performance.now(); $("pvPlay").textContent = "⏸";
  const step = now => { const rate = Number($("pvRate").value); pvT += (now - pvLast) / 1000 * rate; pvLast = now; updatePreview(pvT); if (pvT < tl.totalTimeSec) pvTimer = requestAnimationFrame(step); else { pvTimer = null; $("pvPlay").textContent = "▶"; } };
  pvTimer = requestAnimationFrame(step);
};
$("pvStop").onclick = () => { if (pvTimer) cancelAnimationFrame(pvTimer); pvTimer = null; $("pvPlay").textContent = "▶"; updatePreview(0); };

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
$("play").onclick = () => { readForm(); send({ type: "play", routeId: route.id, fromT: 0 }); };
$("pause").onclick = () => send({ type: "pause" });
$("resume").onclick = () => send({ type: "resume" });
$("stop").onclick = () => send({ type: "stop" });
$("setup").onclick = () => send({ type: "setup" });
$("cleanup").onclick = () => { if (confirm("Снять mock-провайдеры и вернуть реальный GPS?")) send({ type: "cleanup" }); };
$("holdStart").onclick = () => { const w = route.waypoints[0]; if (w) send({ type: "hold", lat: w.lat, lon: w.lon }); };
$("autoResume").onchange = () => send({ type: "setAutoResume", value: $("autoResume").checked });
$("playSlider").onchange = () => { if (playerState && playerState.totalTimeSec) send({ type: "seek", t: Number($("playSlider").value) / 1000 * playerState.totalTimeSec }); };

function renderPlayer(s) {
  playerState = s;
  const pill = $("playStatus");
  pill.textContent = s.status + (s.routeName ? ` · ${s.routeName}` : "");
  pill.className = "pill " + ({ playing: "ok", holding: "ok", paused: "warn", error: "bad" }[s.status] || "");
  $("pause").disabled = s.status !== "playing";
  $("resume").disabled = !(s.status === "paused" || s.status === "error");
  $("stop").disabled = s.status === "idle";
  if (s.pos && s.status !== "idle") {
    phone.setLatLng([s.pos.lat, s.pos.lon]).setOpacity(1);
    $("playSlider").value = s.totalTimeSec ? Math.round(s.t / s.totalTimeSec * 1000) : 0;
    $("playInfo").textContent = `${fmtT(s.t)} / ${fmtT(s.totalTimeSec)} · ${fmtD(s.pos.distDoneM)} из ${fmtD(s.totalDistM)} · ${s.pos.paused ? "пауза" : kmh(s.pos.speedMps * s.speedFactor)} · тиков ${s.ticks}, ошибок ${s.failures}`;
    if (s.routeId === route.id) {
      const doneSegs = tl.segments.slice(0, s.pos.segIndex + 1).map(x => [x.from.lat, x.from.lon]);
      doneLine.setLatLngs([...doneSegs, [s.pos.lat, s.pos.lon]]);
      highlightRow(s.pos.segIndex);
    }
  } else {
    phone.setOpacity(0); doneLine.setLatLngs([]);
    $("playInfo").textContent = s.message || "—";
  }
  if (s.confirmed) {
    confirmM.setLatLng([s.confirmed.lat, s.confirmed.lon]).setOpacity(1);
    const age = Math.round((Date.now() - s.confirmed.at) / 1000);
    const bad = s.confirmed.lagM > 15;
    $("confirmInfo").textContent = `телефон подтвердил: ${s.confirmed.lat.toFixed(6)}, ${s.confirmed.lon.toFixed(6)} · расхождение ${s.confirmed.lagM.toFixed(1)} м · ${age}с назад` + (bad ? " ⚠ телефон не принимает точки" : "");
    $("confirmInfo").style.color = bad ? "var(--bad)" : "";
  } else { confirmM.setOpacity(0); $("confirmInfo").textContent = s.message ? "⚠ " + s.message : "—"; }
  renderDirty();
}

function renderDevice(d) {
  const el = $("device");
  el.textContent = d.problem ? `⚠ ${d.problem}` : `телефон: ${d.serial ?? "device"}${d.mockReady ? " · mock on" : " · mock off"}`;
  el.className = "pill " + (d.state === "device" ? (d.mockReady ? "ok" : "warn") : "bad");
  el.title = d.lastError || "";
  const ok = d.state === "device";
  $("setup").disabled = !ok; $("holdStart").disabled = !ok;
  if (ok) renderDirty(); else { $("play").disabled = true; $("resume").disabled = true; }
}
function addLog(e) {
  const pre = $("log");
  pre.textContent += `${new Date(e.at).toLocaleTimeString("ru")} ${e.msg}\n`;
  pre.scrollTop = pre.scrollHeight;
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === "hello") {
      $("log").textContent = ""; m.log.forEach(addLog); renderDevice(m.device); renderPlayer(m.state);
      if (m.session && m.session.routeId && m.state.status === "idle" && m.session.t > 0 && m.session.status !== "idle") {
        $("sessionHint").innerHTML = `Прошлая сессия: маршрут ${m.session.routeId}, t=${fmtT(m.session.t)} (${m.session.status}). <button id="resumeSession" class="small">продолжить оттуда</button>`;
        $("resumeSession").onclick = () => send({ type: "play", routeId: m.session.routeId, fromT: m.session.t });
      } else $("sessionHint").textContent = "";
    }
    if (m.type === "player") renderPlayer(m.state);
    if (m.type === "device") renderDevice(m.device);
    if (m.type === "log") addLog(m.entry);
    if (m.type === "error") addLog({ at: Date.now(), msg: "ERROR " + m.message });
  };
  ws.onclose = () => { $("device").textContent = "сервер недоступен"; $("device").className = "pill bad"; setTimeout(connect, 1500); };
}

(async () => {
  writeForm(); render();
  await loadRoutes("");
  if (routes.length) { $("routeSelect").value = routes[0].id; $("routeSelect").onchange(); }
  connect();
})();
