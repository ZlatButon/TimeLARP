/**
 * Pure radial Fog-of-War attenuation & ground city label clearance math.
 */

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Compute smooth radial visibility alpha [0..1] for an object at horizontal ENU position (xKm, zKm)
 * relative to the configurable Radar Range radius (`radarRangeKm`).
 *
 * - Inside `startRatio * radarRangeKm` (default 80% for aircraft/trails, 75% for terrain): returns 1.0
 * - Across `startRatio * radarRangeKm .. radarRangeKm`: smooth cubic Hermite fade 1.0 -> 0.0
 * - At or beyond `radarRangeKm`: returns 0.0
 */
export function computeRadialFadeAlpha(
  xKm: number,
  zKm: number,
  radarRangeKm: number,
  startRatio = 0.8,
): number {
  const range = Math.max(20, radarRangeKm);
  const r = Math.hypot(xKm, zKm);
  const start = range * Math.max(0.1, Math.min(0.98, startRatio));
  if (r <= start) return 1;
  if (r >= range) return 0;
  return 1 - smoothstep(start, range, r);
}

/**
 * Keep flat ground city labels (such as "NIZHNY NOVGOROD") clear of the central airport / active runway
 * footprint so runway graphics and departing traffic never collide with background city typography.
 */
export function shiftCityLabelAwayFromRunway(
  enuX: number,
  enuZ: number,
  minClearanceKm = 19,
): { x: number; z: number; shifted: boolean } {
  const dist = Math.hypot(enuX, enuZ);
  if (dist >= minClearanceKm) {
    return { x: enuX, z: enuZ, shifted: false };
  }
  const targetDist = minClearanceKm + 4;
  if (dist < 0.5) {
    // Directly on airport center: shift northeast (positive X, negative Z in Three.js ENU)
    return {
      x: targetDist * 0.72,
      z: -targetDist * 0.69,
      shifted: true,
    };
  }
  const scale = targetDist / dist;
  return {
    x: enuX * scale,
    z: enuZ * scale,
    shifted: true,
  };
}
