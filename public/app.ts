import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { Notyf } from "notyf";
import "notyf/notyf.min.css";
import { createIcons, createElement, type IconNode, Footprints, Route as RouteIcon, ChevronsUpDown, Plus, Trash2, Save, CircleAlert, Ruler, Clock, Activity, Coffee, Gauge, MapPin, SlidersHorizontal, ChevronDown, Eye, Play, SkipBack, Smartphone, Pause, StepForward, Square, PlugZap, Flag, Satellite, ListOrdered, Eraser, MousePointerClick, Terminal, Info, TriangleAlert, Crosshair, X, RotateCcw } from "lucide";
import { buildTimeline, distanceM, positionAt, type Route, type Timeline, type Waypoint } from "../src/geo";
import type { PlayerState } from "../src/player";

type Draft = Omit<Route, "id" | "createdAt" | "updatedAt"> & { id: string | null; createdAt?: string; updatedAt?: string };
type Device = { state: string; serial: string | null; mockReady: boolean; lastError: string | null; problem: string | null };
type LogEntry = { at: number; msg: string };
type Session = { routeId: string; t: number; status: string; savedAt: number };
type ServerMsg =
  | { type: "hello"; state: PlayerState; device: Device; log: LogEntry[]; session: Session | null }
  | { type: "player"; state: PlayerState }
  | { type: "device"; device: Device }
  | { type: "log"; entry: LogEntry }
  | { type: "error"; message: string };
type ClientMsg =
  | { type: "play"; routeId: string; fromT: number }
  | { type: "pause" | "resume" | "stop" | "setup" | "cleanup" }
  | { type: "seek"; t: number }
  | { type: "hold"; lat: number; lon: number }
  | { type: "setAutoResume"; value: boolean };

const ICONS = { Footprints, Route: RouteIcon, ChevronsUpDown, Plus, Trash2, Save, CircleAlert, Ruler, Clock, Activity, Coffee, Gauge, MapPin, SlidersHorizontal, ChevronDown, Eye, Play, SkipBack, Smartphone, Pause, StepForward, Square, PlugZap, Flag, Satellite, ListOrdered, Eraser, MousePointerClick, Terminal, Info, TriangleAlert, Crosshair, X, RotateCcw };
const ico = (icon: IconNode) => createElement(icon).outerHTML;
const notyf = new Notyf({ duration: 3500, position: { x: "right", y: "bottom" }, dismissible: true, types: [{ type: "success", background: "#16a34a" }, { type: "error", background: "#dc2626" }] });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  routeSelect: $<HTMLSelectElement>("routeSelect"),
  routeName: $<HTMLInputElement>("routeName"),
  speedKmh: $<HTMLInputElement>("speedKmh"),
  noisePos: $<HTMLInputElement>("noisePos"),
  noiseSpeed: $<HTMLInputElement>("noiseSpeed"),
  accMin: $<HTMLInputElement>("accMin"),
  accMax: $<HTMLInputElement>("accMax"),
  newRoute: $<HTMLButtonElement>("newRoute"),
  saveRoute: $<HTMLButtonElement>("saveRoute"),
  deleteRoute: $<HTMLButtonElement>("deleteRoute"),
  dirty: $("dirty"),
  mDist: $("mDist"), mTime: $("mTime"), mMove: $("mMove"), mPause: $("mPause"), mSpeed: $("mSpeed"), mPts: $("mPts"),
  pvRateSeg: $("pvRateSeg"),
  pvPlay: $<HTMLButtonElement>("pvPlay"),
  pvStop: $<HTMLButtonElement>("pvStop"),
  pvSlider: $<HTMLInputElement>("pvSlider"),
  pvInfo: $("pvInfo"),
  playStatus: $("playStatus"),
  play: $<HTMLButtonElement>("play"),
  pause: $<HTMLButtonElement>("pause"),
  resume: $<HTMLButtonElement>("resume"),
  stop: $<HTMLButtonElement>("stop"),
  playSlider: $<HTMLInputElement>("playSlider"),
  playInfo: $("playInfo"),
  confirmInfo: $("confirmInfo"),
  setup: $<HTMLButtonElement>("setup"),
  cleanup: $<HTMLButtonElement>("cleanup"),
  holdStart: $<HTMLButtonElement>("holdStart"),
  autoResume: $<HTMLInputElement>("autoResume"),
  sessionHint: $("sessionHint"),
  clearPts: $<HTMLButtonElement>("clearPts"),
  ptsTable: $<HTMLTableElement>("ptsTable"),
  ptsEmpty: $("ptsEmpty"),
  log: $("log"),
  device: $("device"),
  confirmDlg: $<HTMLDialogElement>("confirmDlg"),
  confirmText: $("confirmText"),
};

function ask(text: string): Promise<boolean> {
  const dlg = ui.confirmDlg;
  ui.confirmText.textContent = text;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise(res => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
}
function setRange(el: HTMLInputElement, v: number) { el.value = String(v); el.style.setProperty("--p", v / 10 + "%"); }
function setPill(el: HTMLElement, text: string, cls?: string) { el.querySelector(".txt")!.textContent = text; el.className = "pill " + (cls ?? ""); }

const fmtT = (sec: number) => { const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}ч ${m}м ${x}с` : m ? `${m}м ${x}с` : `${x}с`; };
const fmtD = (m: number) => m >= 1000 ? (m / 1000).toFixed(2) + " км" : Math.round(m) + " м";
const kmh = (mps: number) => (mps * 3.6).toFixed(1) + " км/ч";
const latLngs = (w: Waypoint[]): L.LatLngTuple[] => w.map(x => [x.lat, x.lon]);

const savedView: { center: L.LatLngTuple; zoom: number } | null = JSON.parse(localStorage.getItem("mapView") || "null");
const DEFAULT_CENTER: L.LatLngTuple = savedView ? savedView.center : [51.5074, -0.1278];
const map = L.map("map", { doubleClickZoom: false }).setView(DEFAULT_CENTER, savedView ? savedView.zoom : 13);
map.on("moveend", () => localStorage.setItem("mapView", JSON.stringify({ center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() })));
if (!savedView && navigator.geolocation) navigator.geolocation.getCurrentPosition(g => map.setView([g.coords.latitude, g.coords.longitude], 16), () => {});

const osm = (className = "") => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, className, attribution: "© OpenStreetMap" });
const bases: Record<string, L.TileLayer> = {
  "Тёмная": osm("dark-tiles"),
  "Светлая": osm(),
  "Спутник": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "© Esri" }),
};
(bases[localStorage.getItem("mapBase") ?? ""] ?? bases["Тёмная"]).addTo(map);
L.control.layers(bases, undefined, { position: "topright" }).addTo(map);
map.on("baselayerchange", e => localStorage.setItem("mapBase", e.name));

const layer = L.layerGroup().addTo(map);
const lineHalo = L.polyline([], { color: "#a5b4fc", weight: 8, opacity: .18, interactive: false }).addTo(map);
const line = L.polyline([], { color: "#6366f1", weight: 4, opacity: .95 }).addTo(map);
const doneLine = L.polyline([], { color: "#22c55e", weight: 5, opacity: .95 }).addTo(map);
const dot = (className: string, size: number, zIndexOffset = 0) => L.marker(DEFAULT_CENTER, { icon: L.divIcon({ className, iconSize: [size, size] }), interactive: false, opacity: 0, zIndexOffset }).addTo(map);
const ghost = dot("ghost-icon", 16);
const phone = dot("phone-icon", 18, 1000);
const confirmM = dot("confirm-icon", 14, 900);

function blankRoute(): Draft {
  return { id: null, name: "Маршрут " + new Date().toLocaleString("ru", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }), speedMps: 1.4, noisePosM: 1.5, noiseSpeedPct: 15, accuracyMin: 3, accuracyMax: 8, waypoints: [] };
}

let route: Draft = blankRoute();
let savedJson = JSON.stringify(route);
let routes: Route[] = [];
let tl: Timeline = buildTimeline(route);
let playerState: PlayerState | null = null;
let ws: WebSocket | undefined;
let pvT = 0, pvTimer: number | null = null, pvLast = 0, pvRate = 20;

function readForm() {
  route.name = ui.routeName.value;
  const v = Number(ui.speedKmh.value) / 3.6 || 1.4;
  if (Math.abs(v - route.speedMps) > 0.02) route.speedMps = v;
  route.noisePosM = Number(ui.noisePos.value) || 0;
  route.noiseSpeedPct = Number(ui.noiseSpeed.value) || 0;
  route.accuracyMin = Number(ui.accMin.value) || 3;
  route.accuracyMax = Math.max(route.accuracyMin, Number(ui.accMax.value) || 8);
}
function writeForm() {
  ui.routeName.value = route.name;
  ui.speedKmh.value = (route.speedMps * 3.6).toFixed(1);
  ui.noisePos.value = String(route.noisePosM);
  ui.noiseSpeed.value = String(route.noiseSpeedPct);
  ui.accMin.value = String(route.accuracyMin);
  ui.accMax.value = String(route.accuracyMax);
}

function setLine(pts: L.LatLngTuple[]) { line.setLatLngs(pts); lineHalo.setLatLngs(pts); }

function render() {
  tl = buildTimeline(route);
  setLine(latLngs(route.waypoints));
  layer.clearLayers();
  const n = route.waypoints.length;
  route.waypoints.forEach((w, i) => {
    const edge = i === 0 || i === n - 1;
    const cls = "wp-icon" + (i === 0 ? " first" : i === n - 1 ? " last" : "") + (w.pauseSec ? " paused" : "");
    const m = L.marker([w.lat, w.lon], { draggable: true, icon: L.divIcon({ className: cls, iconSize: edge ? [16, 16] : [13, 13] }) });
    m.bindTooltip(`#${i + 1}` + (w.pauseSec ? ` · пауза ${w.pauseSec}с` : "") + (w.speedMps ? ` · ${kmh(w.speedMps)}` : ""), { direction: "top" });
    m.on("drag", () => { const ll = m.getLatLng(); w.lat = ll.lat; w.lon = ll.lng; setLine(latLngs(route.waypoints)); });
    m.on("dragend", render);
    m.on("contextmenu", () => { route.waypoints.splice(i, 1); render(); });
    m.addTo(layer);
  });
  ui.mDist.textContent = fmtD(tl.totalDistM);
  ui.mTime.textContent = fmtT(tl.totalTimeSec);
  ui.mMove.textContent = fmtT(tl.totalMoveSec);
  ui.mPause.textContent = fmtT(tl.totalPauseSec);
  ui.mSpeed.textContent = kmh(tl.avgSpeedMps);
  ui.mPts.textContent = String(n);
  renderTable();
  renderDirty();
  updatePreview(pvT);
}

function renderTable() {
  const tb = ui.ptsTable.tBodies[0];
  tb.innerHTML = "";
  ui.ptsEmpty.hidden = route.waypoints.length > 0;
  ui.ptsTable.hidden = route.waypoints.length === 0;
  route.waypoints.forEach((w, i) => {
    const s = tl.segments[i];
    const tr = document.createElement("tr");
    tr.dataset.i = String(i);
    tr.innerHTML = `<td>${i + 1}</td><td class="seg-cell">${s ? `${fmtD(s.distM)} · ${Math.round(s.bearingDeg)}° · ${fmtT(s.endT - s.moveStartT)}` : "финиш"}</td>
      <td><input type="number" min="0" value="${w.pauseSec || ""}" placeholder="0" data-k="pauseSec"></td>
      <td><input type="number" min="0.3" step="0.1" value="${w.speedMps ? (w.speedMps * 3.6).toFixed(1) : ""}" placeholder="${(route.speedMps * 3.6).toFixed(1)}" data-k="speedKmh"></td>
      <td class="act"><button title="Показать на карте" data-act="zoom">${ico(Crosshair)}</button><button class="danger" title="Удалить" data-act="del">${ico(X)}</button></td>`;
    tr.querySelectorAll("input").forEach(inp => inp.addEventListener("change", () => {
      if (inp.dataset.k === "pauseSec") w.pauseSec = Number(inp.value) || 0;
      else w.speedMps = inp.value === "" ? null : Number(inp.value) / 3.6;
      render();
    }));
    tr.querySelector<HTMLButtonElement>('[data-act="zoom"]')!.onclick = () => map.panTo([w.lat, w.lon]);
    tr.querySelector<HTMLButtonElement>('[data-act="del"]')!.onclick = () => { route.waypoints.splice(i, 1); render(); };
    tb.appendChild(tr);
  });
}

const snapshot = () => JSON.stringify({ ...route, updatedAt: 0 });
function renderDirty() {
  const dirty = snapshot() !== savedJson;
  ui.dirty.hidden = !dirty;
  ui.play.disabled = dirty || !route.id || route.waypoints.length < 2;
}
function markSaved() { savedJson = snapshot(); }

map.on("click", e => {
  if (playerState?.status === "playing" && playerState.routeId === route.id) return;
  route.waypoints.push({ lat: e.latlng.lat, lon: e.latlng.lng, pauseSec: 0, speedMps: null });
  render();
});
line.on("click", e => {
  L.DomEvent.stop(e);
  const q = { lat: e.latlng.lat, lon: e.latlng.lng };
  let best = 0, bd = Infinity;
  for (let i = 1; i < route.waypoints.length; i++) {
    const a = route.waypoints[i - 1], b = route.waypoints[i];
    const d = distanceM(a, q) + distanceM(b, q) - distanceM(a, b);
    if (d < bd) { bd = d; best = i; }
  }
  route.waypoints.splice(best, 0, { ...q, pauseSec: 0, speedMps: null });
  render();
});

[ui.routeName, ui.speedKmh, ui.noisePos, ui.noiseSpeed, ui.accMin, ui.accMax].forEach(el => el.addEventListener("input", () => { readForm(); render(); }));
ui.clearPts.onclick = async () => { if (route.waypoints.length && await ask("Удалить все точки маршрута?")) { route.waypoints = []; render(); } };

async function loadRoutes(selectId?: string) {
  routes = await (await fetch("/api/routes")).json();
  const sel = ui.routeSelect;
  sel.innerHTML = '<option value="">— новый —</option>';
  for (const r of routes) sel.add(new Option(`${r.name} (${r.waypoints.length} т.)`, r.id));
  sel.value = selectId ?? route.id ?? "";
}
function selectRoute() {
  const r = routes.find(x => x.id === ui.routeSelect.value);
  route = r ? structuredClone(r) : blankRoute();
  markSaved(); writeForm(); render();
  if (route.waypoints.length) map.fitBounds(line.getBounds(), { padding: [40, 40] });
}
ui.routeSelect.onchange = selectRoute;
ui.newRoute.onclick = () => { route = blankRoute(); markSaved(); writeForm(); render(); ui.routeSelect.value = ""; };
ui.saveRoute.onclick = async () => {
  readForm();
  const res = await fetch(route.id ? `/api/routes/${route.id}` : "/api/routes", { method: route.id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(route) });
  if (!res.ok) { notyf.error("Не удалось сохранить маршрут"); return; }
  route = await res.json();
  markSaved(); writeForm(); render(); await loadRoutes(route.id!);
  notyf.success(`Сохранено: ${route.name}`);
};
ui.deleteRoute.onclick = async () => {
  if (!route.id || !await ask(`Удалить маршрут «${route.name}»?`)) return;
  await fetch(`/api/routes/${route.id}`, { method: "DELETE" });
  notyf.success("Маршрут удалён");
  route = blankRoute(); markSaved(); writeForm(); render(); await loadRoutes("");
};

function updatePreview(t: number) {
  pvT = Math.max(0, Math.min(t, tl.totalTimeSec || 0));
  const p = positionAt(route, tl, pvT);
  if (!p) { ghost.setOpacity(0); ui.pvInfo.textContent = "—"; setRange(ui.pvSlider, 0); return; }
  ghost.setLatLng([p.lat, p.lon]).setOpacity(1);
  setRange(ui.pvSlider, tl.totalTimeSec ? Math.round(pvT / tl.totalTimeSec * 1000) : 0);
  ui.pvInfo.textContent = `${fmtT(pvT)} / ${fmtT(tl.totalTimeSec)} · ${fmtD(p.distDoneM)} · ${p.paused ? "пауза" : kmh(p.speedMps)} · сегмент ${p.segIndex + 1}`;
  highlightRow(p.segIndex);
}
function highlightRow(i: number) { ui.ptsTable.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach(tr => tr.classList.toggle("active", tr.dataset.i === String(i))); }

const pvIcon = (playing: boolean) => { ui.pvPlay.innerHTML = ico(playing ? Pause : Play); };
function pvHalt() { if (pvTimer) cancelAnimationFrame(pvTimer); pvTimer = null; pvIcon(false); }
ui.pvRateSeg.querySelectorAll<HTMLButtonElement>("button").forEach((b, _, all) => b.onclick = () => {
  pvRate = Number(b.dataset.rate);
  all.forEach(x => x.classList.toggle("on", x === b));
});
ui.pvSlider.oninput = () => updatePreview(Number(ui.pvSlider.value) / 1000 * tl.totalTimeSec);
ui.pvPlay.onclick = () => {
  if (pvTimer) return pvHalt();
  if (pvT >= tl.totalTimeSec) pvT = 0;
  pvLast = performance.now(); pvIcon(true);
  const step = (now: number) => {
    pvT += (now - pvLast) / 1000 * pvRate; pvLast = now; updatePreview(pvT);
    if (pvT < tl.totalTimeSec) pvTimer = requestAnimationFrame(step); else pvHalt();
  };
  pvTimer = requestAnimationFrame(step);
};
ui.pvStop.onclick = () => { pvHalt(); updatePreview(0); };

function send(msg: ClientMsg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
ui.play.onclick = () => { readForm(); if (route.id) send({ type: "play", routeId: route.id, fromT: 0 }); };
ui.pause.onclick = () => send({ type: "pause" });
ui.resume.onclick = () => send({ type: "resume" });
ui.stop.onclick = () => send({ type: "stop" });
ui.setup.onclick = () => send({ type: "setup" });
ui.cleanup.onclick = async () => { if (await ask("Снять mock-провайдеры и вернуть телефону реальный GPS?")) send({ type: "cleanup" }); };
ui.holdStart.onclick = () => { const w = route.waypoints[0]; if (w) send({ type: "hold", lat: w.lat, lon: w.lon }); };
ui.autoResume.onchange = () => send({ type: "setAutoResume", value: ui.autoResume.checked });
ui.playSlider.oninput = () => setRange(ui.playSlider, Number(ui.playSlider.value));
ui.playSlider.onchange = () => { if (playerState?.totalTimeSec) send({ type: "seek", t: Number(ui.playSlider.value) / 1000 * playerState.totalTimeSec }); };

const STATUS_CLS: Partial<Record<PlayerState["status"], string>> = { playing: "ok", holding: "ok", paused: "warn", error: "bad" };
function renderPlayer(s: PlayerState) {
  playerState = s;
  setPill(ui.playStatus, s.status + (s.routeName ? ` · ${s.routeName}` : ""), STATUS_CLS[s.status]);
  ui.pause.disabled = s.status !== "playing";
  ui.resume.disabled = !(s.status === "paused" || s.status === "error");
  ui.stop.disabled = s.status === "idle";
  if (s.pos && s.status !== "idle") {
    phone.setLatLng([s.pos.lat, s.pos.lon]).setOpacity(1);
    setRange(ui.playSlider, s.totalTimeSec ? Math.round(s.t / s.totalTimeSec * 1000) : 0);
    ui.playInfo.textContent = `${fmtT(s.t)} / ${fmtT(s.totalTimeSec)} · ${fmtD(s.pos.distDoneM)} из ${fmtD(s.totalDistM)} · ${s.pos.paused ? "пауза" : kmh(s.pos.speedMps * s.speedFactor)} · тиков ${s.ticks}, ошибок ${s.failures}`;
    if (s.routeId === route.id) {
      const done: L.LatLngTuple[] = tl.segments.slice(0, s.pos.segIndex + 1).map(x => [x.from.lat, x.from.lon]);
      doneLine.setLatLngs([...done, [s.pos.lat, s.pos.lon]]);
      highlightRow(s.pos.segIndex);
    }
  } else {
    phone.setOpacity(0); doneLine.setLatLngs([]);
    ui.playInfo.textContent = s.message || "—";
  }
  const c = s.confirmed;
  if (c) {
    confirmM.setLatLng([c.lat, c.lon]).setOpacity(1);
    const age = Math.round((Date.now() - c.at) / 1000);
    const bad = c.lagM > 15;
    ui.confirmInfo.textContent = `телефон подтвердил: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)} · расхождение ${c.lagM.toFixed(1)} м · ${age}с назад` + (bad ? " ⚠ телефон не принимает точки" : "");
    ui.confirmInfo.classList.toggle("bad", bad);
  } else { confirmM.setOpacity(0); ui.confirmInfo.textContent = s.message ? "⚠ " + s.message : "—"; }
  renderDirty();
}

function renderDevice(d: Device) {
  const ok = d.state === "device";
  setPill(ui.device, d.problem ?? `${d.serial ?? "device"}${d.mockReady ? " · mock on" : " · mock off"}`, ok ? (d.mockReady ? "ok" : "warn") : "bad");
  ui.device.title = d.lastError ?? "";
  ui.setup.disabled = !ok; ui.holdStart.disabled = !ok;
  if (ok) renderDirty(); else { ui.play.disabled = true; ui.resume.disabled = true; }
}
function addLog(e: LogEntry) {
  ui.log.textContent += `${new Date(e.at).toLocaleTimeString("ru")} ${e.msg}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
}
function renderSession(m: Extract<ServerMsg, { type: "hello" }>) {
  const s = m.session;
  if (!s?.routeId || m.state.status !== "idle" || s.t <= 0 || s.status === "idle") { ui.sessionHint.textContent = ""; return; }
  ui.sessionHint.innerHTML = `<span>Прошлая сессия: ${s.routeId}, t=${fmtT(s.t)} (${s.status})</span><button class="small">${ico(RotateCcw)}Продолжить</button>`;
  ui.sessionHint.querySelector("button")!.onclick = () => send({ type: "play", routeId: s.routeId, fromT: s.t });
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = ev => {
    const m: ServerMsg = JSON.parse(ev.data);
    switch (m.type) {
      case "hello": ui.log.textContent = ""; m.log.forEach(addLog); renderDevice(m.device); renderPlayer(m.state); renderSession(m); break;
      case "player": renderPlayer(m.state); break;
      case "device": renderDevice(m.device); break;
      case "log": addLog(m.entry); break;
      case "error": addLog({ at: Date.now(), msg: "ERROR " + m.message }); notyf.error(m.message); break;
    }
  };
  ws.onclose = () => { setPill(ui.device, "сервер недоступен", "bad"); setTimeout(connect, 1500); };
}

createIcons({ icons: ICONS });
writeForm(); render();
await loadRoutes("");
if (routes.length) { ui.routeSelect.value = routes[0].id; selectRoute(); }
connect();
