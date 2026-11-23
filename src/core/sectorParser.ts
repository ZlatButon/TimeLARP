import type {
  AirspaceDataset,
  AirspaceKind,
  AirspaceVolume,
  AirwaySegment,
  BaseMapData,
  GeoPoint,
  RunwayProcedureSummary,
  Waypoint,
} from '../types/radar';
import { LocalENUProjector } from './geo';
import { parseControllerCallsign } from './airspaceZones';

/**
 * Parse EuroScope DMS coordinate format:
 *   e.g. `N056.13.48.000` -> +56.230000
 *        `E043.47.03.000` -> +43.784167
 */
export function parseEuroScopeCoord(token: string): number | null {
  const cleaned = token.trim().toUpperCase();
  const match = cleaned.match(/^([NSEW])(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/);
  if (!match) return null;

  const hemi = match[1];
  const deg = Number(match[2]);
  const min = Number(match[3]);
  const sec = Number(match[4]);
  const frac = match[5] ? Number(`0.${match[5]}`) : 0;

  const decimal = deg + min / 60 + (sec + frac) / 3600;
  return hemi === 'S' || hemi === 'W' ? -decimal : decimal;
}

export interface ParsedAirportEntry {
  code: string;
  lat: number;
  lon: number;
  frequency?: string;
}

export interface ParsedProcedureEntry {
  id: string;
  name: string;
  procedureType: 'SID' | 'STAR';
  airportCode?: string;
  runway: string;
  segments: [GeoPoint, GeoPoint][];
  referencedFixIds: string[];
}

export interface ParsedRunwayEntry {
  id: string;
  name: string;
  rwy1: string;
  rwy2: string;
  p1: GeoPoint;
  p2: GeoPoint;
}

export interface EuroScopeCatalog {
  defaultTitle: string;
  infoAirportCode: string;
  infoCenter: GeoPoint;
  airports: ParsedAirportEntry[];
  volumes: AirspaceVolume[];
  restrictedZones: AirspaceVolume[];
  waypoints: Waypoint[];
  airways: AirwaySegment[];
  runways: ParsedRunwayEntry[];
  procedures: ParsedProcedureEntry[];
}

export interface EuroScopeFilterOptions {
  targetAirportCode: string;
  radiusKm: number;
  enabledVolumeIds: Set<string>;
  customTitle?: string;
  maxWaypoints?: number;
  baseMap?: BaseMapData;
}

/**
 * Deduplicate repeated phrases in messy EuroScope [INFO] titles
 * (e.g. "VATSIM MOSCOW FIR V9.6.5 VATSIM MOSCOW FIR" -> "VATSIM MOSCOW FIR V9.6.5").
 */
export function cleanSectorTitle(rawTitle: string, airportCode: string): string {
  const normalized = rawTitle
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^CUSTOM[\s·-]+/i, '')
    .trim();
  if (!normalized) return `${airportCode} SECTOR`;

  // Remove trailing duplicate prefix repetition
  const words = normalized.split(' ');
  const deduped: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // If the next 2 words already appeared at the start, stop appending trailing repeat
    if (
      i >= 3 &&
      i + 1 < words.length &&
      deduped.length >= 2 &&
      deduped[0].toUpperCase() === w.toUpperCase() &&
      deduped[1].toUpperCase() === words[i + 1].toUpperCase()
    ) {
      break;
    }
    deduped.push(w);
  }
  const clean = deduped.join(' ').trim();
  return clean || `${airportCode} SECTOR`;
}

function classifyVolumeKind(
  name: string,
  ownerCallsign?: string,
  floorFt = 0,
  ceilingFt = 0,
): { kind: AirspaceKind; shortCode: string } {
  const u = name.toUpperCase();
  if (
    u.includes('RESTRICT') ||
    u.includes('DANGER') ||
    u.includes('PROHIB') ||
    /\bUR[PDR]\d*/.test(u)
  ) {
    return { kind: 'RESTRICTED', shortCode: 'RSTR' };
  }

  // If EuroScope .ese explicitly specified an OWNER: ATC callsign, trust it directly!
  if (ownerCallsign && ownerCallsign.trim()) {
    const mapped = parseControllerCallsign(ownerCallsign);
    return {
      kind: mapped.kind === 'ENROUTE' ? 'FIR' : mapped.kind,
      shortCode: mapped.sectorCode,
    };
  }

  if (u.includes('TWR') || u.includes('GND') || u.includes('DEL') || u.includes('STRIGINO_CTR')) {
    return { kind: 'CTR', shortCode: 'TWR' };
  }
  // Circle / Radar (UWGG_R_APP = Нижний круг) MUST be checked BEFORE generic _APP / APP!
  if (
    u.includes('R_APP') ||
    u.includes('F_APP') ||
    u.includes('RADAR') ||
    u.includes('DEP') ||
    u.includes('KRUG')
  ) {
    return { kind: 'TMA', shortCode: 'RADAR' };
  }
  // Approach (UWGG_APP = Нижний подход)
  if (u.includes('_APP') || u.includes('TMA') || u.includes('APP')) {
    return { kind: 'APP', shortCode: 'APP' };
  }
  // Control / FIR (UUWV_CTR, UUWV_X_CTR, UWWW_CTR, G1..G9, MSK, NVP high sectors)
  if (
    u.includes('_CTR') ||
    u.includes('FIR') ||
    u.includes('ACC') ||
    u.includes('UWWW') ||
    u.includes('UUWV') ||
    u.includes('_MSK') ||
    /^G\d+$/.test(u)
  ) {
    return { kind: 'FIR', shortCode: 'CTR' };
  }
  if (u.includes('CTR')) {
    return { kind: 'CTR', shortCode: 'TWR' };
  }
  // Generic high-altitude airspace defaults to Control (CTR / FIR), never APP
  if (ceilingFt >= 25000 || floorFt >= 10000) {
    return { kind: 'FIR', shortCode: 'CTR' };
  }
  return { kind: 'APP', shortCode: 'APP' };
}

function computePolygonCentroid(poly: GeoPoint[]): GeoPoint {
  if (poly.length === 0) return { lat: 0, lon: 0 };
  let sumLat = 0;
  let sumLon = 0;
  for (const p of poly) {
    sumLat += p.lat;
    sumLon += p.lon;
  }
  return { lat: sumLat / poly.length, lon: sumLon / poly.length };
}

function extractRunwayTag(label: string): string {
  const match = label.toUpperCase().match(/\b(0?[1-9]|[12]\d|3[0-6])[LRC]?\b/);
  if (!match) return 'ALL';
  const raw = match[0];
  const digits = raw.replace(/[LRC]$/, '');
  const suffix = raw.slice(digits.length);
  return `${digits.padStart(2, '0')}${suffix}`;
}

/**
 * Stage 1: Inspect raw EuroScope `.sct` and `.ese` files into a complete deduplicated catalog
 * ready for the interactive Import Filter Modal (airport picker, radius, sector checkboxes, runway SID/STARs).
 */
export function inspectEuroScopeFiles(
  sctText: string,
  eseText = '',
  fallbackCenter: GeoPoint = { lat: 56.23, lon: 43.78417 },
): EuroScopeCatalog {
  const airportsMap = new Map<string, ParsedAirportEntry>();
  const waypointsMap = new Map<string, Waypoint>();
  const airways: AirwaySegment[] = [];
  const runways: ParsedRunwayEntry[] = [];
  const proceduresMap = new Map<string, ParsedProcedureEntry>();
  const rawVolumes: AirspaceVolume[] = [];
  const restrictedZones: AirspaceVolume[] = [];

  let infoCenter: GeoPoint = { ...fallbackCenter };
  let infoAirportCode = '';
  let rawInfoName = '';

  const lines = sctText.split(/\r?\n/);
  let section = '';
  let currentRegionName = '';
  let currentRegionPts: GeoPoint[] = [];
  const artccLines = new Map<string, GeoPoint[][]>();

  // State for multi-line [SID] / [STAR] EuroScope blocks
  let activeProcKey = '';

  const flushRegion = () => {
    if (currentRegionPts.length >= 3) {
      const { kind, shortCode } = classifyVolumeKind(currentRegionName);
      const vol: AirspaceVolume = {
        id: `reg-${rawVolumes.length + restrictedZones.length}`,
        name: currentRegionName || 'SECTOR',
        shortCode,
        kind,
        floorFt: 0,
        ceilingFt: kind === 'CTR' ? 5000 : kind === 'TMA' ? 11000 : kind === 'APP' ? 19000 : 33000,
        polygon: currentRegionPts,
      };
      if (kind === 'RESTRICTED') restrictedZones.push(vol);
      else rawVolumes.push(vol);
    }
    currentRegionPts = [];
  };

  const resolveEndpoint = (tokenLat: string, tokenLon?: string): { pt: GeoPoint; fixId?: string } | null => {
    const lat = parseEuroScopeCoord(tokenLat);
    if (lat !== null && tokenLon) {
      const lon = parseEuroScopeCoord(tokenLon);
      if (lon !== null) return { pt: { lat, lon } };
    }
    const cleanId = tokenLat.toUpperCase();
    const wp = waypointsMap.get(cleanId);
    if (wp) return { pt: { lat: wp.lat, lon: wp.lon }, fixId: wp.id };
    return null;
  };

  for (const rawLine of lines) {
    const noComment = rawLine.split(';')[0];
    const isIndented = /^\s+/.test(noComment);
    const line = noComment.trim();
    if (!line) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      if (section === 'REGIONS') flushRegion();
      section = line.slice(1, -1).trim().toUpperCase();
      activeProcKey = '';
      continue;
    }

    if (section === 'INFO') {
      const parts = line.split(/\s+/);
      const maybeLat = parts.length >= 2 ? parseEuroScopeCoord(parts[0]) : null;
      const maybeLon = parts.length >= 2 ? parseEuroScopeCoord(parts[1]) : null;
      if (maybeLat !== null && maybeLon !== null) {
        infoCenter = { lat: maybeLat, lon: maybeLon };
      } else if (parts.length === 1 && /^[A-Z]{4}$/.test(parts[0]) && !infoAirportCode) {
        infoAirportCode = parts[0];
      } else if (!rawInfoName && line.length > 2) {
        rawInfoName = line;
      }
      continue;
    }

    if (section === 'AIRPORT') {
      const tokens = line.split(/\s+/);
      const code = tokens[0]?.toUpperCase();
      let lat: number | null = null;
      let lon: number | null = null;
      let freq: string | undefined;
      for (let i = 1; i < tokens.length; i++) {
        if (/^1\d{2}\.\d{2,3}$/.test(tokens[i])) freq = tokens[i];
        if (i < tokens.length - 1 && lat === null) {
          const a = parseEuroScopeCoord(tokens[i]);
          const b = parseEuroScopeCoord(tokens[i + 1]);
          if (a !== null && b !== null) {
            lat = a;
            lon = b;
          }
        }
      }
      if (code && /^[A-Z0-9]{3,4}$/.test(code) && lat !== null && lon !== null) {
        if (!airportsMap.has(code)) {
          airportsMap.set(code, { code, lat, lon, frequency: freq });
        }
        waypointsMap.set(code, { id: code, lat, lon, kind: 'AIRPORT' });
      }
      continue;
    }

    if (section === 'RUNWAY') {
      // EuroScope format: RWY1 RWY2 HDG1 HDG2 LAT1 LON1 LAT2 LON2 [AIRPORT]
      const tokens = line.split(/\s+/);
      const coords: number[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const c = parseEuroScopeCoord(tokens[i]);
        if (c !== null) coords.push(c);
      }
      if (tokens.length >= 8 && coords.length >= 4) {
        const rwy1 = tokens[0].toUpperCase();
        const rwy2 = tokens[1].toUpperCase();
        runways.push({
          id: `rwy-${runways.length}`,
          name: `RWY ${rwy1}/${rwy2}`,
          rwy1,
          rwy2,
          p1: { lat: coords[0], lon: coords[1] },
          p2: { lat: coords[2], lon: coords[3] },
        });
      }
      continue;
    }

    if (section === 'FIXES' || section === 'VOR' || section === 'NDB') {
      const tokens = line.split(/\s+/);
      const id = tokens[0]?.toUpperCase();
      let lat: number | null = null;
      let lon: number | null = null;
      for (let i = 1; i < tokens.length - 1; i++) {
        const a = parseEuroScopeCoord(tokens[i]);
        const b = parseEuroScopeCoord(tokens[i + 1]);
        if (a !== null && b !== null) {
          lat = a;
          lon = b;
          break;
        }
      }
      if (id && lat !== null && lon !== null && !waypointsMap.has(id)) {
        waypointsMap.set(id, {
          id,
          lat,
          lon,
          kind: section === 'FIXES' ? 'FIX' : (section as Waypoint['kind']),
        });
      }
      continue;
    }

    if (section === 'LOW AIRWAY' || section === 'HIGH AIRWAY') {
      const tokens = line.split(/\s+/);
      const airwayName = tokens[0];
      const coords: number[] = [];
      for (let i = 1; i < tokens.length; i++) {
        const c = parseEuroScopeCoord(tokens[i]);
        if (c !== null) coords.push(c);
      }
      let p1: GeoPoint | null = null;
      let p2: GeoPoint | null = null;
      if (coords.length >= 4) {
        p1 = { lat: coords[0], lon: coords[1] };
        p2 = { lat: coords[2], lon: coords[3] };
      } else if (tokens.length >= 3) {
        p1 = resolveEndpoint(tokens[1])?.pt ?? null;
        p2 = resolveEndpoint(tokens[2])?.pt ?? null;
      }
      if (p1 && p2) {
        airways.push({
          id: `aw-${airways.length}`,
          name: airwayName,
          kind: 'AIRWAY',
          points: [p1, p2],
        });
      }
      continue;
    }

    if (section === 'SID' || section === 'STAR') {
      const procType = section as 'SID' | 'STAR';
      const tokens = line.split(/\s+/);
      const coords: number[] = [];
      const firstCoordIdx = tokens.findIndex((t) => parseEuroScopeCoord(t) !== null);
      for (let i = 0; i < tokens.length; i++) {
        const c = parseEuroScopeCoord(tokens[i]);
        if (c !== null) coords.push(c);
      }

      // Header line (not indented, has procedure title before coordinates)
      if (!isIndented && firstCoordIdx > 0) {
        const headerText = tokens.slice(0, firstCoordIdx).join(' ').trim();
        const aptMatch = headerText.toUpperCase().match(/\b([A-Z]{4})\b/);
        const runway = extractRunwayTag(headerText);
        activeProcKey = `${procType}:${headerText}`;
        if (!proceduresMap.has(activeProcKey)) {
          proceduresMap.set(activeProcKey, {
            id: `proc-${proceduresMap.size}`,
            name: headerText,
            procedureType: procType,
            airportCode: aptMatch?.[1],
            runway,
            segments: [],
            referencedFixIds: [],
          });
        }
      } else if (!isIndented && firstCoordIdx === -1 && tokens.length >= 3) {
        // Fix-name based format: PROCNAME FIX1 FIX2
        const headerText = tokens[0];
        const aptMatch = headerText.toUpperCase().match(/\b([A-Z]{4})\b/);
        const runway = extractRunwayTag(headerText);
        activeProcKey = `${procType}:${headerText}`;
        if (!proceduresMap.has(activeProcKey)) {
          proceduresMap.set(activeProcKey, {
            id: `proc-${proceduresMap.size}`,
            name: headerText,
            procedureType: procType,
            airportCode: aptMatch?.[1],
            runway,
            segments: [],
            referencedFixIds: [],
          });
        }
      }

      const proc = proceduresMap.get(activeProcKey);
      if (proc) {
        if (coords.length >= 4) {
          proc.segments.push([
            { lat: coords[0], lon: coords[1] },
            { lat: coords[2], lon: coords[3] },
          ]);
        } else if (tokens.length >= 2) {
          const idxStart = isIndented ? 0 : 1;
          const e1 = resolveEndpoint(tokens[idxStart]);
          const e2 = resolveEndpoint(tokens[idxStart + 1]);
          if (e1 && e2) {
            proc.segments.push([e1.pt, e2.pt]);
            if (e1.fixId) proc.referencedFixIds.push(e1.fixId);
            if (e2.fixId) proc.referencedFixIds.push(e2.fixId);
          }
        }
      }
      continue;
    }

    if (section === 'ARTCC' || section === 'ARTCC LOW' || section === 'ARTCC HIGH') {
      const tokens = line.split(/\s+/);
      const secName = tokens[0];
      const coords: number[] = [];
      for (let i = 1; i < tokens.length; i++) {
        const c = parseEuroScopeCoord(tokens[i]);
        if (c !== null) coords.push(c);
      }
      if (coords.length >= 4) {
        const list = artccLines.get(secName) ?? [];
        list.push([
          { lat: coords[0], lon: coords[1] },
          { lat: coords[2], lon: coords[3] },
        ]);
        artccLines.set(secName, list);
      }
      continue;
    }

    if (section === 'REGIONS') {
      const tokens = line.split(/\s+/);
      const firstCoord = parseEuroScopeCoord(tokens[0]);
      if (firstCoord === null && tokens.length >= 3) {
        flushRegion();
        currentRegionName = tokens[0];
        const lat = parseEuroScopeCoord(tokens[1]);
        const lon = parseEuroScopeCoord(tokens[2]);
        if (lat !== null && lon !== null) currentRegionPts.push({ lat, lon });
      } else if (tokens.length >= 2) {
        const lat = parseEuroScopeCoord(tokens[0]);
        const lon = parseEuroScopeCoord(tokens[1]);
        if (lat !== null && lon !== null) currentRegionPts.push({ lat, lon });
      }
    }
  }
  if (section === 'REGIONS') flushRegion();

  // Stitch ARTCC segments into polygons
  for (const [secName, segs] of artccLines.entries()) {
    if (segs.length < 3) continue;
    const pts: GeoPoint[] = [segs[0][0], segs[0][1]];
    for (let i = 1; i < segs.length; i++) {
      pts.push(segs[i][1]);
    }
    const { kind, shortCode } = classifyVolumeKind(secName);
    rawVolumes.push({
      id: `artcc-${rawVolumes.length}`,
      name: secName,
      shortCode,
      kind,
      floorFt: kind === 'CTR' ? 0 : 1500,
      ceilingFt: kind === 'CTR' ? 5000 : kind === 'TMA' ? 11000 : 27000,
      polygon: pts,
    });
  }

  // Parse .ese [POSITIONS] frequencies & [AIRSPACE] SECTOR:<name>:<floorFt>:<ceilingFt>
  const freqByPrefix = new Map<string, string>();
  if (eseText.trim().length > 0) {
    const eseLines = eseText.split(/\r?\n/);
    let eseSection = '';
    const sectorLinesByName = new Map<string, GeoPoint[]>();
    let curSectorLineName: string | null = null;
    interface PendingEseSector {
      name: string;
      floorFt: number;
      ceilingFt: number;
      owner?: string;
      pts: GeoPoint[];
      borders: string[];
    }
    const pendingEseSectors: PendingEseSector[] = [];
    let curSector: PendingEseSector | null = null;

    const flushEseSector = () => {
      if (curSector) {
        pendingEseSectors.push(curSector);
        curSector = null;
      }
      curSectorLineName = null;
    };

    for (const raw of eseLines) {
      const line = raw.split(';')[0].trim();
      if (!line) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        flushEseSector();
        eseSection = line.slice(1, -1).trim().toUpperCase();
        continue;
      }
      if (eseSection === 'POSITIONS') {
        // Format: UWGG_R_APP:Nizhny Radar:120.300:...
        const parts = line.split(':');
        if (parts.length >= 3 && /^1\d{2}\.\d{2,3}$/.test(parts[2].trim())) {
          freqByPrefix.set(parts[0].trim().toUpperCase(), parts[2].trim());
        }
        continue;
      }
      if (line.startsWith('SECTORLINE:')) {
        flushEseSector();
        const name = line.slice('SECTORLINE:'.length).trim().toUpperCase();
        if (name) {
          curSectorLineName = name;
          if (!sectorLinesByName.has(name)) {
            sectorLinesByName.set(name, []);
          }
        }
      } else if (line.startsWith('SECTOR:')) {
        flushEseSector();
        const parts = line.split(':');
        const rawFloor = Number(parts[2]);
        const rawCeil = Number(parts[3]);
        curSector = {
          name: parts[1]?.trim() || 'SECTOR',
          floorFt: Number.isFinite(rawFloor) ? rawFloor : 0,
          ceilingFt: Number.isFinite(rawCeil) && rawCeil > 0 ? rawCeil : 24500,
          pts: [],
          borders: [],
        };
      } else if (line.startsWith('OWNER:') && curSector && !curSector.owner) {
        const parts = line.split(':');
        const firstOwner = parts.slice(1).find((p) => p.trim().length > 0)?.trim();
        if (firstOwner) curSector.owner = firstOwner;
      } else if (line.startsWith('BORDER:') && curSector) {
        const borderNames = line
          .slice('BORDER:'.length)
          .split(':')
          .map((b) => b.trim().toUpperCase())
          .filter(Boolean);
        curSector.borders.push(...borderNames);
      } else if (line.startsWith('COORD:')) {
        const parts = line.split(':');
        if (parts.length >= 3) {
          const lat = parseEuroScopeCoord(parts[1]);
          const lon = parseEuroScopeCoord(parts[2]);
          if (lat !== null && lon !== null) {
            if (curSector) {
              curSector.pts.push({ lat, lon });
            } else if (curSectorLineName) {
              sectorLinesByName.get(curSectorLineName)?.push({ lat, lon });
            }
          }
        }
      }
    }
    flushEseSector();

    for (const sec of pendingEseSectors) {
      let polygon = sec.pts;
      if (polygon.length < 3 && sec.borders.length > 0) {
        const combined: GeoPoint[] = [];
        for (const bName of sec.borders) {
          const bPts = sectorLinesByName.get(bName);
          if (bPts && bPts.length > 0) {
            combined.push(...bPts);
          }
        }
        polygon = combined;
      }
      if (polygon.length < 3) continue;
      const isGroundOnly =
        /(_GND|_DEL|\bGND\b|\bDEL\b|GROUND|DELIVERY)/i.test(sec.name) ||
        (sec.owner ? /(_GND|_DEL|\bGND\b|\bDEL\b|GROUND|DELIVERY)/i.test(sec.owner) : false);
      const effectiveCeilFt = isGroundOnly ? Math.min(500, sec.ceilingFt) : sec.ceilingFt;
      const { kind, shortCode } = classifyVolumeKind(
        sec.name,
        sec.owner,
        sec.floorFt,
        effectiveCeilFt,
      );
      const upper = sec.name.toUpperCase();
      const ownerUpper = sec.owner?.toUpperCase();
      const freq = freqByPrefix.get(upper) ?? (ownerUpper ? freqByPrefix.get(ownerUpper) : undefined);
      rawVolumes.push({
        id: `ese-${rawVolumes.length}`,
        name: sec.name,
        shortCode,
        frequency: freq,
        kind,
        floorFt: sec.floorFt,
        ceilingFt: effectiveCeilFt,
        polygon,
      });
    }
  }

  // Deduplicate volumes by normalized (name + floor + ceiling) so identical sectors never stack!
  const seenVols = new Set<string>();
  const dedupedVolumes: AirspaceVolume[] = [];
  for (const vol of rawVolumes) {
    const key = `${vol.name.toUpperCase()}|${vol.floorFt}|${vol.ceilingFt}`;
    if (seenVols.has(key)) continue;
    seenVols.add(key);
    if (!vol.frequency) {
      vol.frequency = freqByPrefix.get(vol.name.toUpperCase());
    }
    dedupedVolumes.push(vol);
  }

  // Ensure infoAirportCode is present in airports list
  const airports = Array.from(airportsMap.values()).sort((a, b) => a.code.localeCompare(b.code));
  const resolvedCode = infoAirportCode || airports[0]?.code || 'SECTOR';
  if (airports.length === 0) {
    airports.push({ code: resolvedCode, lat: infoCenter.lat, lon: infoCenter.lon });
  }

  return {
    defaultTitle: cleanSectorTitle(rawInfoName, resolvedCode),
    infoAirportCode: resolvedCode,
    infoCenter,
    airports,
    volumes: dedupedVolumes,
    restrictedZones,
    waypoints: Array.from(waypointsMap.values()),
    airways,
    runways,
    procedures: Array.from(proceduresMap.values()).filter((p) => p.segments.length > 0),
  };
}

/**
 * Compute default recommended sector IDs for a target airport within `radiusKm`
 * (auto-selects local airport sectors & nearby TMA/CTR while leaving unrelated distant FIRs unchecked).
 */
export function selectDefaultVolumesForAirport(
  catalog: EuroScopeCatalog,
  airportCode: string,
  center: GeoPoint,
  radiusKm: number,
): Set<string> {
  const chosen = new Set<string>();
  const upperCode = airportCode.toUpperCase();

  for (const vol of catalog.volumes) {
    const centroid = computePolygonCentroid(vol.polygon);
    const dist = LocalENUProjector.distanceKm(center, centroid);
    const matchesAirport = vol.name.toUpperCase().includes(upperCode);
    const anyPointClose = vol.polygon.some(
      (p) => LocalENUProjector.distanceKm(center, p) <= radiusKm * 0.65,
    );

    if (matchesAirport || (dist <= radiusKm * 0.75 && vol.kind !== 'FIR')) {
      chosen.add(vol.id);
    } else if (chosen.size < 6 && anyPointClose && dist <= radiusKm) {
      chosen.add(vol.id);
    }
  }

  // If nothing matched (e.g. generic small test file), select all volumes within radius
  if (chosen.size === 0) {
    for (const vol of catalog.volumes) {
      if (vol.polygon.some((p) => LocalENUProjector.distanceKm(center, p) <= radiusKm)) {
        chosen.add(vol.id);
      }
    }
  }

  return chosen;
}

/**
 * Stage 2: Build a clean, deduplicated, radius-filtered AirspaceDataset from an inspected EuroScopeCatalog.
 */
export function buildFilteredAirspaceFromCatalog(
  catalog: EuroScopeCatalog,
  options: EuroScopeFilterOptions,
): AirspaceDataset {
  const airport =
    catalog.airports.find((a) => a.code === options.targetAirportCode) ?? catalog.airports[0];
  const center: GeoPoint = airport
    ? { lat: airport.lat, lon: airport.lon }
    : { ...catalog.infoCenter };
  const airportCode = airport?.code ?? catalog.infoAirportCode;
  const radiusKm = Math.max(30, options.radiusKm);
  const maxWaypoints = options.maxWaypoints ?? 48;

  // 1. Filter enabled 3D sector volumes (clipping far outside vertices only by polygon relevance)
  const volumes = catalog.volumes.filter((v) => options.enabledVolumeIds.has(v.id));

  // 2. Filter restricted zones within radius
  const restrictedZones = catalog.restrictedZones.filter((z) =>
    z.polygon.some((p) => LocalENUProjector.distanceKm(center, p) <= radiusKm),
  );

  // 3. Filter runways near target airport (within 25 km)
  const airways: AirwaySegment[] = [];
  for (const rwy of catalog.runways) {
    if (
      LocalENUProjector.distanceKm(center, rwy.p1) <= 25 &&
      LocalENUProjector.distanceKm(center, rwy.p2) <= 25
    ) {
      airways.push({
        id: rwy.id,
        name: rwy.name,
        kind: 'RUNWAY',
        runway: rwy.rwy1,
        points: [rwy.p1, rwy.p2],
      });
    }
  }

  // 4. Filter SID / STAR procedures for target airport or within radius & group by runway
  const procFixIds = new Set<string>();
  const runwayMap = new Map<string, { hasSid: boolean; hasStar: boolean }>();
  for (const proc of catalog.procedures) {
    const matchesApt = !proc.airportCode || proc.airportCode === airportCode;
    const withinRadius = proc.segments.some(
      ([a, b]) =>
        LocalENUProjector.distanceKm(center, a) <= radiusKm &&
        LocalENUProjector.distanceKm(center, b) <= radiusKm,
    );
    if (!matchesApt || !withinRadius) continue;

    const rwyKey = proc.runway || 'ALL';
    const entry = runwayMap.get(rwyKey) ?? { hasSid: false, hasStar: false };
    if (proc.procedureType === 'SID') entry.hasSid = true;
    else entry.hasStar = true;
    runwayMap.set(rwyKey, entry);

    proc.referencedFixIds.forEach((fid) => procFixIds.add(fid));
    proc.segments.forEach((seg, sIdx) => {
      airways.push({
        id: `${proc.id}-${sIdx}`,
        name: proc.name,
        kind: 'SID_STAR',
        procedureType: proc.procedureType,
        runway: rwyKey,
        points: seg,
      });
    });
  }

  // 5. Filter airways within radius
  for (const aw of catalog.airways) {
    if (
      aw.points.length >= 2 &&
      LocalENUProjector.distanceKm(center, aw.points[0]) <= radiusKm &&
      LocalENUProjector.distanceKm(center, aw.points[1]) <= radiusKm
    ) {
      airways.push(aw);
    }
  }

  // 6. Deduplicate & prioritize waypoints (target airport -> procedure fixes -> VOR/NDB -> nearest fixes, capped cleanly)
  const nearWps = catalog.waypoints
    .map((wp) => ({ wp, dist: LocalENUProjector.distanceKm(center, wp) }))
    .filter((item) => item.dist <= radiusKm);

  nearWps.sort((a, b) => {
    const prio = (w: Waypoint) => {
      if (w.id === airportCode) return 0;
      if (procFixIds.has(w.id)) return 1;
      if (w.kind === 'VOR') return 2;
      if (w.kind === 'AIRPORT') return 3;
      if (w.kind === 'NDB') return 4;
      return 5;
    };
    const pa = prio(a.wp);
    const pb = prio(b.wp);
    if (pa !== pb) return pa - pb;
    return a.dist - b.dist;
  });

  // Spatial deduplication so overlapping fixes/airport markers within 0.45 km never stack labels!
  const filteredWaypoints: Waypoint[] = [];
  for (const { wp } of nearWps) {
    if (filteredWaypoints.length >= maxWaypoints) break;
    const tooClose = filteredWaypoints.some(
      (existing) => LocalENUProjector.distanceKm(existing, wp) < 0.45,
    );
    if (!tooClose) {
      filteredWaypoints.push(wp);
    }
  }

  const runwayProcedures: RunwayProcedureSummary[] = Array.from(runwayMap.entries())
    .map(([runway, flags]) => ({ runway, ...flags }))
    .sort((a, b) => a.runway.localeCompare(b.runway));

  const title = (options.customTitle?.trim() || catalog.defaultTitle || `${airportCode} SECTOR`);

  return {
    name: title,
    regionSubtitle: `${airportCode} · ${Math.round(radiusKm)} km Radius`,
    center,
    airportCode,
    airportElevationFt: 256,
    volumes,
    waypoints: filteredWaypoints,
    airways,
    restrictedZones,
    restrictedCircles: [],
    runwayProcedures,
    baseMap: options.baseMap,
  };
}

/**
 * Convenience single-step wrapper preserving backward compatibility for tests & direct calls.
 */
export function parseEuroScopeAirspace(
  sctText: string,
  eseText = '',
  fallbackCenter: GeoPoint = { lat: 56.23, lon: 43.78417 },
  maxRadiusKm = 240,
): AirspaceDataset {
  const catalog = inspectEuroScopeFiles(sctText, eseText, fallbackCenter);
  const targetAirport = catalog.airports[0];
  const center = targetAirport
    ? { lat: targetAirport.lat, lon: targetAirport.lon }
    : catalog.infoCenter;
  const enabledIds = selectDefaultVolumesForAirport(
    catalog,
    catalog.infoAirportCode,
    center,
    maxRadiusKm,
  );
  return buildFilteredAirspaceFromCatalog(catalog, {
    targetAirportCode: catalog.infoAirportCode,
    radiusKm: maxRadiusKm,
    enabledVolumeIds: enabledIds,
  });
}
