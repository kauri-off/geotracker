export type DeviceState = "device" | "offline" | "unauthorized" | "none" | "adb-missing";

export type MockFix = { lat: number; lon: number; acc: number; provider: string };

const PROVIDERS = ["gps", "network", "fused"];

export const DEVICE_PROBLEMS: Record<DeviceState, string | null> = {
  device: null,
  "adb-missing": "adb не найден в PATH. Установите Android platform-tools: https://developer.android.com/tools/releases/platform-tools",
  none: "Телефон не подключён. Включите USB-отладку в настройках разработчика и подключите кабель.",
  unauthorized: "Телефон не авторизован. Подтвердите запрос USB-отладки на экране телефона.",
  offline: "Телефон в состоянии offline. Переподключите кабель или выполните adb kill-server.",
};

export class Adb {
  serial: string | null;
  bin: string;
  state: DeviceState = "none";
  mockReady = false;
  lastError: string | null = null;
  consecutiveFailures = 0;

  constructor(serial: string | null = null, bin = "adb") {
    this.serial = serial;
    this.bin = bin;
  }

  private base(): string[] {
    return this.serial ? [this.bin, "-s", this.serial] : [this.bin];
  }

  problem(): string | null {
    return DEVICE_PROBLEMS[this.state];
  }

  async run(args: string[], timeoutMs = 6000): Promise<{ ok: boolean; out: string; err: string }> {
    try {
      const proc = Bun.spawn([...this.base(), ...args], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      clearTimeout(timer);
      const ok = code === 0;
      if (!ok) this.lastError = (err || out).trim().slice(0, 300) || `exit ${code}`;
      return { ok, out, err };
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      if (/ENOENT|not found|No such file/i.test(this.lastError)) this.state = "adb-missing";
      return { ok: false, out: "", err: this.lastError };
    }
  }

  shell(script: string, timeoutMs?: number) {
    return this.run(["shell", script], timeoutMs);
  }

  async refreshState(): Promise<DeviceState> {
    const r = await this.run(["devices"], 4000);
    if (!r.ok) {
      if (this.state !== "adb-missing") this.state = "none";
      return this.state;
    }
    const lines = r.out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
    const rows = lines.map((l) => l.split(/\s+/)).map(([s, st]) => ({ serial: s, st }));
    const row = this.serial ? rows.find((x) => x.serial === this.serial) : rows[0];
    if (!row) this.state = "none";
    else if (row.st === "device") this.state = "device";
    else if (row.st === "unauthorized") this.state = "unauthorized";
    else this.state = "offline";
    if (!this.serial && row) this.serial = row.serial;
    return this.state;
  }

  async setup(): Promise<boolean> {
    const cmds = ["appops set com.android.shell android:mock_location allow"];
    for (const p of PROVIDERS) {
      cmds.push(`cmd location providers add-test-provider ${p} --supportsAltitude --supportsSpeed --supportsBearing`);
      cmds.push(`cmd location providers set-test-provider-enabled ${p} true`);
    }
    const r = await this.shell(cmds.join(" && "), 15000);
    this.mockReady = r.ok;
    if (r.ok) this.consecutiveFailures = 0;
    return r.ok;
  }

  async cleanup(): Promise<boolean> {
    const cmds = PROVIDERS.map((p) => `cmd location providers remove-test-provider ${p}`);
    cmds.push("appops set com.android.shell android:mock_location default");
    const r = await this.shell(cmds.join("; "), 15000);
    this.mockReady = false;
    return r.ok;
  }

  async setLocation(lat: number, lon: number, acc: number): Promise<boolean> {
    const loc = `${lat.toFixed(7)},${lon.toFixed(7)}`;
    const a = Math.max(1, acc).toFixed(1);
    const cmds = PROVIDERS.map((p) => `cmd location providers set-test-provider-location ${p} --location ${loc} --accuracy ${a}`);
    const r = await this.shell(cmds.join(" && "), 5000);
    if (r.ok) this.consecutiveFailures = 0;
    else {
      this.consecutiveFailures++;
      if (/not a test provider|does not exist|Unknown provider|SecurityException/i.test(r.err + r.out)) this.mockReady = false;
    }
    return r.ok;
  }

  async lastMock(): Promise<MockFix | null> {
    const r = await this.shell("dumpsys location | grep -m1 'last mock location'", 5000);
    if (!r.ok) return null;
    const m = r.out.match(/Location\[(\w+)\s+(-?\d+\.\d+),(-?\d+\.\d+)\s+hAcc=([\d.]+)/);
    if (!m) return null;
    return { provider: m[1], lat: parseFloat(m[2]), lon: parseFloat(m[3]), acc: parseFloat(m[4]) };
  }

  async mockAllowed(): Promise<boolean> {
    const r = await this.shell("appops get com.android.shell android:mock_location");
    return r.ok && /allow/.test(r.out);
  }

  async providersPresent(): Promise<boolean> {
    const r = await this.shell("dumpsys location | grep -c 'mock provider override'");
    return r.ok;
  }
}
