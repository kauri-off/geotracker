import { describe, expect, test } from "bun:test";
import { buildTimeline, distanceM, positionAt, type Route } from "../src/geo";

const route: Route = {
  id: "t", name: "t", speedMps: 1, noisePosM: 0, noiseSpeedPct: 0, accuracyMin: 3, accuracyMax: 3,
  createdAt: "", updatedAt: "",
  waypoints: [
    { lat: 0, lon: 0, pauseSec: 10 },
    { lat: 0.0009, lon: 0, speedMps: 2 },
    { lat: 0.0009, lon: 0.0009, pauseSec: 5 },
  ],
};

describe("geo", () => {
  test("distance ~100 m per 0.0009 deg lat", () => {
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 0.0009, lon: 0 })).toBeCloseTo(100.1, 0);
  });

  test("timeline sums pauses, per-segment speeds, final pause", () => {
    const tl = buildTimeline(route);
    expect(tl.segments.length).toBe(2);
    expect(tl.totalPauseSec).toBe(15);
    expect(tl.segments[0].speedMps).toBe(1);
    expect(tl.segments[1].speedMps).toBe(2);
    expect(tl.totalTimeSec).toBeCloseTo(10 + 100.1 / 1 + 100.1 / 2 + 5, 0);
  });

  test("position holds during pause, moves after, finishes at end", () => {
    const tl = buildTimeline(route);
    const start = positionAt(route, tl, 5)!;
    expect(start.paused).toBe(true);
    expect(start.lat).toBe(0);
    const mid = positionAt(route, tl, 60)!;
    expect(mid.paused).toBe(false);
    expect(mid.lat).toBeGreaterThan(0);
    expect(mid.lat).toBeLessThan(0.0009);
    const end = positionAt(route, tl, tl.totalTimeSec + 1)!;
    expect(end.finished).toBe(true);
    expect(end.lon).toBe(0.0009);
  });

  test("single waypoint route is finished immediately", () => {
    const r = { ...route, waypoints: [route.waypoints[0]] };
    const tl = buildTimeline(r);
    expect(tl.totalDistM).toBe(0);
    expect(positionAt(r, tl, 0)!.finished).toBe(true);
  });
});
