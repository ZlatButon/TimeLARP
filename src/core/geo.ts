import type { ENUPoint, GeoPoint } from '../types/radar';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
/** Mean WGS84 Earth radius in kilometers */
const EARTH_RADIUS_KM = 6371.0088;
/** Feet to kilometers conversion factor */
export const FT_TO_KM = 0.0003048;

/**
 * Local tangent-plane (ENU) projection centered at a reference airport/sector origin.
 *
 * Coordinate convention mapped to Three.js right-handed space:
 *   +X = East  (km)
 *   +Y = Up    (km, altitude * FT_TO_KM * verticalExaggeration)
 *   +Z = South (km, so -Z = North, matching map-up orientation when looking from +Y/+Z)
 */
export class LocalENUProjector {
  public readonly originLat: number;
  public readonly originLon: number;
  private readonly cosOriginLat: number;

  constructor(origin: GeoPoint) {
    this.originLat = origin.lat;
    this.originLon = origin.lon;
    this.cosOriginLat = Math.cos(origin.lat * DEG_TO_RAD);
  }

  /**
   * Convert WGS84 Lat/Lon and altitude (feet) into un-exaggerated ENU kilometers.
   */
  public toENU(lat: number, lon: number, altFt = 0): ENUPoint {
    const dLatRad = (lat - this.originLat) * DEG_TO_RAD;
    const dLonRad = (lon - this.originLon) * DEG_TO_RAD;

    const eastKm = dLonRad * EARTH_RADIUS_KM * this.cosOriginLat;
    const northKm = dLatRad * EARTH_RADIUS_KM;
    const upKm = altFt * FT_TO_KM;

    return {
      x: eastKm,
      y: upKm,
      z: northKm === 0 ? 0 : -northKm,
    };
  }

  /**
   * Convert altitude in feet to scene Y units given a vertical exaggeration multiplier.
   */
  public static altFtToSceneY(altFt: number, verticalExaggeration: number): number {
    return altFt * FT_TO_KM * verticalExaggeration;
  }

  /**
   * Inverse projection: ENU kilometers back to WGS84 Lat/Lon.
   */
  public toGeo(xKm: number, zKm: number): GeoPoint {
    const northKm = -zKm;
    const lat = this.originLat + (northKm / EARTH_RADIUS_KM) * RAD_TO_DEG;
    const lon =
      this.originLon +
      (xKm / (EARTH_RADIUS_KM * Math.max(0.0001, this.cosOriginLat))) * RAD_TO_DEG;
    return { lat, lon };
  }

  /**
   * Great-circle initial bearing in degrees [0, 360) from point A to point B in local ENU.
   */
  public static headingFromDeltaXZ(dxEast: number, dzSouth: number): number {
    const north = -dzSouth;
    const rad = Math.atan2(dxEast, north);
    return ((rad * RAD_TO_DEG) % 360 + 360) % 360;
  }

  /**
   * Approximate horizontal distance in kilometers between two geo coordinates.
   */
  public static distanceKm(a: GeoPoint, b: GeoPoint): number {
    const dLat = (b.lat - a.lat) * DEG_TO_RAD;
    const dLon = (b.lon - a.lon) * DEG_TO_RAD;
    const meanLat = ((a.lat + b.lat) * 0.5) * DEG_TO_RAD;
    const x = dLon * Math.cos(meanLat);
    return Math.hypot(x, dLat) * EARTH_RADIUS_KM;
  }
}

/**
 * Format seconds-since-midnight into HH:MM:SS UTC string.
 */
export function formatUtcTime(seconds: number): string {
  const wrapped = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  const s = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Format seconds-since-midnight into calm HH:MM UTC string (no flickering seconds for timelapses).
 */
export function formatUtcTimeHm(seconds: number): string {
  const wrapped = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Format altitude in feet to ATC flight level / altitude string (e.g. F066, F360, A025).
 */
export function formatFlightLevel(altFt: number, transitionAltFt = 5000): string {
  if (altFt >= transitionAltFt) {
    const fl = Math.round(altFt / 100);
    return `F${String(Math.max(0, fl)).padStart(3, '0')}`;
  }
  const hundreds = Math.round(altFt / 100);
  return `A${String(Math.max(0, hundreds)).padStart(3, '0')}`;
}
