import { Adb } from "./adb";
import { buildTimeline, distanceM, offsetMeters, positionAt, type Pos, type Route, type Timeline } from "./geo";

export type PlayerStatus = "idle" | "playing" | "paused" | "finished" | "holding" | "error";

export type PlayerState = {
  status: PlayerStatus;
  routeId: string | null;
  routeName: string | null;
  t: number;
  totalTimeSec: number;
  totalDistM: number;
  pos: Pos | null;
  sent: { lat: number; lon: number; acc: number; at: number } | null;
  confirmed: { lat: number; lon: number; acc: number; at: number; lagM: number } | null;
  confirmLagTicks: number;
  ticks: number;
  failures: number;
  speedFactor: number;
  message: string | null;
  startedAt: number | null;
  autoResume: boolean;
};

type Listener = (s: PlayerState) => void;

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Player {
  adb: Adb;
  route: Route | null = null;
  tl: Timeline | null = null;
  state: PlayerState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: Listener[] = [];
  private lastTickAt = 0;
  private jitterN = 0;
  private jitterE = 0;
  private accCur = 5;
  private speedFactor = 1;
  private sentHistory: { lat: number; lon: number }[] = [];
  private busy = false;
  private persist: (s: PlayerState) => void;
  private log: (m: string) => void;

  constructor(adb: Adb, persist: (s: PlayerState) => void, log: (m: string) => void) {
    this.adb = adb;
    this.persist = persist;
    this.log = log;
    this.state = {
      status: "idle", routeId: null, routeName: null, t: 0, totalTimeSec: 0, totalDistM: 0,
      pos: null, sent: null, confirmed: null, confirmLagTicks: 0, ticks: 0, failures: 0,
      speedFactor: 1, message: null, startedAt: null, autoResume: true,
    };
  }

  onChange(l: Listener) { this.listeners.push(l); }

  private emit() {
    this.state.speedFactor = this.speedFactor;
    for (const l of this.listeners) l(this.state);
  }

  load(route: Route, fromT = 0) {
    this.route = route;
    this.tl = buildTimeline(route);
    this.state.routeId = route.id;
    this.state.routeName = route.name;
    this.state.totalTimeSec = this.tl.totalTimeSec;
    this.state.totalDistM = this.tl.totalDistM;
    this.state.t = Math.max(0, Math.min(fromT, this.tl.totalTimeSec));
    this.state.pos = positionAt(route, this.tl, this.state.t);
    this.state.ticks = 0;
    this.state.failures = 0;
    this.state.confirmed = null;
    this.state.confirmLagTicks = 0;
    this.sentHistory = [];
    this.jitterN = this.jitterE = 0;
    this.accCur = (route.accuracyMin + route.accuracyMax) / 2;
    this.speedFactor = 1;
  }

  async play(route: Route, fromT = 0): Promise<boolean> {
    if (route.waypoints.length < 1) { this.fail("Маршрут пустой"); return false; }
    this.stopTimer();
    this.load(route, fromT);
    const ok = await this.ensureDevice();
    if (!ok) return false;
    this.state.status = "playing";
    this.state.message = null;
    this.state.startedAt = Date.now();
    this.log(`play "${route.name}" from t=${fromT.toFixed(0)}s`);
    this.startTimer();
    await this.tick(true);
    return true;
  }

  async resume(): Promise<boolean> {
    if (!this.route) return false;
    if (this.state.status === "playing") return true;
    const ok = await this.ensureDevice();
    if (!ok) return false;
    this.state.status = this.state.pos?.finished ? "holding" : "playing";
    this.state.message = null;
    this.log(`resume at t=${this.state.t.toFixed(0)}s`);
    this.startTimer();
    return true;
  }

  pause() {
    if (this.state.status !== "playing") return;
    this.state.status = "paused";
    this.log(`pause at t=${this.state.t.toFixed(0)}s`);
    this.persist(this.state);
    this.emit();
  }

  seek(t: number) {
    if (!this.route || !this.tl) return;
    this.state.t = Math.max(0, Math.min(t, this.tl.totalTimeSec));
    this.state.pos = positionAt(this.route, this.tl, this.state.t);
    if (this.state.status === "finished" || this.state.status === "holding") this.state.status = "paused";
    this.log(`seek to t=${this.state.t.toFixed(0)}s`);
    this.persist(this.state);
    this.emit();
  }

  stop() {
    this.stopTimer();
    this.state.status = "idle";
    this.state.message = null;
    this.log("stop (phone keeps last point)");
    this.persist(this.state);
    this.emit();
  }

  private fail(msg: string) {
    this.stopTimer();
    this.state.status = "error";
    this.state.message = msg;
    this.log(`error: ${msg}`);
    this.persist(this.state);
    this.emit();
  }

  private async ensureDevice(): Promise<boolean> {
    const st = await this.adb.refreshState();
    if (st !== "device") { this.fail(this.adb.problem() ?? `Телефон недоступен: ${st}`); return false; }
    if (!this.adb.mockReady) {
      const ok = await this.adb.setup();
      if (!ok) { this.fail(`Не удалось включить mock: ${this.adb.lastError}`); return false; }
      this.log("mock providers set up");
    }
    return true;
  }

  private startTimer() {
    this.stopTimer();
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(false), 1000);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(first: boolean) {
    if (this.busy || !this.route || !this.tl) return;
    this.busy = true;
    try {
      const now = Date.now();
      const dt = first ? 0 : Math.min(3, (now - this.lastTickAt) / 1000);
      this.lastTickAt = now;
      const r = this.route;

      if (this.state.status === "playing") {
        const pct = r.noiseSpeedPct / 100;
        this.speedFactor += (1 - this.speedFactor) * 0.15 + gauss() * pct * 0.25;
        this.speedFactor = Math.max(1 - pct * 1.5, Math.min(1 + pct * 1.5, this.speedFactor));
        this.state.t += dt * this.speedFactor;
      }
      const pos = positionAt(r, this.tl, this.state.t);
      if (!pos) return;
      this.state.pos = pos;

      const sigma = r.noisePosM;
      this.jitterN += (0 - this.jitterN) * 0.3 + gauss() * sigma * 0.5;
      this.jitterE += (0 - this.jitterE) * 0.3 + gauss() * sigma * 0.5;
      const p = sigma > 0 ? offsetMeters(pos, this.jitterN, this.jitterE) : pos;
      const accTarget = r.accuracyMin + Math.random() * Math.max(0, r.accuracyMax - r.accuracyMin);
      this.accCur += (accTarget - this.accCur) * 0.3;

      const ok = await this.adb.setLocation(p.lat, p.lon, this.accCur);
      this.state.ticks++;
      if (ok) {
        this.state.sent = { lat: p.lat, lon: p.lon, acc: this.accCur, at: now };
        this.sentHistory.push({ lat: p.lat, lon: p.lon });
        if (this.sentHistory.length > 5) this.sentHistory.shift();
      } else {
        this.state.failures++;
        this.log(`setLocation failed (${this.adb.consecutiveFailures}): ${this.adb.lastError}`);
        if (this.adb.consecutiveFailures >= 3) await this.handleLoss();
      }

      if (this.state.ticks % 3 === 0 || first) await this.confirm();

      if (pos.finished && this.state.status === "playing") {
        this.state.status = "holding";
        this.log(`finished: ${this.tl.totalDistM.toFixed(0)} m in ${this.state.t.toFixed(0)} s, holding last point`);
      }
      if (this.state.ticks % 5 === 0) this.persist(this.state);
      this.emit();
    } finally {
      this.busy = false;
    }
  }

  private async confirm() {
    const fix = await this.adb.lastMock();
    if (!fix || !this.sentHistory.length) { this.state.confirmLagTicks++; return; }
    let best = Infinity;
    for (const s of this.sentHistory) best = Math.min(best, distanceM(s, fix));
    this.state.confirmed = { lat: fix.lat, lon: fix.lon, acc: fix.acc, at: Date.now(), lagM: best };
    this.state.confirmLagTicks = best > 15 ? this.state.confirmLagTicks + 1 : 0;
    if (this.state.confirmLagTicks >= 3) this.log(`phone not confirming: last mock ${best.toFixed(0)} m away from sent`);
  }

  private async handleLoss() {
    const st = await this.adb.refreshState();
    if (st === "device") {
      this.log("device online, re-running mock setup");
      const ok = await this.adb.setup();
      if (ok) { this.adb.consecutiveFailures = 0; return; }
    }
    const wasPlaying = this.state.status === "playing";
    this.stopTimer();
    this.state.status = "error";
    this.state.message = `${this.adb.problem() ?? "Связь с телефоном потеряна."} Прогресс сохранён на t=${this.state.t.toFixed(0)}с.`;
    this.log(this.state.message);
    this.persist(this.state);
    this.emit();
    if (wasPlaying && this.state.autoResume) this.watchForDevice();
  }

  private watchForDevice() {
    const iv = setInterval(async () => {
      if (this.state.status !== "error") { clearInterval(iv); return; }
      const st = await this.adb.refreshState();
      if (st === "device") {
        clearInterval(iv);
        this.adb.mockReady = false;
        this.log("device is back, auto-resuming");
        await this.resume();
      }
    }, 3000);
  }

  async holdOnce(lat: number, lon: number, acc = 5): Promise<boolean> {
    const ok = await this.ensureDevice();
    if (!ok) return false;
    const r = await this.adb.setLocation(lat, lon, acc);
    if (r) { this.state.sent = { lat, lon, acc, at: Date.now() }; this.sentHistory = [{ lat, lon }]; await this.confirm(); }
    this.emit();
    return r;
  }
}
