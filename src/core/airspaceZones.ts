import type {
  AirspaceKind,
  AirspaceVolume,
  BaseMapData,
  ControllerEvent,
  GeoMapLabel,
  GeoMapPolygon,
  GeoMapPolyline,
  GeoPoint,
} from '../types/radar';
import { LocalENUProjector } from './geo';

export interface SectorAssignment {
  sectorId: string;
  sectorCode: string;
  sectorName: string;
  frequency?: string;
  kind: AirspaceKind | 'ENROUTE';
  /** True when ownership came strictly from the radar log rather than geometric polygon check */
  fromLog?: boolean;
}

/**
 * Map a raw VATSIM/EuroScope ATC controller callsign using Russian VATSIM / Moscow FIR hierarchy:
 *  - Level 1 (CTR / TWR):   UWGG_TWR, UWGG_GND, UWGG_DEL (Вышка / Руление)
 *  - Level 2 (TMA / RADAR): UWGG_R_APP, UWGG_F_APP, *_R_APP, *_DEP, *RADAR* (Нижний круг — ниже Подхода)
 *  - Level 3 (APP / APP):   UWGG_APP, *_APP, *_TMA (Нижний подход — выше Круга, перед Контролем)
 *  - Level 4 (FIR / CTR):   UUWV_CTR, UUWV_X_CTR, UUWV_*_CTR, UWWW_CTR, *_CTR, *_FSS (Москва контроль)
 */
export function parseControllerCallsign(rawCallsign: string): {
  sectorCode: string;
  kind: AirspaceKind | 'ENROUTE';
} {
  const upper = rawCallsign.trim().toUpperCase();
  if (!upper) return { sectorCode: 'CTR', kind: 'ENROUTE' };

  if (
    upper.includes('_TWR') ||
    upper.includes('_GND') ||
    upper.includes('_DEL') ||
    upper === 'TWR' ||
    upper === 'GND' ||
    upper === 'DEL' ||
    upper.includes('STRIGINO_CTR')
  ) {
    return { sectorCode: upper.includes('_GND') || upper === 'GND' ? 'GND' : 'TWR', kind: 'CTR' };
  }

  // Circle / Radar (e.g. UWGG_R_APP = Нижний круг) MUST be matched strictly before generic _APP!
  if (
    upper.includes('_R_APP') ||
    upper.includes('_F_APP') ||
    upper.includes('_RADAR') ||
    upper.includes('RADAR') ||
    upper.includes('_DEP') ||
    upper.includes('KRUG') ||
    upper === 'RADAR'
  ) {
    return { sectorCode: 'RADAR', kind: 'TMA' };
  }

  // Approach (e.g. UWGG_APP = Нижний подход)
  if (
    upper.includes('_APP') ||
    upper.includes('_TMA') ||
    upper.includes('PODHOD') ||
    upper === 'APP' ||
    upper === 'TMA'
  ) {
    return { sectorCode: 'APP', kind: 'APP' };
  }

  // Control / FIR (e.g. UUWV_CTR, UUWV_X_CTR, UUWV_G1_CTR, UWWW_CTR = Москва / Самара контроль)
  if (
    upper.includes('_CTR') ||
    upper.includes('_FSS') ||
    upper.includes('_ACC') ||
    upper.startsWith('UUWV') ||
    upper.startsWith('UWWW') ||
    upper.includes('CTR') ||
    upper.includes('FIR')
  ) {
    return { sectorCode: 'CTR', kind: 'FIR' };
  }

  // Default unknown higher-level ATC callsign to Control rather than APP
  return { sectorCode: 'CTR', kind: 'FIR' };
}

/**
 * Ray-casting 2D Point-in-Polygon check in (lon, lat) space.
 * Returns true if the point lies inside the closed polygon ring.
 */
export function pointInPolygon(point: GeoPoint, polygon: GeoPoint[]): boolean {
  const n = polygon.length;
  if (n < 3) return false;

  let inside = false;
  const px = point.lon;
  const py = point.lat;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;

    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Priority order when nested 3D sectors overlap: innermost/lowest control first (TWR -> RADAR -> APP -> CTR) */
const SECTOR_PRIORITY: Record<AirspaceKind, number> = {
  CTR: 1, // TWR / Tower
  TMA: 2, // RADAR / Circle (UWGG_R_APP)
  APP: 3, // APP / Approach (UWGG_APP)
  FIR: 4, // CTR / Control (UUWV_CTR / UUWV_X_CTR)
  RESTRICTED: 99,
};

function isGroundOnlyVolume(vol: AirspaceVolume): boolean {
  const sc = vol.shortCode?.toUpperCase() ?? '';
  if (sc === 'GND' || sc === 'DEL') return true;
  return /(_GND|_DEL|\bGND\b|\bDEL\b|GROUND|DELIVERY)/i.test(vol.name);
}

function isGroundOnlyCode(sectorCode: string | undefined, callsign?: string | null): boolean {
  const sc = sectorCode?.toUpperCase() ?? '';
  if (sc === 'GND' || sc === 'DEL') return true;
  if (callsign && /(_GND|_DEL|\bGND\b|\bDEL\b|GROUND|DELIVERY)/i.test(callsign)) return true;
  return false;
}

/**
 * Determine which ATC control sector geometrically contains an aircraft based on
 * 2D Point-in-Polygon containment AND 3D altitude floor/ceiling bounds.
 * Automatically ignores ground-only volumes (GND / DEL) when the aircraft is airborne.
 */
export function classifyAircraftSector(
  lat: number,
  lon: number,
  altFt: number,
  volumes: AirspaceVolume[],
  excludeKind?: AirspaceKind | 'ENROUTE',
  airportElevationFt = 256,
): SectorAssignment {
  let best: AirspaceVolume | null = null;
  let bestPrio = Infinity;
  const isAirborne = altFt > airportElevationFt + 350;

  const pt: GeoPoint = { lat, lon };
  for (let i = 0; i < volumes.length; i++) {
    const vol = volumes[i];
    if (vol.kind === 'RESTRICTED') continue;
    if (isAirborne && isGroundOnlyVolume(vol)) continue;
    if (excludeKind && vol.kind === excludeKind) continue;
    if (altFt < vol.floorFt - 50 || altFt > vol.ceilingFt + 150) continue;

    const prio = SECTOR_PRIORITY[vol.kind] ?? 10;
    if (prio >= bestPrio) continue;

    if (pointInPolygon(pt, vol.polygon)) {
      best = vol;
      bestPrio = prio;
    }
  }

  if (best) {
    const fallbackCode =
      best.kind === 'CTR'
        ? 'TWR'
        : best.kind === 'TMA'
          ? 'RADAR'
          : best.kind === 'APP'
            ? 'APP'
            : 'CTR';
    return {
      sectorId: best.id,
      sectorCode: best.shortCode ?? fallbackCode,
      sectorName: best.name,
      frequency: best.frequency,
      kind: best.kind,
      fromLog: false,
    };
  }

  return {
    sectorId: 'enroute',
    sectorCode: 'CTR',
    sectorName: 'ENROUTE',
    kind: 'ENROUTE',
    fromLog: false,
  };
}

export interface HysteresisState {
  current: SectorAssignment;
  candidateId: string | null;
  candidateSinceTime: number;
}

/**
 * Resolve active controlling ATC position strictly from log tracking events first.
 * - Airborne aircraft (> 350 ft AGL) can NEVER be assigned to GND/DEL: if a stale log event
 *   still says GND/DEL while airborne, falls back cleanly to the airspace zone the aircraft is inside.
 * - Handles Drop Track (DR) cleanly: when Approach (APP) drops a climbing flight to Control (CTR),
 *   excludes the dropping APP kind from geometric fallback so it transitions straight to CTR.
 * - Handles missed point-to-point $HA handoffs in observer logs: if a flight climbs well above
 *   terminal approach ceilings (FL265+ for APP, FL245+ for RADAR) with no newer log packet,
 *   cleanly hands over to CTR instead of staying stuck on APP.
 * - Uses temporal hysteresis (`hysteresisSec`) for fallback transitions to eliminate boundary flickering.
 */
export function resolveAircraftController(
  controllerEvents: ControllerEvent[] | undefined,
  timeSec: number,
  lat: number,
  lon: number,
  altFt: number,
  volumes: AirspaceVolume[],
  hysteresisMap?: Map<string, HysteresisState>,
  callsign?: string,
  hysteresisSec = 4.5,
  airportElevationFt = 256,
): SectorAssignment {
  let droppedKind: AirspaceKind | 'ENROUTE' | undefined;
  const isAirborne = altFt > airportElevationFt + 350;

  // 1. Strict log-based ownership (chronological scan of controllerEvents)
  if (controllerEvents && controllerEvents.length > 0) {
    let activeIdx = -1;
    for (let i = controllerEvents.length - 1; i >= 0; i--) {
      if (controllerEvents[i].timeSec <= timeSec) {
        activeIdx = i;
        break;
      }
    }
    const activeEv = activeIdx >= 0 ? controllerEvents[activeIdx] : null;

    if (activeEv && activeEv.controllerCallsign) {
      // Airborne aircraft cannot belong to GND / DEL -> fall through to geometric zone classification
      const staleGroundWhileAirborne =
        isAirborne && isGroundOnlyCode(activeEv.sectorCode, activeEv.controllerCallsign);

      // Safety valve for observer logs that missed a point-to-point $HA from APP/RADAR to UUWV_CTR:
      // Above FL265 (APP) or FL245 (RADAR), Moscow Control owns the high-altitude enroute flight.
      const climbedPastTerminal =
        (activeEv.kind === 'APP' && altFt >= 26500) ||
        (activeEv.kind === 'TMA' && altFt >= 24500);

      if (!staleGroundWhileAirborne && !climbedPastTerminal) {
        const upperCtrl = activeEv.controllerCallsign.toUpperCase();
        const matchedVol = volumes.find(
          (v) =>
            v.name.toUpperCase() === upperCtrl ||
            v.shortCode?.toUpperCase() === activeEv.sectorCode.toUpperCase(),
        );
        const assignment: SectorAssignment = {
          sectorId: matchedVol?.id ?? `log-${upperCtrl}`,
          sectorCode: activeEv.sectorCode,
          sectorName: activeEv.controllerCallsign,
          frequency: matchedVol?.frequency,
          kind: activeEv.kind,
          fromLog: true,
        };
        if (hysteresisMap && callsign) {
          hysteresisMap.set(callsign, {
            current: assignment,
            candidateId: null,
            candidateSinceTime: timeSec,
          });
        }
        return assignment;
      }
      if (climbedPastTerminal) {
        // Climbed past terminal ceiling without logged handoff -> promote to Control (CTR / FIR)
        droppedKind = activeEv.kind;
      }
    } else if (activeEv && activeEv.controllerCallsign === null) {
      // Track was explicitly dropped (DR).
      if (activeEv.droppedBy) {
        droppedKind = parseControllerCallsign(activeEv.droppedBy).kind;
      }
      // If APP dropped a climbing aircraft above 9,500 ft -> directly hand off to CTR (FIR)
      if (droppedKind === 'APP' && altFt >= 9500) {
        const ctrVol = volumes.find((v) => v.kind === 'FIR');
        const ctrAssignment: SectorAssignment = {
          sectorId: ctrVol?.id ?? 'enroute',
          sectorCode: 'CTR',
          sectorName: ctrVol?.name ?? 'UUWV_CTR',
          frequency: ctrVol?.frequency,
          kind: 'FIR',
          fromLog: false,
        };
        if (hysteresisMap && callsign) {
          hysteresisMap.set(callsign, {
            current: ctrAssignment,
            candidateId: null,
            candidateSinceTime: timeSec,
          });
        }
        return ctrAssignment;
      }
    }
  }

  // 2. Fallback: geometric containment (never GND/DEL when airborne; excludes dropping kind)
  //    with temporal hysteresis to prevent flashing on boundaries or disconnects
  const rawGeo = classifyAircraftSector(
    lat,
    lon,
    altFt,
    volumes,
    droppedKind,
    airportElevationFt,
  );
  if (!hysteresisMap || !callsign) {
    return rawGeo;
  }

  const prev = hysteresisMap.get(callsign);
  if (!prev || (isAirborne && isGroundOnlyCode(prev.current.sectorCode, prev.current.sectorName))) {
    hysteresisMap.set(callsign, {
      current: rawGeo,
      candidateId: null,
      candidateSinceTime: timeSec,
    });
    return rawGeo;
  }

  // If user scrubbed time backwards or jumped far (> 25s), snap immediately
  if (Math.abs(timeSec - prev.candidateSinceTime) > 25 && prev.candidateId !== null) {
    prev.current = rawGeo;
    prev.candidateId = null;
    prev.candidateSinceTime = timeSec;
    return rawGeo;
  }

  if (rawGeo.sectorId === prev.current.sectorId) {
    prev.candidateId = null;
    return prev.current;
  }

  if (prev.candidateId !== rawGeo.sectorId) {
    prev.candidateId = rawGeo.sectorId;
    prev.candidateSinceTime = timeSec;
    return prev.current;
  }

  if (Math.abs(timeSec - prev.candidateSinceTime) >= hysteresisSec) {
    prev.current = rawGeo;
    prev.candidateId = null;
    return rawGeo;
  }

  return prev.current;
}

/**
 * Return target RGB hex color for an aircraft based on Russian VATSIM ATC hierarchy:
 * - CTR / TWR   (Вышка, UWGG_TWR):            #fde68a — warm champagne gold
 * - TMA / RADAR (Нижний круг, UWGG_R_APP):    #f59e0b — rich amber-orange
 * - APP / APP   (Нижний подход, UWGG_APP):    #38bdf8 — vivid electric cyan-sky
 * - FIR / CTR   (Москва контроль, UUWV_CTR):  #818cf8 — distinct cool indigo-cobalt
 */
export function getSectorControlColorHex(
  kind: AirspaceKind | 'ENROUTE',
  isDark: boolean,
): number {
  if (isDark) {
    switch (kind) {
      case 'CTR':
        return 0xfde68a; // Вышка (UWGG_TWR) — warm champagne gold
      case 'TMA':
        return 0xf59e0b; // Нижний круг (UWGG_R_APP) — rich amber-orange
      case 'APP':
        return 0x38bdf8; // Нижний подход (UWGG_APP) — vivid cyan-sky
      case 'FIR':
      case 'ENROUTE':
      default:
        return 0x818cf8; // Москва контроль (UUWV_CTR / UUWV_X_CTR) — distinct cool indigo-cobalt
    }
  }
  switch (kind) {
    case 'CTR':
      return 0xd97706;
    case 'TMA':
      return 0xea580c;
    case 'APP':
      return 0x0284c7;
    case 'FIR':
    case 'ENROUTE':
    default:
      return 0x4338ca;
  }
}

function decimateGeoPoints(pts: GeoPoint[], maxPts: number, closed: boolean): GeoPoint[] {
  if (pts.length <= maxPts) return pts;
  const step = Math.max(1, Math.floor(pts.length / maxPts));
  const out: GeoPoint[] = [];
  for (let i = 0; i < pts.length; i += step) {
    out.push(pts[i]);
  }
  if (closed && out.length >= 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.lat - last.lat, first.lon - last.lon) > 1e-4) {
      out.push({ ...first });
    }
  } else if (!closed && out[out.length - 1] !== pts[pts.length - 1]) {
    out.push(pts[pts.length - 1]);
  }
  return out;
}

/**
 * Check whether a ring/polyline overlaps the scene radius (either has a vertex within radius,
 * its bounding box overlaps the center radius, or it encloses the center point!).
 */
function ringIntersectsScene(
  pts: GeoPoint[],
  center: GeoPoint,
  maxRadiusKm: number,
  isPolygon: boolean,
): boolean {
  if (pts.length === 0) return false;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (LocalENUProjector.distanceKm(center, p) <= maxRadiusKm) {
      return true;
    }
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const dLat = maxRadiusKm / 111.32;
  const dLon = maxRadiusKm / (111.32 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  const bboxOverlaps =
    maxLat >= center.lat - dLat &&
    minLat <= center.lat + dLat &&
    maxLon >= center.lon - dLon &&
    minLon <= center.lon + dLon;

  if (!bboxOverlaps) return false;
  if (isPolygon && pts.length >= 3 && pointInPolygon(center, pts)) return true;
  return bboxOverlaps;
}

/**
 * Parse a GeoJSON FeatureCollection / Feature / Geometry JSON string into BaseMapData:
 * - Supports Polygon & MultiPolygon WITH holes (e.g. islands inside lakes / inland seas)
 * - Supports LineString & MultiLineString (rivers, coastlines, borders)
 * - Supports Point & MultiPoint (cities/towns -> flat dark ground labels)
 * - Strictly reads GeoJSON RFC 7946 [lon, lat] coordinates and filters/clips to scene radius
 */
export function parseGeoJsonBaseMap(
  rawJson: string,
  name = 'Custom GeoJSON Map',
  center: GeoPoint = { lat: 56.23, lon: 43.78417 },
  maxRadiusKm = 480,
): BaseMapData {
  const parsed = JSON.parse(rawJson) as {
    type?: string;
    features?: Array<{
      properties?: Record<string, unknown>;
      geometry?: { type: string; coordinates: unknown; geometries?: Array<{ type: string; coordinates: unknown }> };
    }>;
    geometry?: { type: string; coordinates: unknown };
    coordinates?: unknown;
  };

  type RawFeature = {
    properties?: Record<string, unknown>;
    geometry?: { type: string; coordinates: unknown; geometries?: Array<{ type: string; coordinates: unknown }> };
  };

  let features: RawFeature[] = [];
  if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
    features = parsed.features;
  } else if (parsed.type === 'Feature' && parsed.geometry) {
    features = [{ properties: {}, geometry: parsed.geometry }];
  } else if (parsed.type && parsed.coordinates) {
    features = [{ properties: {}, geometry: { type: parsed.type, coordinates: parsed.coordinates } }];
  }

  const polygons: GeoMapPolygon[] = [];
  const polylines: GeoMapPolyline[] = [];
  const labels: GeoMapLabel[] = [];
  const seenLabels = new Set<string>();

  const parseCoords = (coords: unknown): GeoPoint[] => {
    if (!Array.isArray(coords)) return [];
    const pts: GeoPoint[] = [];
    for (const pair of coords) {
      if (Array.isArray(pair) && pair.length >= 2) {
        const lon = Number(pair[0]);
        const lat = Number(pair[1]);
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lon) <= 180
        ) {
          pts.push({ lat, lon });
        }
      }
    }
    return pts;
  };

  let idx = 0;

  const processGeometry = (
    geom: { type: string; coordinates?: unknown; geometries?: Array<{ type: string; coordinates: unknown }> },
    props: Record<string, unknown>,
  ) => {
    if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      for (const child of geom.geometries) {
        processGeometry(child, props);
      }
      return;
    }

    const combinedTags = [
      props.natural,
      props.waterway,
      props.water,
      props.landuse,
      props.type,
      props.kind,
      props.fclass,
      props.featurecla,
      props.class,
    ]
      .filter((v) => v !== undefined && v !== null)
      .map((v) => String(v).toLowerCase())
      .join(' ');

    const isWater =
      combinedTags.includes('water') ||
      combinedTags.includes('river') ||
      combinedTags.includes('lake') ||
      combinedTags.includes('reservoir') ||
      combinedTags.includes('sea') ||
      combinedTags.includes('ocean') ||
      combinedTags.includes('bay') ||
      combinedTags.includes('canal');

    const isCoastline = combinedTags.includes('coast');

    const handlePolygonRings = (ringsUnknown: unknown) => {
      if (!Array.isArray(ringsUnknown) || ringsUnknown.length === 0) return;
      const rawOuter = parseCoords(ringsUnknown[0]);
      if (rawOuter.length < 3 || !ringIntersectsScene(rawOuter, center, maxRadiusKm, true)) return;

      const outer = decimateGeoPoints(rawOuter, 180, true);
      const holes: GeoPoint[][] = [];
      for (let r = 1; r < ringsUnknown.length; r++) {
        const rawHole = parseCoords(ringsUnknown[r]);
        if (rawHole.length >= 3) {
          holes.push(decimateGeoPoints(rawHole, 90, true));
        }
      }

      polygons.push({
        id: `gj-poly-${idx++}`,
        kind: isWater ? 'WATER' : 'LAND',
        points: outer,
        holes: holes.length > 0 ? holes : undefined,
      });
      polylines.push({
        id: `gj-shore-${idx++}`,
        kind: isWater ? 'RIVER' : 'COASTLINE',
        points: outer,
      });
      for (const h of holes) {
        polylines.push({
          id: `gj-hole-${idx++}`,
          kind: 'COASTLINE',
          points: h,
        });
      }
    };

    const handleLine = (lineUnknown: unknown) => {
      const rawLine = parseCoords(lineUnknown);
      if (rawLine.length < 2 || !ringIntersectsScene(rawLine, center, maxRadiusKm, false)) return;
      const line = decimateGeoPoints(rawLine, 160, false);
      polylines.push({
        id: `gj-line-${idx++}`,
        kind: isWater && !isCoastline ? 'RIVER' : 'COASTLINE',
        points: line,
      });
    };

    const handlePoint = (ptUnknown: unknown) => {
      if (!Array.isArray(ptUnknown) || ptUnknown.length < 2) return;
      const lon = Number(ptUnknown[0]);
      const lat = Number(ptUnknown[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return;
      }
      if (LocalENUProjector.distanceKm(center, { lat, lon }) > maxRadiusKm * 0.75) return;
      const rawName = String(
        props['name:en'] ?? props.name ?? props.NAME ?? props.city ?? props.label ?? '',
      ).trim();
      if (!rawName) return;
      const text = rawName.toUpperCase();
      if (seenLabels.has(text) || labels.length >= 28) return;
      seenLabels.add(text);
      labels.push({
        id: `gj-pt-${idx++}`,
        text,
        position: { lat, lon },
        kind: isWater ? 'WATER' : 'CITY',
      });
    };

    if (geom.type === 'Polygon') {
      handlePolygonRings(geom.coordinates);
    } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
      for (const poly of geom.coordinates as unknown[]) {
        handlePolygonRings(poly);
      }
    } else if (geom.type === 'LineString') {
      handleLine(geom.coordinates);
    } else if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) {
      for (const seg of geom.coordinates as unknown[]) {
        handleLine(seg);
      }
    } else if (geom.type === 'Point') {
      handlePoint(geom.coordinates);
    } else if (geom.type === 'MultiPoint' && Array.isArray(geom.coordinates)) {
      for (const pt of geom.coordinates as unknown[]) {
        handlePoint(pt);
      }
    }
  };

  for (const feat of features) {
    if (!feat.geometry) continue;
    processGeometry(feat.geometry, feat.properties ?? {});
  }

  const hasLandPolys = polygons.some((p) => p.kind === 'LAND');
  return {
    name,
    waterBase: hasLandPolys,
    polygons,
    polylines,
    labels,
  };
}
