import * as THREE from 'three';
import type {
  CameraAutoPresetId,
  CameraEasingMode,
  CameraKeyframe,
} from '../types/radar';

const FULL_FRAME_SENSOR_HEIGHT_MM = 24;

/**
 * Convert a 35mm full-frame focal length (24mm..85mm) to vertical camera FOV in degrees.
 * 24mm => ~53.1°, 35mm => ~37.8°, 42mm => ~31.9°, 50mm => ~27.0°, 85mm => ~16.1°.
 */
export function focalLengthMmToFovDeg(focalLengthMm: number): number {
  const f = Math.max(18, Math.min(120, focalLengthMm));
  const rad = 2 * Math.atan(FULL_FRAME_SENSOR_HEIGHT_MM / (2 * f));
  return (rad * 180) / Math.PI;
}

/**
 * Convert vertical FOV (degrees) back to approximate 35mm full-frame focal length (mm).
 */
export function fovDegToFocalLengthMm(fovDeg: number): number {
  const clamped = Math.max(10, Math.min(90, fovDeg));
  const halfRad = (clamped * Math.PI) / 360;
  return FULL_FRAME_SENSOR_HEIGHT_MM / (2 * Math.tan(halfRad));
}

/**
 * Apply velocity easing profile to normalized timeline progress u in [0, 1].
 */
export function applyCameraEasing(u: number, mode: CameraEasingMode): number {
  const t = Math.max(0, Math.min(1, u));
  switch (mode) {
    case 'linear':
      return t;
    case 'ease-in':
      return t * t * t;
    case 'ease-out': {
      const inv = 1 - t;
      return 1 - inv * inv * inv;
    }
    case 'smooth-s':
    default:
      // C2 quintic smootherstep (zero velocity and zero acceleration jerk at endpoints)
      return t * t * t * (t * (t * 6 - 15) + 10);
  }
}

export interface EvaluatedCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

export interface CameraPathOptions {
  easing?: CameraEasingMode;
  /** 0 = relaxed wide sweep, 0.5 = pure centripetal Catmull-Rom, 1.0 = taut near-linear */
  tension?: number;
  defaultFovDeg?: number;
}

/**
 * Evaluate a polyline by uniform arc-length fraction `u` in [0, 1].
 */
function samplePolylineArcLength(points: THREE.Vector3[], u: number): THREE.Vector3 {
  if (points.length === 0) return new THREE.Vector3();
  if (points.length === 1 || u <= 0) return points[0].clone();
  if (u >= 1) return points[points.length - 1].clone();

  const cumLen: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += points[i].distanceTo(points[i - 1]);
    cumLen.push(total);
  }
  if (total <= 1e-6) return points[0].clone();

  const targetDist = u * total;
  for (let i = 1; i < points.length; i++) {
    if (cumLen[i] >= targetDist) {
      const segLen = Math.max(1e-6, cumLen[i] - cumLen[i - 1]);
      const localU = (targetDist - cumLen[i - 1]) / segLen;
      return points[i - 1].clone().lerp(points[i], localU);
    }
  }
  return points[points.length - 1].clone();
}

/**
 * Evaluate a single point on an arc-length-parameterized `THREE.CatmullRomCurve3`
 * (`centripetal` core) modulated smoothly by `tension` in [0, 1].
 */
function evaluateTensionedCentripetalCurve(
  points: THREE.Vector3[],
  u: number,
  tension: number,
): THREE.Vector3 {
  if (points.length === 0) return new THREE.Vector3();
  if (points.length === 1) return points[0].clone();
  if (points.length === 2) {
    return points[0].clone().lerp(points[1], Math.max(0, Math.min(1, u)));
  }

  const clampedU = Math.max(0, Math.min(1, u));
  const clampedTension = Math.max(0, Math.min(1, tension));

  const centripetal = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const pCentripetal = centripetal.getPointAt(clampedU);

  if (Math.abs(clampedTension - 0.5) < 0.01) {
    return pCentripetal;
  }

  if (clampedTension > 0.5) {
    // Tighten smoothly toward uniform arc-length chord without corner velocity jumps
    const tautBlend = ((clampedTension - 0.5) / 0.5) * 0.88;
    const pLinear = samplePolylineArcLength(points, clampedU);
    return pCentripetal.lerp(pLinear, tautBlend);
  }

  // Relax below 0.5: smoothly blend centripetal with looser catmullrom curve
  const looseRatio = (0.5 - clampedTension) / 0.5;
  const looseCurve = new THREE.CatmullRomCurve3(
    points,
    false,
    'catmullrom',
    0.5 + looseRatio * 0.45,
  );
  const pLoose = looseCurve.getPointAt(clampedU);
  return pCentripetal.lerp(pLoose, looseRatio * 0.75);
}

/**
 * Evaluate cinematic camera position, lookAt target, and optional FOV at `timeSec`
 * using separate `THREE.CatmullRomCurve3` (`centripetal`) splines with uniform arc-length
 * parameterization (`getPointAt`) and configurable velocity easing.
 */
export function evaluateCinematicCameraPath(
  keyframes: CameraKeyframe[],
  timeSec: number,
  options: CameraPathOptions = {},
): EvaluatedCameraPose | null {
  if (keyframes.length === 0) return null;

  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (sorted.length === 1 || timeSec <= first.timeSec) {
    return {
      position: [...first.position],
      target: [...first.target],
      fov: first.fov ?? options.defaultFovDeg,
    };
  }
  if (timeSec >= last.timeSec) {
    return {
      position: [...last.position],
      target: [...last.target],
      fov: last.fov ?? options.defaultFovDeg,
    };
  }

  const easing = options.easing ?? 'smooth-s';
  const tension = options.tension ?? 0.5;
  const span = Math.max(1e-4, last.timeSec - first.timeSec);
  const rawGlobalU = Math.max(0, Math.min(1, (timeSec - first.timeSec) / span));
  const easedU = applyCameraEasing(rawGlobalU, easing);

  const posPts = sorted.map((k) => new THREE.Vector3(...k.position));
  const tgtPts = sorted.map((k) => new THREE.Vector3(...k.target));

  const pos = evaluateTensionedCentripetalCurve(posPts, easedU, tension);
  const tgt = evaluateTensionedCentripetalCurve(tgtPts, easedU, tension);

  // Smoothly interpolate per-keyframe FOV if any keyframe specifies a custom lens
  let fov = options.defaultFovDeg;
  const hasCustomFov = sorted.some((k) => typeof k.fov === 'number');
  if (hasCustomFov) {
    const fovs = sorted.map((k) => k.fov ?? options.defaultFovDeg ?? 32);
    const scaled = easedU * (fovs.length - 1);
    const idx = Math.min(fovs.length - 2, Math.floor(scaled));
    const localU = scaled - idx;
    fov = fovs[idx] + (fovs[idx + 1] - fovs[idx]) * localU;
  }

  return {
    position: [pos.x, pos.y, pos.z],
    target: [tgt.x, tgt.y, tgt.z],
    fov,
  };
}

/**
 * Sample points along the active camera spline for the editor 3D path preview line.
 */
export function sampleCameraPathPreview(
  keyframes: CameraKeyframe[],
  tension = 0.5,
  segments = 96,
): THREE.Vector3[] {
  if (keyframes.length < 2) return [];
  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);
  const posPts = sorted.map((k) => new THREE.Vector3(...k.position));
  const count = Math.max(8, segments);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    out.push(evaluateTensionedCentripetalCurve(posPts, i / count, tension));
  }
  return out;
}

/**
 * One-click cinematic camera choreography generators.
 */
export function generateAutoCameraPreset(
  presetId: CameraAutoPresetId,
  startTime: number,
  endTime: number,
): CameraKeyframe[] {
  const span = Math.max(60, endTime - startTime);

  if (presetId === 'slow-orbit') {
    // 5-node smooth 140° arc orbiting around airport TMA core at steady cinema elevation
    const radius = 148;
    const height = 104;
    const startAngleDeg = 145;
    const endAngleDeg = 5;
    const nodes = 5;
    const out: CameraKeyframe[] = [];
    for (let i = 0; i < nodes; i++) {
      const frac = i / (nodes - 1);
      const angRad = ((startAngleDeg + (endAngleDeg - startAngleDeg) * frac) * Math.PI) / 180;
      const x = Number((Math.cos(angRad) * radius).toFixed(1));
      const z = Number((Math.sin(angRad) * radius).toFixed(1));
      const y = Number((height + Math.sin(frac * Math.PI) * 14).toFixed(1));
      out.push({
        id: `auto-orbit-${i + 1}`,
        timeSec: startTime + span * frac,
        position: [x, y, z],
        target: [4, 8, -2],
        label: `Orbit ${i + 1}`,
      });
    }
    return out;
  }

  if (presetId === 'runway-glide') {
    // Low dramatic glide along final approach corridor into UWGG, sweeping up and past the runway
    return [
      {
        id: 'auto-glide-1',
        timeSec: startTime,
        position: [-54, 38, 102],
        target: [2, 8, -6],
        label: 'Final Outer',
      },
      {
        id: 'auto-glide-2',
        timeSec: startTime + span * 0.36,
        position: [-16, 26, 48],
        target: [1, 5, -2],
        label: 'Short Final',
      },
      {
        id: 'auto-glide-3',
        timeSec: startTime + span * 0.72,
        position: [26, 36, -18],
        target: [0, 8, 6],
        label: 'Runway Pass',
      },
      {
        id: 'auto-glide-4',
        timeSec: endTime,
        position: [74, 72, -78],
        target: [4, 10, 0],
        label: 'Climbout Pull',
      },
    ];
  }

  // `high-drift`: stately wide panoramic drift across the basin
  return [
    {
      id: 'auto-drift-1',
      timeSec: startTime,
      position: [-92, 162, 118],
      target: [-14, 8, -4],
      label: 'West Drift',
    },
    {
      id: 'auto-drift-2',
      timeSec: startTime + span * 0.34,
      position: [-26, 156, 128],
      target: [0, 9, -6],
      label: 'Basin Center',
    },
    {
      id: 'auto-drift-3',
      timeSec: startTime + span * 0.68,
      position: [44, 152, 116],
      target: [12, 9, -6],
      label: 'East Sector',
    },
    {
      id: 'auto-drift-4',
      timeSec: endTime,
      position: [108, 164, 96],
      target: [20, 8, -4],
      label: 'Wide Finale',
    },
  ];
}
