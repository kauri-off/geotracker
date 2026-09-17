import { describe, expect, test } from "bun:test";
import { Adb } from "../src/adb";

describe("adb diagnostics", () => {
  test("missing adb binary is reported as adb-missing with a hint", async () => {
    const adb = new Adb(null, "/nonexistent/adb-binary");
    expect(await adb.refreshState()).toBe("adb-missing");
    expect(adb.problem()).toContain("platform-tools");
    expect(await adb.setLocation(0, 0, 3)).toBe(false);
    expect(adb.consecutiveFailures).toBe(1);
  });

  test("no attached device is reported as none", async () => {
    const fake = "/tmp/fake-adb-" + process.pid;
    await Bun.write(fake, "#!/bin/sh\necho 'List of devices attached'\n");
    Bun.spawnSync(["chmod", "+x", fake]);
    const adb = new Adb(null, fake);
    expect(await adb.refreshState()).toBe("none");
    expect(adb.problem()).toContain("USB");
  });
});
