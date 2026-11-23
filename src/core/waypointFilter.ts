import type { GeoPoint, SecondaryAirportsMode, Waypoint } from '../types/radar';
import { LocalENUProjector } from './geo';

export type WaypointCategory =
  | 'primary_airport'
  | 'secondary_airport'
  | 'approach_fix'
  | 'enroute_fix';

/** Camera distance (km) beyond which technical approach/runway fixes auto-hide via Zoom LOD */
export const APPROACH_FIX_LOD_MAX_CAMERA_DIST_KM = 125;

const TECHNICAL_APPROACH_PATTERN =
  /(?:\d|(?:^|_|-)(?:THR|LOC|FAF|IAF|LOM|LMM|OM|MM|IM|RW|RWY|ILS|FN|CI|CD|CF|FD|FI|FF|MA|MD|DME)|(?:THR|LOC|FAF|IAF|LOM|LMM|ILS)$)/i;

/**
 * Classify a navigation waypoint / airport from a EuroScope `.sct` file into clean visual tiers:
 * - `primary_airport`: Target airport (e.g. UWGG)
 * - `secondary_airport`: Neighboring airfields (e.g. XUDK, UWGI, XUDS, UWGO, UUBI)
 * - `approach_fix`: Technical runway/localizer/threshold/DME/terminal fixes (e.g. GG039, FN18L, 22LOC, NG17THR, D123K)
 * - `enroute_fix`: Major 5-letter enroute/STAR/SID fixes, VORs, and NDBs (e.g. USTOK, LARNO, GILAM, PESAB)
 */
export function classifyWaypoint(
  wp: Waypoint,
  targetAirportCode: string,
  airportCenter: GeoPoint,
): WaypointCategory {
  const idUpper = wp.id.trim().toUpperCase();
  const targetUpper = targetAirportCode.trim().toUpperCase();

  if (wp.kind === 'AIRPORT' || (targetUpper.length > 0 && idUpper === targetUpper)) {
    return idUpper === targetUpper ? 'primary_airport' : 'secondary_airport';
  }

  // Any fix containing digits or technical approach/runway abbreviations is an approach/terminal fix
  if (TECHNICAL_APPROACH_PATTERN.test(idUpper)) {
    return 'approach_fix';
  }

  // Short 2-3 letter non-VOR/NDB fixes close to the airfield (markers / localizer points)
  const distKm = LocalENUProjector.distanceKm(airportCenter, { lat: wp.lat, lon: wp.lon });
  if (wp.kind === 'FIX' && (distKm < 14 || (idUpper.length <= 3 && distKm < 28))) {
    return 'approach_fix';
  }

  return 'enroute_fix';
}

export interface WaypointVisibilityOptions {
  showWaypoints: boolean;
  showEnrouteFixes: boolean;
  showApproachFixes: boolean;
  secondaryAirportsMode: SecondaryAirportsMode;
  waypointOverrides: Record<string, boolean>;
  targetAirportCode: string;
  airportCenter: GeoPoint;
  cameraDistanceKm: number;
  radarRangeKm: number;
}

/**
 * Determine whether a given waypoint (both 3D star marker and WebGL label) should be visible
 * after applying manual per-point overrides, category toggles, secondary airport mode,
 * automatic Zoom LOD for technical approach fixes, and Radar Range bounds.
 */
export function shouldShowWaypoint(
  wp: Waypoint,
  opts: WaypointVisibilityOptions,
): { visible: boolean; category: WaypointCategory; dimmed: boolean } {
  const category = classifyWaypoint(wp, opts.targetAirportCode, opts.airportCenter);

  if (!opts.showWaypoints) {
    return { visible: false, category, dimmed: false };
  }

  const distKm = LocalENUProjector.distanceKm(opts.airportCenter, { lat: wp.lat, lon: wp.lon });
  if (distKm > opts.radarRangeKm) {
    return { visible: false, category, dimmed: false };
  }

  // Explicit per-waypoint override always wins inside Radar Range
  const override = opts.waypointOverrides[wp.id];
  if (override !== undefined) {
    const dimmed =
      category === 'secondary_airport' && opts.secondaryAirportsMode === 'dimmed';
    return { visible: override, category, dimmed };
  }

  if (category === 'primary_airport') {
    return { visible: true, category, dimmed: false };
  }

  if (category === 'secondary_airport') {
    if (opts.secondaryAirportsMode === 'hidden') {
      return { visible: false, category, dimmed: false };
    }
    return {
      visible: true,
      category,
      dimmed: opts.secondaryAirportsMode === 'dimmed',
    };
  }

  if (category === 'approach_fix') {
    if (!opts.showApproachFixes) {
      return { visible: false, category, dimmed: false };
    }
    // Automatic Zoom LOD: hide technical approach fixes when camera is zoomed out
    if (opts.cameraDistanceKm > APPROACH_FIX_LOD_MAX_CAMERA_DIST_KM) {
      return { visible: false, category, dimmed: false };
    }
    return { visible: true, category, dimmed: true };
  }

  // Enroute / STAR / SID major fixes
  return { visible: opts.showEnrouteFixes, category, dimmed: false };
}
