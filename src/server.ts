import { readdir, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Adb } from "./adb";
import { Player, type PlayerState } from "./player";
import { buildTimeline, type Route } from "./geo";

const ROOT = import.meta.dir + "/..";
const ROUTES_DIR = join(ROOT, "routes");
const DATA_DIR = join(ROOT, "data");
const PUBLIC_DIR = join(ROOT, "public");
const SESSION_FILE = join(DATA_DIR, "session.json");
const PORT = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(PORT) || PORT <= 0) { console.error(`Некорректный PORT: ${process.env.PORT}`); process.exit(1); }
const SERIAL = process.env.ADB_SERIAL ?? null;

for (const d of [ROUTES_DIR, DATA_DIR]) if (!existsSync(d)) await mkdir(d, { recursive: true });

const logBuf: { at: number; msg: string }[] = [];
function log(msg: string) {
  const entry = { at: Date.now(), msg };
  logBuf.push(entry);
  if (logBuf.length > 200) logBuf.shift();
  console.log(new Date(entry.at).toISOString().slice(11, 19), msg);
  broadcast({ type: "log", entry });
}

const adb = new Adb(SERIAL);
const player = new Player(adb, persistSession, log);

async function persistSession(s: PlayerState) {
  await writeFile(SESSION_FILE, JSON.stringify({ routeId: s.routeId, t: s.t, status: s.status, savedAt: Date.now() }, null, 2));
}

async function loadSession(): Promise<{ routeId: string; t: number; status: string; savedAt: number } | null> {
  try { return JSON.parse(await readFile(SESSION_FILE, "utf8")); } catch { return null; }
}

function routeFile(id: string) {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error("bad id");
  return join(ROUTES_DIR, id + ".json");
}

async function listRoutes(): Promise<Route[]> {
  const files = (await readdir(ROUTES_DIR)).filter((f) => f.endsWith(".json"));
  const out: Route[] = [];
  for (const f of files) {
    try { out.push(JSON.parse(await readFile(join(ROUTES_DIR, f), "utf8"))); } catch {}
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function getRoute(id: string): Promise<Route | null> {
  try { return JSON.parse(await readFile(routeFile(id), "utf8")); } catch { return null; }
}

function normalizeRoute(input: any, existing?: Route | null): Route {
  const now = new Date().toISOString();
  const id = existing?.id ?? input.id ?? ("r" + Date.now().toString(36));
  const wps = Array.isArray(input.waypoints) ? input.waypoints : [];
  return {
    id,
    name: String(input.name ?? existing?.name ?? "Маршрут").slice(0, 80),
    speedMps: clamp(Number(input.speedMps ?? existing?.speedMps ?? 1.4), 0.1, 30),
    noisePosM: clamp(Number(input.noisePosM ?? existing?.noisePosM ?? 1.5), 0, 20),
    noiseSpeedPct: clamp(Number(input.noiseSpeedPct ?? existing?.noiseSpeedPct ?? 15), 0, 60),
    accuracyMin: clamp(Number(input.accuracyMin ?? existing?.accuracyMin ?? 3), 1, 100),
    accuracyMax: clamp(Number(input.accuracyMax ?? existing?.accuracyMax ?? 8), 1, 100),
    waypoints: wps.map((w: any) => ({
      lat: Number(w.lat), lon: Number(w.lon),
      pauseSec: w.pauseSec ? clamp(Number(w.pauseSec), 0, 36000) : 0,
      speedMps: w.speedMps == null || w.speedMps === "" ? null : clamp(Number(w.speedMps), 0.1, 30),
    })).filter((w: any) => Number.isFinite(w.lat) && Number.isFinite(w.lon)),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

const clamp = (v: number, a: number, b: number) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);

const clients = new Set<any>();
function broadcast(msg: any) {
  const s = JSON.stringify(msg);
  for (const c of clients) { try { c.send(s); } catch {} }
}

player.onChange((s) => broadcast({ type: "player", state: s }));

async function deviceInfo() {
  const state = await adb.refreshState();
  return { state, serial: adb.serial, mockReady: adb.mockReady, lastError: adb.lastError, problem: adb.problem() };
}

const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function serve() {
  return Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }

    if (p === "/api/routes" && req.method === "GET") return json(await listRoutes());
    if (p === "/api/routes" && req.method === "POST") {
      const r = normalizeRoute(await req.json());
      await writeFile(routeFile(r.id), JSON.stringify(r, null, 2));
      log(`route saved: ${r.name} (${r.waypoints.length} pts)`);
      return json(r);
    }
    const m = p.match(/^\/api\/routes\/([a-z0-9_-]+)$/i);
    if (m) {
      const id = m[1];
      if (req.method === "GET") { const r = await getRoute(id); return r ? json(r) : json({ error: "not found" }, 404); }
      if (req.method === "PUT") {
        const r = normalizeRoute(await req.json(), await getRoute(id));
        await writeFile(routeFile(r.id), JSON.stringify(r, null, 2));
        log(`route saved: ${r.name} (${r.waypoints.length} pts)`);
        if (player.route?.id === r.id && player.state.status !== "playing") player.load(r, player.state.t);
        return json(r);
      }
      if (req.method === "DELETE") { try { await unlink(routeFile(id)); } catch {} log(`route deleted: ${id}`); return json({ ok: true }); }
    }
    if (p === "/api/timeline" && req.method === "POST") {
      const r = normalizeRoute(await req.json());
      return json(buildTimeline(r));
    }
    if (p === "/api/device") return json(await deviceInfo());
    if (p === "/api/session") return json(await loadSession());
    if (p === "/api/log") return json(logBuf);

    if (p === "/") return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
    const f = Bun.file(join(PUBLIC_DIR, p.replace(/^\/+/, "").replace(/\.\./g, "")));
    if (await f.exists()) return new Response(f);
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "hello", state: player.state, device: await deviceInfo(), log: logBuf, session: await loadSession() }));
    },
    close(ws) { clients.delete(ws); },
    async message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        switch (msg.type) {
          case "play": {
            const r = await getRoute(msg.routeId);
            if (!r) { ws.send(JSON.stringify({ type: "error", message: "route not found" })); return; }
            await player.play(r, Number(msg.fromT ?? 0));
            break;
          }
          case "pause": player.pause(); break;
          case "resume": await player.resume(); break;
          case "stop": player.stop(); break;
          case "seek": player.seek(Number(msg.t)); break;
          case "hold": await player.holdOnce(Number(msg.lat), Number(msg.lon), Number(msg.acc ?? 5)); break;
          case "setup": { const ok = await adb.setup(); log(ok ? "mock setup ok" : `mock setup failed: ${adb.lastError}`); broadcast({ type: "device", device: await deviceInfo() }); break; }
          case "cleanup": {
            if (player.state.status === "playing") player.stop();
            const ok = await adb.cleanup();
            log(ok ? "mock cleanup ok, phone back to real GPS" : `cleanup failed: ${adb.lastError}`);
            broadcast({ type: "device", device: await deviceInfo() });
            break;
          }
          case "device": broadcast({ type: "device", device: await deviceInfo() }); break;
          case "setAutoResume": player.state.autoResume = !!msg.value; break;
        }
      } catch (e: any) {
        log(`ws error: ${e?.message ?? e}`);
        ws.send(JSON.stringify({ type: "error", message: String(e?.message ?? e) }));
      }
    },
  },
  });
}
try {
  serve();
} catch (e: any) {
  if (/EADDRINUSE|address already in use/i.test(String(e?.message ?? e))) console.error(`Порт ${PORT} занят. Остановите другой экземпляр или задайте PORT=...`);
  else console.error(`Не удалось запустить сервер: ${e?.message ?? e}`);
  process.exit(1);
}

setInterval(async () => {
  const before = adb.state;
  const info = await deviceInfo();
  if (info.state !== before) { log(`device: ${before} -> ${info.state}`); broadcast({ type: "device", device: info }); }
}, 5000);

async function shutdown() {
  log("shutdown: pausing playback, keeping phone state");
  player.pause();
  await persistSession(player.state);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`server on http://localhost:${PORT}`);
{
  const info = await deviceInfo();
  if (info.problem) log(`⚠ ${info.problem}`);
  else log(`device ready: ${info.serial}`);
}
