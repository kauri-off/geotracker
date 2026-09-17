export type Waypoint = {
  lat: number;
  lon: number;
  pauseSec?: number;
  speedMps?: number | null;
};

export type Route = {
  id: string;
  name: string;
  speedMps: number;
  noisePosM: number;
  noiseSpeedPct: number;
  accuracyMin: number;
  accuracyMax: number;
  waypoints: Waypoint[];
  createdAt: string;
  updatedAt: string;
};

export type Segment = {
  index: number;
  from: Waypoint;
  to: Waypoint;
  distM: number;
  bearingDeg: number;
  speedMps: number;
  pauseBeforeSec: number;
  startT: number;
  moveStartT: number;
  endT: number;
};

export type Timeline = {
  segments: Segment[];
  totalDistM: number;
  totalTimeSec: number;
  totalPauseSec: number;
  totalMoveSec: number;
  avgSpeedMps: number;
  finalPauseSec: number;
};

export type Pos = {
  lat: number;
  lon: number;
  bearingDeg: number;
  speedMps: number;
  segIndex: number;
  paused: boolean;
  finished: boolean;
  progress: number;
  distDoneM: number;
};

const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function offsetMeters(p: { lat: number; lon: number }, northM: number, eastM: number) {
  const dLat = northM / R;
  const dLon = eastM / (R * Math.cos(toRad(p.lat)));
  return { lat: p.lat + toDeg(dLat), lon: p.lon + toDeg(dLon) };
}

export function lerp(a: Waypoint, b: Waypoint, f: number) {
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

export function buildTimeline(route: Route): Timeline {
  const wps = route.waypoints;
  const segments: Segment[] = [];
  let t = 0;
  let totalDist = 0;
  let totalPause = 0;
  let totalMove = 0;
  for (let i = 1; i < wps.length; i++) {
    const from = wps[i - 1];
    const to = wps[i];
    const distM = distanceM(from, to);
    const speed = Math.max(0.05, from.speedMps ?? route.speedMps);
    const pause = Math.max(0, from.pauseSec ?? 0);
    const moveSec = distM / speed;
    const seg: Segment = {
      index: i - 1,
      from,
      to,
      distM,
      bearingDeg: bearingDeg(from, to),
      speedMps: speed,
      pauseBeforeSec: pause,
      startT: t,
      moveStartT: t + pause,
      endT: t + pause + moveSec,
    };
    segments.push(seg);
    t = seg.endT;
    totalDist += distM;
    totalPause += pause;
    totalMove += moveSec;
  }
  const finalPause = wps.length ? Math.max(0, wps[wps.length - 1].pauseSec ?? 0) : 0;
  totalPause += finalPause;
  t += finalPause;
  return {
    segments,
    totalDistM: totalDist,
    totalTimeSec: t,
    totalPauseSec: totalPause,
    totalMoveSec: totalMove,
    avgSpeedMps: totalMove > 0 ? totalDist / totalMove : 0,
    finalPauseSec: finalPause,
  };
}

export function positionAt(route: Route, tl: Timeline, t: number): Pos | null {
  const wps = route.waypoints;
  if (!wps.length) return null;
  if (tl.segments.length === 0) {
    return { ...wps[0], bearingDeg: 0, speedMps: 0, segIndex: 0, paused: true, finished: true, progress: 1, distDoneM: 0 };
  }
  if (t <= 0) {
    const s = tl.segments[0];
    return { lat: s.from.lat, lon: s.from.lon, bearingDeg: s.bearingDeg, speedMps: 0, segIndex: 0, paused: s.pauseBeforeSec > 0, finished: false, progress: 0, distDoneM: 0 };
  }
  let done = 0;
  for (const s of tl.segments) {
    if (t < s.moveStartT) {
      return { lat: s.from.lat, lon: s.from.lon, bearingDeg: s.bearingDeg, speedMps: 0, segIndex: s.index, paused: true, finished: false, progress: t / tl.totalTimeSec, distDoneM: done };
    }
    if (t < s.endT) {
      const f = (t - s.moveStartT) / (s.endT - s.moveStartT);
      const p = lerp(s.from, s.to, f);
      return { ...p, bearingDeg: s.bearingDeg, speedMps: s.speedMps, segIndex: s.index, paused: false, finished: false, progress: t / tl.totalTimeSec, distDoneM: done + s.distM * f };
    }
    done += s.distM;
  }
  const last = tl.segments[tl.segments.length - 1];
  const finished = t >= tl.totalTimeSec;
  return { lat: last.to.lat, lon: last.to.lon, bearingDeg: last.bearingDeg, speedMps: 0, segIndex: last.index, paused: !finished, finished, progress: Math.min(1, t / tl.totalTimeSec), distDoneM: tl.totalDistM };
}

export function fmtDuration(sec: number): string {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}ч ${m}м ${s}с` : m ? `${m}м ${s}с` : `${s}с`;
}
