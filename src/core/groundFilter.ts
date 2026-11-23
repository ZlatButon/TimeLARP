import type { AircraftTrack } from '../types/radar';

/**
 * Determine if an aircraft sample is on the ground (parked at gate or taxiing).
 * Uses both ground speed (< 100 kt) and altitude proximity to airport elevation
 * so airborne low-speed approaches or high-altitude slow aircraft are never hidden prematurely.
 */
export function isAircraftOnGround(
  altFt: number,
  gsKt: number,
  airportElevationFt = 256,
): boolean {
  const aglFt = altFt - airportElevationFt;
  return gsKt < 100 && aglFt <= 480;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-5, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Compute smooth visibility alpha [0..1] for an aircraft when `hideGroundTraffic` is active:
 * - Parked/taxiing (GS < 82 kt & low AGL) -> 0.0 (completely hidden)
 * - Takeoff roll & initial liftoff (GS 82 -> 125 kt or AGL 80 -> 380 ft) -> smooth fade-in 0 -> 1
 * - Touchdown rollout -> lingers smoothly for ~5s after dropping below 100 kt, then fades out to 0
 */
export function computeAircraftVisibilityAlpha(
  track: AircraftTrack,
  timeSec: number,
  currentAltFt: number,
  currentGsKt: number,
  airportElevationFt = 256,
  hideGroundTraffic = true,
): number {
  if (!hideGroundTraffic) return 1;

  const aglFt = currentAltFt - airportElevationFt;
  // Clearly airborne well above ground -> always fully visible
  if (aglFt > 520 || currentGsKt >= 122) {
    return 1;
  }

  // Smooth kinematic ramp during takeoff roll / flare (GS 82..122 kt or AGL 120..480 ft)
  const speedAlpha = smoothstep(82, 122, currentGsKt);
  const altAlpha = smoothstep(140, 480, aglFt);
  const instantAlpha = Math.max(speedAlpha, altAlpha);

  if (instantAlpha >= 0.99) return 1;

  // Check if aircraft JUST landed (was airborne within the last 6 seconds) for smooth post-landing fade-out
  let activeSeg = null;
  for (let i = 0; i < track.segments.length; i++) {
    const seg = track.segments[i];
    if (timeSec >= seg.startTime && timeSec <= seg.endTime) {
      activeSeg = seg;
      break;
    }
  }
  if (!activeSeg) return instantAlpha;

  let lastAirborneTime = -Infinity;
  const samples = activeSeg.samples;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.timeSec >= timeSec) continue;
    if (timeSec - s.timeSec > 10) break;
    const sAgl = s.altFt - airportElevationFt;
    if (sAgl > 520 || s.gsKt >= 122) {
      lastAirborneTime = s.timeSec;
      break;
    }
  }

  if (lastAirborneTime > -Infinity) {
    const secSinceAirborne = timeSec - lastAirborneTime;
    // Smooth 6-second fade-out after touchdown rollout slows below 100 kt
    const landingTailAlpha = 1 - smoothstep(0.5, 6.5, secSinceAirborne);
    return Math.max(instantAlpha, landingTailAlpha);
  }

  return instantAlpha;
}
