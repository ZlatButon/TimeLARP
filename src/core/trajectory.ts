import type {
  AircraftTrack,
  CameraKeyframe,
  InterpolatedAircraftState,
  RadarSample,
} from '../types/radar';
import { LocalENUProjector } from './geo';
import {
  evaluateCinematicCameraPath,
  type CameraPathOptions,
} from './cameraRig';

/**
 * Shortest angular difference in degrees in range (-180, +180].
 */
export function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  let diff = ((toDeg - fromDeg + 180) % 360 + 360) % 360 - 180;
  if (diff <= -180) diff += 360;
  return diff;
}

/**
 * Shortest-angle interpolation between two headings in degrees [0, 360).
 */
export function lerpAngleDeg(fromDeg: number, toDeg: number, t: number): number {
  const delta = shortestAngleDeltaDeg(fromDeg, toDeg);
  return (((fromDeg + delta * t) % 360) + 360) % 360;
}

/**
 * Non-uniform Catmull-Rom / cubic Hermite spline evaluation for a scalar channel.
 * Respects real timestamp intervals so uneven 1s–4s radar sweeps never overshoot.
 */
export function cubicHermiteScalar(
  p0: number,
  t0: number,
  p1: number,
  t1: number,
  p2: number,
  t2: number,
  p3: number,
  t3: number,
  t: number,
): number {
  const dt = t2 - t1;
  if (dt <= 1e-6) return p1;

  const u = Math.max(0, Math.min(1, (t - t1) / dt));
  const u2 = u * u;
  const u3 = u2 * u;

  const dt01 = Math.max(1e-3, t1 - t0);
  const dt23 = Math.max(1e-3, t3 - t2);

  const m1Raw =
    t1 > t0 + 1e-4
      ? 0.5 * ((p1 - p0) / dt01 + (p2 - p1) / dt) * dt
      : p2 - p1;
  const m2Raw =
    t3 > t2 + 1e-4
      ? 0.5 * ((p2 - p1) / dt + (p3 - p2) / dt23) * dt
      : p2 - p1;

  const m1 = m1Raw * 0.85;
  const m2 = m2Raw * 0.85;

  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  return h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2;
}

/**
 * Binary search for the segment index `idx` such that samples[idx].timeSec <= t <= samples[idx+1].timeSec.
 */
function findBracketIndex(samples: RadarSample[], t: number): number {
  let lo = 0;
  let hi = samples.length - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].timeSec <= t && t <= samples[mid + 1].timeSec) {
      return mid;
    }
    if (samples[mid].timeSec < t) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(0, Math.min(samples.length - 2, lo));
}

export interface Smoothed3DSegment {
  lats: Float64Array;
  lons: Float64Array;
  alts: Float64Array;
}

const smoothed3DCache = new WeakMap<RadarSample[], Map<number, Smoothed3DSegment>>();

/**
 * Single symmetric time-weighted Gaussian pass with pinned endpoints (0 and n-1).
 */
function gaussianPass1D(
  times: Float64Array,
  input: Float64Array,
  sigmaSec: number,
): Float64Array {
  const n = input.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n <= 2 || sigmaSec <= 0.05) {
    out.set(input);
    return out;
  }

  const invTwoSigmaSq = 1 / (2 * sigmaSec * sigmaSec);
  const maxDt = sigmaSec * 3.0;

  out[0] = input[0];
  out[n - 1] = input[n - 1];

  for (let i = 1; i < n - 1; i++) {
    const ti = times[i];
    let sumW = 0;
    let sumVal = 0;

    for (let j = i; j >= 0; j--) {
      const dt = ti - times[j];
      if (dt > maxDt) break;
      const w = Math.exp(-dt * dt * invTwoSigmaSq);
      sumW += w;
      sumVal += w * input[j];
    }

    for (let j = i + 1; j < n; j++) {
      const dt = times[j] - ti;
      if (dt > maxDt) break;
      const w = Math.exp(-dt * dt * invTwoSigmaSq);
      sumW += w;
      sumVal += w * input[j];
    }

    out[i] = sumW > 0 ? sumVal / sumW : input[i];
  }

  return out;
}

/**
 * Zero-phase two-pass Gaussian smoother (forward + backward symmetric cascade).
 * Splitting bandwidth by 1/sqrt(2) across 2 passes achieves steeper high-frequency
 * rejection of noisy manual/GA zigzags and Mode-C steps with strictly ZERO time lag.
 */
function zeroPhaseTwoPassGaussian(
  times: Float64Array,
  raw: Float64Array,
  windowSec: number,
): Float64Array {
  const n = raw.length;
  if (n <= 2 || windowSec <= 0.1) {
    return new Float64Array(raw);
  }
  const sigmaTotal = Math.max(0.5, windowSec / 2.4);
  const sigmaPerPass = sigmaTotal * Math.SQRT1_2;
  const pass1 = gaussianPass1D(times, raw, sigmaPerPass);
  // Reverse-order second pass guarantees exact zero-phase symmetry
  return gaussianPass1D(times, pass1, sigmaPerPass);
}

/**
 * Zero-phase two-pass Gaussian smoothing over a radar segment's altitudes (Y).
 */
export function smoothSegmentAltitudes(samples: RadarSample[], windowSec: number): Float64Array {
  const n = samples.length;
  const times = new Float64Array(n);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = samples[i].timeSec;
    raw[i] = samples[i].altFt;
  }
  return zeroPhaseTwoPassGaussian(times, raw, windowSec);
}

/**
 * Zero-phase two-pass 3D Gaussian smoothing across ALL three trajectory channels
 * (latitude/Z, longitude/X, altitude/Y). Smooths noisy manual-flight heading/position
 * zigzags and Mode-C altitude steps without introducing temporal phase lag.
 */
export function smoothSegment3D(samples: RadarSample[], windowSec: number): Smoothed3DSegment {
  const n = samples.length;
  const times = new Float64Array(n);
  const rawLat = new Float64Array(n);
  const rawLon = new Float64Array(n);
  const rawAlt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = samples[i].timeSec;
    rawLat[i] = samples[i].lat;
    rawLon[i] = samples[i].lon;
    rawAlt[i] = samples[i].altFt;
  }

  if (n <= 2 || windowSec <= 0.1) {
    return { lats: rawLat, lons: rawLon, alts: rawAlt };
  }

  // Lateral coordinates use slightly tighter bandwidth (0.85x) to preserve crisp base-to-final turns
  const lateralWin = windowSec * 0.85;
  return {
    lats: zeroPhaseTwoPassGaussian(times, rawLat, lateralWin),
    lons: zeroPhaseTwoPassGaussian(times, rawLon, lateralWin),
    alts: zeroPhaseTwoPassGaussian(times, rawAlt, windowSec),
  };
}

function getCachedSmoothed3D(samples: RadarSample[], windowSec: number): Smoothed3DSegment | null {
  if (windowSec <= 0.1 || samples.length <= 2) return null;
  const bucket = Math.round(windowSec * 2) / 2;
  let byWin = smoothed3DCache.get(samples);
  if (!byWin) {
    byWin = new Map<number, Smoothed3DSegment>();
    smoothed3DCache.set(samples, byWin);
  }
  let cached = byWin.get(bucket);
  if (!cached) {
    cached = smoothSegment3D(samples, bucket);
    byWin.set(bucket, cached);
  }
  return cached;
}

/**
 * Evaluate smooth 3D aircraft kinematic state at exact simulation timestamp `timeSec`.
 * Computes the true 3D spline tangent vector (vx, vy * verticalExaggeration, vz) using
 * Gaussian-smoothed altitudes so Mode-C 50ft steps never cause vertical waves.
 */
export function evaluateAircraftAtTime(
  track: AircraftTrack,
  timeSec: number,
  projector: LocalENUProjector,
  verticalExaggeration = 1,
  altSmoothSec = 0,
): InterpolatedAircraftState | null {
  if (timeSec < track.firstSeen || timeSec > track.lastSeen) {
    return null;
  }

  let activeSeg = null;
  for (let i = 0; i < track.segments.length; i++) {
    const seg = track.segments[i];
    if (timeSec >= seg.startTime && timeSec <= seg.endTime) {
      activeSeg = seg;
      break;
    }
  }
  if (!activeSeg || activeSeg.samples.length === 0) {
    return null;
  }

  const samples = activeSeg.samples;
  if (samples.length === 1) {
    const s = samples[0];
    const enu = projector.toENU(s.lat, s.lon, s.altFt);
    const hdgRad = (s.headingDeg * Math.PI) / 180;
    return {
      callsign: track.callsign,
      active: true,
      lat: s.lat,
      lon: s.lon,
      x: enu.x,
      y: enu.y,
      z: enu.z,
      altFt: s.altFt,
      gsKt: s.gsKt,
      headingDeg: s.headingDeg,
      pitchRad: 0,
      visualPitchRad: 0,
      tangent3D: [Math.sin(hdgRad), 0, -Math.cos(hdgRad)],
      bankRad: 0,
      verticalRateFpm: 0,
      squawk: track.squawk,
      aircraftType: track.flightPlan?.aircraftType ?? 'B738/M',
      origin: track.flightPlan?.origin ?? 'UWGG',
      destination: track.flightPlan?.destination ?? 'UUEE',
      clearedFl: track.clearedFl,
      sidOrStar: track.flightPlan?.sidOrStar,
    };
  }

  const smoothed3D = getCachedSmoothed3D(samples, altSmoothSec);
  const latAt = (idx: number): number => (smoothed3D ? smoothed3D.lats[idx] : samples[idx].lat);
  const lonAt = (idx: number): number => (smoothed3D ? smoothed3D.lons[idx] : samples[idx].lon);
  const altAt = (idx: number): number => (smoothed3D ? smoothed3D.alts[idx] : samples[idx].altFt);

  const evalSplineAt = (tEval: number) => {
    const clampedT = Math.max(activeSeg.startTime, Math.min(activeSeg.endTime, tEval));
    const idx = findBracketIndex(samples, clampedT);
    const i0 = Math.max(0, idx - 1);
    const i1 = idx;
    const i2 = idx + 1;
    const i3 = Math.min(samples.length - 1, idx + 2);
    const s0 = samples[i0];
    const s1 = samples[i1];
    const s2 = samples[i2];
    const s3 = samples[i3];
    const lat = cubicHermiteScalar(latAt(i0), s0.timeSec, latAt(i1), s1.timeSec, latAt(i2), s2.timeSec, latAt(i3), s3.timeSec, clampedT);
    const lon = cubicHermiteScalar(lonAt(i0), s0.timeSec, lonAt(i1), s1.timeSec, lonAt(i2), s2.timeSec, lonAt(i3), s3.timeSec, clampedT);
    const altFt = Math.max(
      0,
      cubicHermiteScalar(altAt(i0), s0.timeSec, altAt(i1), s1.timeSec, altAt(i2), s2.timeSec, altAt(i3), s3.timeSec, clampedT),
    );
    const enu = projector.toENU(lat, lon, altFt);
    return { lat, lon, altFt, enu, s1, s2 };
  };

  const curr = evalSplineAt(timeSec);
  const dtSeg = Math.max(1e-4, curr.s2.timeSec - curr.s1.timeSec);
  const alpha = Math.max(0, Math.min(1, (timeSec - curr.s1.timeSec) / dtSeg));
  const gsKt = Math.max(0, curr.s1.gsKt + (curr.s2.gsKt - curr.s1.gsKt) * alpha);

  // Central-difference 3D spline tangent derivative (using generous smooth window for clean turn/climb kinematics)
  const hWin = Math.min(1.8, Math.max(0.35, dtSeg * 0.45));
  const tPrev = Math.max(activeSeg.startTime, timeSec - hWin);
  const tNext = Math.min(activeSeg.endTime, timeSec + hWin);
  const spanT = Math.max(1e-4, tNext - tPrev);

  const prev = evalSplineAt(tPrev);
  const next = evalSplineAt(tNext);

  const dx = next.enu.x - prev.enu.x;
  const dyTrue = next.enu.y - prev.enu.y;
  const dz = next.enu.z - prev.enu.z;
  const horizDist = Math.hypot(dx, dz);

  // Heading from 3D spline horizontal tangent (with fallback to shortest-angle radar heading)
  let splineHeading = lerpAngleDeg(curr.s1.headingDeg, curr.s2.headingDeg, alpha);
  if (horizDist > 0.002) {
    splineHeading = LocalENUProjector.headingFromDeltaXZ(dx, dz);
  }

  // Physical vertical speed (fpm) and physical pitch
  const verticalRateFpm = ((next.altFt - prev.altFt) / spanT) * 60;
  const pitchRad =
    horizDist > 1e-4 ? Math.atan2(dyTrue, horizDist) : 0;

  // Visual 3D spline tangent accounting for Vertical Exaggeration (clamped to realistic ±28° pitch)
  const dyVisual = dyTrue * verticalExaggeration;
  const visualPitchRad =
    horizDist > 1e-4
      ? Math.max(-0.48, Math.min(0.48, Math.atan2(dyVisual, horizDist)))
      : 0;

  let tx = dx;
  let ty = dyVisual;
  let tz = dz;
  const tLen = Math.hypot(tx, ty, tz);
  if (tLen > 1e-5) {
    tx /= tLen;
    ty /= tLen;
    tz /= tLen;
  } else {
    const hdgRad = (splineHeading * Math.PI) / 180;
    tx = Math.sin(hdgRad);
    ty = 0;
    tz = -Math.cos(hdgRad);
  }

  // Smooth turn-rate bank/roll computation over a slightly wider window for fluid banking into turns
  const turnWin = Math.min(4.5, Math.max(1.2, dtSeg));
  const tTurnA = Math.max(activeSeg.startTime, timeSec - turnWin);
  const tTurnB = Math.min(activeSeg.endTime, timeSec + turnWin);
  let bankRad = 0;
  if (tTurnB - tTurnA > 0.4) {
    const pBefore = evalSplineAt(tTurnA);
    const pAfter = evalSplineAt(tTurnB);
    const dx1 = curr.enu.x - pBefore.enu.x;
    const dz1 = curr.enu.z - pBefore.enu.z;
    const dx2 = pAfter.enu.x - curr.enu.x;
    const dz2 = pAfter.enu.z - curr.enu.z;
    if (Math.hypot(dx1, dz1) > 0.004 && Math.hypot(dx2, dz2) > 0.004) {
      const h1 = LocalENUProjector.headingFromDeltaXZ(dx1, dz1);
      const h2 = LocalENUProjector.headingFromDeltaXZ(dx2, dz2);
      const dHdg = shortestAngleDeltaDeg(h1, h2);
      const turnRateDegPerSec = dHdg / ((tTurnB - tTurnA) * 0.5);
      // Physical bank angle proportional to turn rate (strictly clamped ±30° for graceful manual-flight attitude)
      bankRad = Math.max(-0.52, Math.min(0.52, ((turnRateDegPerSec * Math.PI) / 180) * 8.5));
    }
  }

  return {
    callsign: track.callsign,
    active: true,
    lat: curr.lat,
    lon: curr.lon,
    x: curr.enu.x,
    y: curr.enu.y,
    z: curr.enu.z,
    altFt: curr.altFt,
    gsKt,
    headingDeg: splineHeading,
    pitchRad: Math.max(-0.42, Math.min(0.42, pitchRad)),
    visualPitchRad,
    tangent3D: [tx, ty, tz],
    bankRad,
    verticalRateFpm,
    squawk: curr.s1.squawk ?? track.squawk,
    aircraftType: track.flightPlan?.aircraftType ?? 'B738/M',
    origin: track.flightPlan?.origin ?? 'UWGG',
    destination: track.flightPlan?.destination ?? 'UUEE',
    clearedFl: track.clearedFl,
    sidOrStar: track.flightPlan?.sidOrStar,
  };
}

/**
 * Sample trail history points backwards in time from `timeSec` for `trailLengthSec`
 * within the currently active continuous radar segment.
 */
export function sampleTrailPoints(
  track: AircraftTrack,
  timeSec: number,
  trailLengthSec: number,
  steps: number,
  projector: LocalENUProjector,
  altSmoothSec = 0,
): { x: number; y: number; z: number; altFt: number; timeSec: number; ageRatio: number }[] {
  let activeSeg = null;
  for (let i = 0; i < track.segments.length; i++) {
    const seg = track.segments[i];
    if (timeSec >= seg.startTime && timeSec <= seg.endTime) {
      activeSeg = seg;
      break;
    }
  }
  if (!activeSeg) return [];

  const tStart = Math.max(activeSeg.startTime, timeSec - trailLengthSec);
  const span = timeSec - tStart;
  if (span <= 0.05) return [];

  const count = Math.max(2, steps);
  const out: { x: number; y: number; z: number; altFt: number; timeSec: number; ageRatio: number }[] = [];

  for (let i = 0; i < count; i++) {
    const ratio = i / (count - 1);
    const t = tStart + span * ratio;
    const state = evaluateAircraftAtTime(track, t, projector, 1, altSmoothSec);
    if (state) {
      out.push({
        x: state.x,
        y: state.y,
        z: state.z,
        altFt: state.altFt,
        timeSec: t,
        ageRatio: ratio,
      });
    }
  }
  return out;
}

/**
 * Interpolate camera position, lookAt target, and optional FOV across sorted CameraKeyframes
 * using arc-length-parameterized centripetal `THREE.CatmullRomCurve3` splines (`getPointAt`).
 */
export function evaluateCameraKeyframes(
  keyframes: CameraKeyframe[],
  timeSec: number,
  options?: CameraPathOptions,
): { position: [number, number, number]; target: [number, number, number]; fov?: number } | null {
  return evaluateCinematicCameraPath(keyframes, timeSec, options);
}
