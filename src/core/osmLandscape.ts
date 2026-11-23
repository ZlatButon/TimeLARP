import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { LocalENUProjector } from './geo';
import { isBuiltUpLanduseClass } from './urbanFabric';
import type {
  BaseMapData,
  GeoMapLabel,
  GeoMapPolygon,
  GeoMapPolyline,
  GeoPoint,
} from '../types/radar';

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{
    type: string;
    role?: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
}

export interface OverpassResponse {
  elements?: OverpassElement[];
}

export interface OsmFetchStats {
  polygons: number;
  urban: number;
  rivers: number;
  roads: number;
  coastlines: number;
  boundaries: number;
  cities: number;
  tilesLoaded?: number;
  zoom?: number;
  mirror?: string;
}

export interface OsmFetchResult {
  baseMap: BaseMapData | null;
  source: 'indexeddb' | 'openfreemap' | 'overpass' | 'error';
  stats: OsmFetchStats;
  errorMessage?: string;
}

export interface SlippyTileCoord {
  z: number;
  x: number;
  y: number;
}

export interface SlippyTileGrid {
  zoom: number;
  tiles: SlippyTileCoord[];
}

interface TileJsonResponse {
  tiles?: string[];
}

interface PlaceCandidate {
  id: string;
  text: string;
  rawName: string;
  position: GeoPoint;
  kind: 'CITY' | 'REGION';
  placeTier: 'major' | 'minor';
  placeClass: string;
  rank: number;
  priority: number;
}

const OPENFREEMAP_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const OPENFREEMAP_FALLBACK_TEMPLATE = 'https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

const IDB_NAME = 'aeroscope_openfreemap_v7';
const IDB_STORE_BASEMAPS = 'basemaps';
const IDB_STORE_CITY_BOUNDARIES = 'city_boundaries';

/** Kept exported for optional tooling; live OpenFreeMap terrain uses instant built-up MVT footprints */
export const NOMINATIM_RATE_LIMIT_MS = 1100;

/** Regional arterial road classes extracted from OpenFreeMap `transportation` layer */
const MAJOR_ROAD_CLASS_WEIGHTS: Record<string, number> = {
  motorway: 1.0,
  trunk: 0.95,
  primary: 0.82,
  secondary: 0.64,
};

/** Additional urban collector street classes extracted only on high-detail z>=10 metro inset tiles */
const METRO_ROAD_CLASS_WEIGHTS: Record<string, number> = {
  ...MAJOR_ROAD_CLASS_WEIGHTS,
  tertiary: 0.48,
};

let cachedTileTemplate: string | null = null;

function openTerrainDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE_BASEMAPS)) {
          db.createObjectStore(IDB_STORE_BASEMAPS);
        }
        if (!db.objectStoreNames.contains(IDB_STORE_CITY_BOUNDARIES)) {
          db.createObjectStore(IDB_STORE_CITY_BOUNDARIES);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGetBaseMap(key: string): Promise<BaseMapData | null> {
  const db = await openTerrainDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE_BASEMAPS, 'readonly');
      const store = tx.objectStore(IDB_STORE_BASEMAPS);
      const req = store.get(key);
      req.onsuccess = () => {
        const val = req.result as BaseMapData | undefined;
        if (val && Array.isArray(val.polygons) && Array.isArray(val.polylines)) {
          resolve(val);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSetBaseMap(key: string, data: BaseMapData): Promise<void> {
  const db = await openTerrainDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE_BASEMAPS, 'readwrite');
      const store = tx.objectStore(IDB_STORE_BASEMAPS);
      store.put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}


/**
 * Convert WGS84 (lat, lon) to Slippy Map tile coordinates (x, y) at zoom z.
 */
export function latLonToTile(lat: number, lon: number, z: number): SlippyTileCoord {
  const n = Math.pow(2, z);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const maxIdx = n - 1;
  return {
    z,
    x: ((x % n) + n) % n,
    y: Math.max(0, Math.min(maxIdx, y)),
  };
}

/**
 * Convert local MVT tile coordinates (px, py) within [0..extent] to WGS84 (lat, lon).
 */
export function tilePixelToLatLon(
  z: number,
  tileX: number,
  tileY: number,
  px: number,
  py: number,
  extent = 4096,
): GeoPoint {
  const n = Math.pow(2, z);
  const lon = ((tileX + px / extent) / n) * 360 - 180;
  const mercY = Math.PI * (1 - (2 * (tileY + py / extent)) / n);
  const lat = (Math.atan(Math.sinh(mercY)) * 180) / Math.PI;
  return { lat, lon };
}

/**
 * Compute Slippy Map tile grid covering `center` and `radiusKm`:
 * - Uses z = 8 for radii <= 195 km (high detail for rivers, roads & reservoirs)
 * - Uses z = 7 for radii > 195 km (fast coverage for wide 200-250 km sectors)
 * - Caps grid to <= 25 tiles centered on `center` so parallel fetch completes in ~1s.
 */
export function computeSlippyTileGrid(center: GeoPoint, radiusKm: number): SlippyTileGrid {
  const clampedRadius = Math.max(50, Math.min(260, radiusKm));
  const zoom = clampedRadius > 195 ? 7 : 8;
  const dLat = clampedRadius / 111.32;
  const dLon = clampedRadius / (111.32 * Math.max(0.25, Math.cos((center.lat * Math.PI) / 180)));

  const nw = latLonToTile(center.lat + dLat, center.lon - dLon, zoom);
  const se = latLonToTile(center.lat - dLat, center.lon + dLon, zoom);
  const ctr = latLonToTile(center.lat, center.lon, zoom);

  const n = Math.pow(2, zoom);
  let minX = Math.min(nw.x, se.x);
  let maxX = Math.max(nw.x, se.x);
  let minY = Math.min(nw.y, se.y);
  let maxY = Math.max(nw.y, se.y);

  if (maxX - minX > 4) {
    minX = Math.max(0, ctr.x - 2);
    maxX = Math.min(n - 1, ctr.x + 2);
  }
  if (maxY - minY > 4) {
    minY = Math.max(0, ctr.y - 2);
    maxY = Math.min(n - 1, ctr.y + 2);
  }

  const tiles: SlippyTileCoord[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      tiles.push({ z: zoom, x, y });
    }
  }
  return { zoom, tiles };
}

function decimatePoints(pts: GeoPoint[], maxPoints: number, closed: boolean): GeoPoint[] {
  if (pts.length <= maxPoints) return pts;
  const step = Math.max(1, Math.floor(pts.length / maxPoints));
  const out: GeoPoint[] = [];
  for (let i = 0; i < pts.length; i += step) {
    out.push(pts[i]);
  }
  if (closed && out.length >= 3) {
    const last = out[out.length - 1];
    const first = out[0];
    if (Math.hypot(last.lat - first.lat, last.lon - first.lon) > 1e-4) {
      out.push({ ...first });
    }
  } else if (!closed && out[out.length - 1] !== pts[pts.length - 1]) {
    out.push(pts[pts.length - 1]);
  }
  return out;
}

/**
 * Signed twice-area in MVT tile pixel coordinates (Y downward).
 * Per Mapbox Vector Tile Specification v2:
 * - Positive signed area => exterior (outer) polygon ring (clockwise in tile space)
 * - Negative signed area => interior (hole) ring (counter-clockwise in tile space)
 */
function mvtRingSignedArea2(ring: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/**
 * Approximate geographic polygon area in km² from WGS84 vertices.
 */
export function computeGeoRingAreaKm2(ring: GeoPoint[]): number {
  if (ring.length < 3) return 0;
  let latSum = 0;
  for (let i = 0; i < ring.length; i++) latSum += ring[i].lat;
  const avgLat = latSum / ring.length;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.max(0.15, Math.cos((avgLat * Math.PI) / 180));
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ax = a.lon * kmPerDegLon;
    const ay = a.lat * kmPerDegLat;
    const bx = b.lon * kmPerDegLon;
    const by = b.lat * kmPerDegLat;
    area2 += ax * by - bx * ay;
  }
  return 0.5 * Math.abs(area2);
}

/**
 * Build a region-bounded Nominatim GeoJSON polygon search URL for a city's real administrative boundary.
 */
export function buildNominatimCityUrl(
  cityName: string,
  center: GeoPoint,
  radiusKm: number,
): string {
  const clampedR = Math.max(50, Math.min(280, radiusKm));
  const dLat = clampedR / 111.32;
  const dLon = clampedR / (111.32 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  const left = (center.lon - dLon).toFixed(4);
  const top = (center.lat + dLat).toFixed(4);
  const right = (center.lon + dLon).toFixed(4);
  const bottom = (center.lat - dLat).toFixed(4);
  const viewbox = `${left},${top},${right},${bottom}`;
  return (
    `${NOMINATIM_SEARCH_URL}?q=${encodeURIComponent(cityName)}` +
    `&format=geojson&polygon_geojson=1&polygon_threshold=0.002&limit=1` +
    `&viewbox=${viewbox}&bounded=1`
  );
}

interface NominatimGeoJsonResponse {
  type?: string;
  features?: Array<{
    properties?: Record<string, unknown>;
    geometry?: {
      type?: string;
      coordinates?: unknown;
    };
  }>;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
}

function parseGeoJsonRing(rawRing: unknown): GeoPoint[] {
  if (!Array.isArray(rawRing)) return [];
  const pts: GeoPoint[] = [];
  for (const coord of rawRing) {
    if (Array.isArray(coord) && coord.length >= 2) {
      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        pts.push({ lat, lon });
      }
    }
  }
  return pts;
}

/**
 * Parse a Nominatim GeoJSON search response (`Polygon` or `MultiPolygon`) into clean
 * matte `URBAN` administrative boundary polygons with inner holes preserved.
 */
export function parseNominatimCityGeoJson(
  payload: NominatimGeoJsonResponse,
  cityKey: string,
  center: GeoPoint,
  maxRadiusKm: number,
): GeoMapPolygon[] {
  const feature =
    payload?.type === 'FeatureCollection' && Array.isArray(payload.features)
      ? payload.features[0]
      : payload?.type === 'Feature'
        ? payload
        : null;

  const geom = feature?.geometry;
  if (!geom || !geom.coordinates) return [];

  const rawPolygons: unknown[][] = [];
  if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
    rawPolygons.push(geom.coordinates as unknown[]);
  } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
    for (const poly of geom.coordinates as unknown[]) {
      if (Array.isArray(poly)) rawPolygons.push(poly);
    }
  } else {
    return [];
  }

  const out: GeoMapPolygon[] = [];
  const clipRadiusKm = maxRadiusKm * 1.35;

  rawPolygons.forEach((rings, pIdx) => {
    if (!Array.isArray(rings) || rings.length === 0) return;
    const outer = parseGeoJsonRing(rings[0]);
    if (outer.length < 4) return;
    // Skip microscopic administrative exclaves < 0.8 km²
    if (computeGeoRingAreaKm2(outer) < 0.8) return;

    const samplePt = outer[Math.floor(outer.length / 2)];
    if (
      LocalENUProjector.distanceKm(center, outer[0]) > clipRadiusKm &&
      LocalENUProjector.distanceKm(center, samplePt) > clipRadiusKm
    ) {
      return;
    }

    const holes: GeoPoint[][] = [];
    for (let h = 1; h < rings.length; h++) {
      const hole = parseGeoJsonRing(rings[h]);
      if (hole.length >= 4 && computeGeoRingAreaKm2(hole) >= 0.4) {
        holes.push(decimatePoints(hole, 96, true));
      }
    }

    out.push({
      id: `nom-city-${cityKey}-${pIdx}`,
      kind: 'URBAN',
      points: decimatePoints(outer, 220, true),
      holes: holes.length > 0 ? holes : undefined,
    });
  });

  return out;
}

export interface DecodedTileFeatures {
  polygons: GeoMapPolygon[];
  polylines: GeoMapPolyline[];
  places: PlaceCandidate[];
}

/**
 * Decode a single OpenFreeMap / OpenMapTiles MVT `.pbf` binary buffer into:
 * - `water`: pure borderless water polygons (with inner island holes)
 * - `landuse`: real built-up urban footprints (residential/commercial/industrial/retail >= 0.08 km²),
 *   later baked into a soft nocturnal urban density fabric texture with Gaussian organic fusion
 * - `waterway`: narrow river & canal centerlines
 * - `transportation`: major highway / arterial roads (`motorway`, `trunk`, `primary`, `secondary`)
 * - `boundary`: administrative land borders (excluding maritime lines)
 * - `place`: city & town point labels (major vs minor tier)
 */
export function decodeOpenFreeMapTile(
  pbfBytes: ArrayBuffer | Uint8Array,
  z: number,
  tileX: number,
  tileY: number,
  center: GeoPoint,
  maxRadiusKm: number,
): DecodedTileFeatures {
  const polygons: GeoMapPolygon[] = [];
  const polylines: GeoMapPolyline[] = [];
  const places: PlaceCandidate[] = [];

  const bytes = pbfBytes instanceof Uint8Array ? pbfBytes : new Uint8Array(pbfBytes);
  if (bytes.byteLength === 0) return { polygons, polylines, places };

  const tile = new VectorTile(new PbfReader(bytes));
  const clipRadiusKm = maxRadiusKm * 1.28;

  // 1. Water polygons (rivers, reservoirs, lakes, seas) — pure borderless fills with island holes
  const waterLayer = tile.layers.water;
  if (waterLayer) {
    const extent = waterLayer.extent || 4096;
    const minArea2 = z >= 8 ? 110 : 70;

    for (let fIdx = 0; fIdx < waterLayer.length; fIdx++) {
      const feature = waterLayer.feature(fIdx);
      if (feature.type !== 3) continue; // Polygon only
      const rings = feature.loadGeometry();
      if (!rings || rings.length === 0) continue;

      let currentOuter: GeoMapPolygon | null = null;
      let outerIdx = 0;

      for (const ring of rings) {
        if (ring.length < 4) continue;
        const area2 = mvtRingSignedArea2(ring);
        if (Math.abs(area2) < minArea2) continue;

        const geoRing = ring.map((pt) =>
          tilePixelToLatLon(z, tileX, tileY, pt.x, pt.y, extent),
        );

        const p0 = geoRing[0];
        const pMid = geoRing[Math.floor(geoRing.length / 2)];
        if (
          LocalENUProjector.distanceKm(center, p0) > clipRadiusKm &&
          LocalENUProjector.distanceKm(center, pMid) > clipRadiusKm
        ) {
          continue;
        }

        const decimated = decimatePoints(geoRing, 140, true);
        if (area2 > 0 || !currentOuter) {
          currentOuter = {
            id: `ofm-w-${z}-${tileX}-${tileY}-${fIdx}-${outerIdx++}`,
            kind: 'WATER',
            points: decimated,
          };
          polygons.push(currentOuter);
        } else {
          if (!currentOuter.holes) currentOuter.holes = [];
          currentOuter.holes.push(decimated);
        }
      }
    }
  }

  // 1b. Built-up urban footprints (`landuse`: residential/commercial/industrial/retail blocks)
  // Rendered via multi-pass Gaussian urban fabric texture so nearby districts fuse organically
  // and tiny isolated villages dissolve softly without harsh borders or jagged islands.
  const landuseLayer = tile.layers.landuse;
  if (landuseLayer) {
    const extent = landuseLayer.extent || 4096;
    const urbanClipKm = maxRadiusKm * 1.15;
    for (let fIdx = 0; fIdx < landuseLayer.length; fIdx++) {
      const feature = landuseLayer.feature(fIdx);
      if (feature.type !== 3) continue; // Polygon only
      const cls = String(feature.properties?.class ?? '');
      if (!isBuiltUpLanduseClass(cls)) continue;

      const rings = feature.loadGeometry();
      if (!rings || rings.length === 0) continue;

      let currentOuter: GeoMapPolygon | null = null;
      let outerIdx = 0;
      for (const ring of rings) {
        if (ring.length < 4) continue;
        const area2 = mvtRingSignedArea2(ring);
        if (Math.abs(area2) < 12) continue;

        const geoRing = ring.map((pt) =>
          tilePixelToLatLon(z, tileX, tileY, pt.x, pt.y, extent),
        );
        const areaKm2 = computeGeoRingAreaKm2(geoRing);
        // Keep real housing/industrial quarters (>= 0.04 km² on z>=10 metro tiles, >= 0.08 km² regionally)
        const minUrbanAreaKm2 = z >= 10 ? 0.04 : 0.08;
        if (areaKm2 < minUrbanAreaKm2) continue;

        const pMid = geoRing[Math.floor(geoRing.length / 2)];
        if (
          LocalENUProjector.distanceKm(center, geoRing[0]) > urbanClipKm &&
          LocalENUProjector.distanceKm(center, pMid) > urbanClipKm
        ) {
          continue;
        }

        const decimated = decimatePoints(geoRing, 72, true);
        if (area2 > 0 || !currentOuter) {
          currentOuter = {
            id: `ofm-u-${z}-${tileX}-${tileY}-${fIdx}-${outerIdx++}`,
            kind: 'URBAN',
            points: decimated,
          };
          polygons.push(currentOuter);
        } else {
          if (!currentOuter.holes) currentOuter.holes = [];
          currentOuter.holes.push(decimated);
        }
      }
    }
  }

  // 2. Waterway polylines (major rivers & canals)
  const waterwayLayer = tile.layers.waterway;
  if (waterwayLayer) {
    const extent = waterwayLayer.extent || 4096;
    for (let fIdx = 0; fIdx < waterwayLayer.length; fIdx++) {
      const feature = waterwayLayer.feature(fIdx);
      if (feature.type !== 2) continue;
      const cls = String(feature.properties?.class ?? '').toLowerCase();
      if (cls && cls !== 'river' && cls !== 'canal' && cls !== 'drain') continue;

      const lines = feature.loadGeometry();
      lines.forEach((line, lIdx) => {
        if (line.length < 2) return;
        const geoPts = line.map((pt) => tilePixelToLatLon(z, tileX, tileY, pt.x, pt.y, extent));
        const mid = geoPts[Math.floor(geoPts.length / 2)];
        if (LocalENUProjector.distanceKm(center, mid) > clipRadiusKm) return;

        polylines.push({
          id: `ofm-riv-${z}-${tileX}-${tileY}-${fIdx}-${lIdx}`,
          kind: 'RIVER',
          points: decimatePoints(geoPts, 80, false),
        });
      });
    }
  }

  // 3. Arterial & urban boulevard roads (`transportation`: major arterials regionally, plus tertiary on z>=10 metro tiles)
  const transportLayer = tile.layers.transportation;
  if (transportLayer) {
    const extent = transportLayer.extent || 4096;
    const roadClipKm = maxRadiusKm * 1.12;
    const tertiaryClipKm = Math.min(58, maxRadiusKm * 0.55);
    const roadWeights = z >= 10 ? METRO_ROAD_CLASS_WEIGHTS : MAJOR_ROAD_CLASS_WEIGHTS;
    for (let fIdx = 0; fIdx < transportLayer.length; fIdx++) {
      const feature = transportLayer.feature(fIdx);
      if (feature.type !== 2) continue; // LineString only
      const cls = String(feature.properties?.class ?? '').toLowerCase();
      const weight = roadWeights[cls];
      if (weight === undefined) continue;

      const lines = feature.loadGeometry();
      lines.forEach((line, lIdx) => {
        if (line.length < 2) return;
        const geoPts = line.map((pt) => tilePixelToLatLon(z, tileX, tileY, pt.x, pt.y, extent));
        const mid = geoPts[Math.floor(geoPts.length / 2)];
        const distKm = LocalENUProjector.distanceKm(center, mid);
        if (distKm > (cls === 'tertiary' ? tertiaryClipKm : roadClipKm)) return;

        polylines.push({
          id: `ofm-rd-${z}-${tileX}-${tileY}-${fIdx}-${lIdx}`,
          kind: 'ROAD',
          points: decimatePoints(geoPts, 64, false),
          weight,
        });
      });
    }
  }

  // 4. Administrative & country boundaries (subtle ground borders; exclude maritime lines)
  const boundaryLayer = tile.layers.boundary;
  if (boundaryLayer) {
    const extent = boundaryLayer.extent || 4096;
    for (let fIdx = 0; fIdx < boundaryLayer.length; fIdx++) {
      const feature = boundaryLayer.feature(fIdx);
      if (feature.type !== 2) continue;
      const maritime = Number(feature.properties?.maritime ?? 0);
      if (maritime === 1) continue;
      const adminLevel = Number(feature.properties?.admin_level ?? 4);
      if (Number.isFinite(adminLevel) && adminLevel > 4) continue;

      const lines = feature.loadGeometry();
      lines.forEach((line, lIdx) => {
        if (line.length < 2) return;
        const geoPts = line.map((pt) => tilePixelToLatLon(z, tileX, tileY, pt.x, pt.y, extent));
        const mid = geoPts[Math.floor(geoPts.length / 2)];
        if (LocalENUProjector.distanceKm(center, mid) > clipRadiusKm) return;

        polylines.push({
          id: `ofm-bnd-${z}-${tileX}-${tileY}-${fIdx}-${lIdx}`,
          kind: 'BOUNDARY',
          points: decimatePoints(geoPts, 70, false),
        });
      });
    }
  }

  // 5. Place labels (cities & towns)
  const placeLayer = tile.layers.place;
  if (placeLayer) {
    const extent = placeLayer.extent || 4096;
    for (let fIdx = 0; fIdx < placeLayer.length; fIdx++) {
      const feature = placeLayer.feature(fIdx);
      if (feature.type !== 1) continue;
      const props = feature.properties ?? {};
      const cls = String(props.class ?? '').toLowerCase();
      if (cls !== 'city' && cls !== 'town' && cls !== 'capital' && cls !== 'state') continue;

      const rawName = String(
        props['name:en'] || props['name:latin'] || props.name_en || props.name || '',
      ).trim();
      if (!rawName || rawName.length < 2) continue;

      const geom = feature.loadGeometry();
      const pt = geom?.[0]?.[0];
      if (!pt) continue;
      const pos = tilePixelToLatLon(z, tileX, tileY, pt.x, pt.y, extent);
      const dist = LocalENUProjector.distanceKm(center, pos);
      if (dist > maxRadiusKm * 1.08) continue;

      const rankNum = Number(props.rank ?? 10);
      const safeRank = Number.isFinite(rankNum) ? rankNum : 10;
      const classWeight =
        cls === 'capital' ? 0 : cls === 'city' ? 10 : cls === 'town' ? 30 : 50;
      const placeTier: 'major' | 'minor' =
        cls === 'capital' || cls === 'city' || safeRank <= 6 ? 'major' : 'minor';

      places.push({
        id: `ofm-place-${z}-${tileX}-${tileY}-${fIdx}`,
        text: rawName.toUpperCase(),
        rawName,
        position: pos,
        kind: cls === 'state' ? 'REGION' : 'CITY',
        placeTier,
        placeClass: cls,
        rank: safeRank,
        priority: classWeight + safeRank,
      });
    }
  }

  return { polygons, polylines, places };
}

/**
 * Fetch the live OpenFreeMap TileJSON from `https://tiles.openfreemap.org/planet`
 * to retrieve the current versioned `.pbf` tile URL template.
 */
export async function fetchOpenFreeMapTileTemplate(): Promise<string> {
  if (cachedTileTemplate) return cachedTileTemplate;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const resp = await fetch(OPENFREEMAP_TILEJSON_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const json = (await resp.json()) as TileJsonResponse;
      const firstTemplate = json.tiles?.find(
        (t) => typeof t === 'string' && t.includes('{z}') && t.includes('{x}') && t.includes('{y}'),
      );
      if (firstTemplate) {
        cachedTileTemplate = firstTemplate;
        return firstTemplate;
      }
    }
  } catch {
    clearTimeout(timer);
  }
  return OPENFREEMAP_FALLBACK_TEMPLATE;
}

/**
 * Pure parser converting an Overpass API `out geom;` JSON response into BaseMapData
 * (retained as an optional legacy utility).
 */
export function parseOverpassResponse(
  response: OverpassResponse,
  _center: GeoPoint,
  _radiusKm = 140,
  regionName = 'OpenStreetMap Dark Vector Terrain',
): BaseMapData {
  const elements = Array.isArray(response?.elements) ? response.elements : [];
  const polygons: GeoMapPolygon[] = [];
  const polylines: GeoMapPolyline[] = [];
  const labels: GeoMapLabel[] = [];
  const seenLabels = new Set<string>();

  const extractWayPoints = (geom?: Array<{ lat: number; lon: number }>): GeoPoint[] => {
    if (!Array.isArray(geom) || geom.length < 2) return [];
    const pts: GeoPoint[] = [];
    for (let i = 0; i < geom.length; i++) {
      const g = geom[i];
      if (Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
        pts.push({ lat: g.lat, lon: g.lon });
      }
    }
    return pts;
  };

  for (const el of elements) {
    const tags = el.tags ?? {};

    if (el.type === 'node' && (tags.place === 'city' || tags.place === 'town')) {
      const rawName = tags['name:en'] || tags.int_name || tags.name;
      if (rawName && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
        const text = rawName.trim().toUpperCase();
        if (text && !seenLabels.has(text) && labels.length < 24) {
          seenLabels.add(text);
          labels.push({
            id: `osm-city-${el.id}`,
            text,
            position: { lat: el.lat!, lon: el.lon! },
            kind: 'CITY',
          });
        }
      }
      continue;
    }

    if (el.type === 'way' && el.geometry) {
      const rawPts = extractWayPoints(el.geometry);
      if (rawPts.length < 2) continue;

      if (tags.natural === 'coastline') {
        polylines.push({
          id: `osm-coast-${el.id}`,
          kind: 'COASTLINE',
          points: decimatePoints(rawPts, 90, false),
        });
      } else if (tags.waterway === 'river' || tags.waterway === 'canal') {
        polylines.push({
          id: `osm-river-${el.id}`,
          kind: 'RIVER',
          points: decimatePoints(rawPts, 72, false),
        });
      } else if (
        tags.natural === 'water' ||
        tags.water === 'reservoir' ||
        tags.water === 'lake' ||
        tags.water === 'river' ||
        tags.landuse === 'reservoir'
      ) {
        if (rawPts.length >= 4) {
          const closed = decimatePoints(rawPts, 96, true);
          polygons.push({
            id: `osm-water-${el.id}`,
            kind: 'WATER',
            points: closed,
          });
          polylines.push({
            id: `osm-water-shore-${el.id}`,
            kind: 'COASTLINE',
            points: closed,
          });
        }
      }
      continue;
    }

    if (
      el.type === 'relation' &&
      Array.isArray(el.members) &&
      (tags.natural === 'water' || tags.water || tags.landuse === 'reservoir')
    ) {
      const outerRings: GeoPoint[][] = [];
      const innerHoles: GeoPoint[][] = [];

      for (const m of el.members) {
        if (!m.geometry || m.geometry.length < 4) continue;
        const pts = extractWayPoints(m.geometry);
        if (pts.length < 4) continue;
        if (m.role === 'inner') {
          innerHoles.push(decimatePoints(pts, 64, true));
        } else {
          outerRings.push(decimatePoints(pts, 96, true));
        }
      }

      outerRings.forEach((outer, rIdx) => {
        polygons.push({
          id: `osm-rel-water-${el.id}-${rIdx}`,
          kind: 'WATER',
          points: outer,
          holes: rIdx === 0 && innerHoles.length > 0 ? innerHoles : undefined,
        });
        polylines.push({
          id: `osm-rel-shore-${el.id}-${rIdx}`,
          kind: 'COASTLINE',
          points: outer,
        });
      });
    }
  }

  return {
    name: regionName,
    waterBase: false,
    polygons,
    polylines,
    labels,
  };
}

export function summarizeBaseMapStats(
  baseMap: BaseMapData,
  mirror?: string,
  tilesLoaded?: number,
  zoom?: number,
): OsmFetchStats {
  let rivers = 0;
  let roads = 0;
  let coastlines = 0;
  let boundaries = 0;
  let urban = 0;
  let waterOrLand = 0;
  for (const poly of baseMap.polygons) {
    if (poly.kind === 'URBAN') urban++;
    else waterOrLand++;
  }
  for (const pl of baseMap.polylines) {
    if (pl.kind === 'RIVER') rivers++;
    else if (pl.kind === 'ROAD') roads++;
    else if (pl.kind === 'BOUNDARY') boundaries++;
    else if (pl.kind === 'COASTLINE') coastlines++;
  }
  return {
    polygons: waterOrLand,
    urban,
    rivers,
    roads,
    coastlines,
    boundaries,
    cities: baseMap.labels.length,
    tilesLoaded,
    zoom,
    mirror,
  };
}

/**
 * Fetch fast vector terrain (water bodies, rivers, built-up urban footprints, major arterial roads,
 * boundaries, city labels) from OpenFreeMap MVT / PBF vector tiles with persistent IndexedDB caching.
 */
export async function fetchOsmBaseMap(
  center: GeoPoint,
  radiusKm = 160,
  airportCode = 'AREA',
  bypassCache = false,
): Promise<OsmFetchResult> {
  const clampedRadius = Math.max(50, Math.min(250, Math.round(radiusKm)));
  const grid = computeSlippyTileGrid(center, clampedRadius);
  const cacheKey = `ofm_v7_z${grid.zoom}_${center.lat.toFixed(2)}_${center.lon.toFixed(2)}_${clampedRadius}`;

  if (!bypassCache) {
    const cached = await idbGetBaseMap(cacheKey);
    if (
      cached &&
      (cached.polygons.length > 0 || cached.polylines.length > 0 || cached.labels.length > 0)
    ) {
      return {
        baseMap: cached,
        source: 'indexeddb',
        stats: summarizeBaseMapStats(cached, 'IndexedDB cache', grid.tiles.length, grid.zoom),
      };
    }
  }

  const template = await fetchOpenFreeMapTileTemplate();
  const polygons: GeoMapPolygon[] = [];
  const polylines: GeoMapPolyline[] = [];
  const placeCandidates: PlaceCandidate[] = [];
  let tilesLoaded = 0;
  const errors: string[] = [];

  // Compact 3x3 z=10 metropolitan inset around the airport for high-resolution urban streets & quarters
  const metroCenterTile = latLonToTile(center.lat, center.lon, 10);
  const metroN = 1024;
  const metroTiles: SlippyTileCoord[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const ty = metroCenterTile.y + dy;
    if (ty < 0 || ty >= metroN) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const tx = ((metroCenterTile.x + dx) % metroN + metroN) % metroN;
      metroTiles.push({ z: 10, x: tx, y: ty });
    }
  }
  const metroUrbanPolys: GeoMapPolygon[] = [];
  const metroRoadLines: GeoMapPolyline[] = [];
  let metroLoaded = 0;

  await Promise.all([
    ...grid.tiles.map(async (coord) => {
      const url = template
        .replace('{z}', String(coord.z))
        .replace('{x}', String(coord.x))
        .replace('{y}', String(coord.y));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) {
          errors.push(`z${coord.z}/${coord.x}/${coord.y}: HTTP ${resp.status}`);
          return;
        }
        const buf = await resp.arrayBuffer();
        const decoded = decodeOpenFreeMapTile(
          buf,
          coord.z,
          coord.x,
          coord.y,
          center,
          clampedRadius,
        );
        tilesLoaded++;
        polygons.push(...decoded.polygons);
        polylines.push(...decoded.polylines);
        placeCandidates.push(...decoded.places);
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : 'network error';
        errors.push(`z${coord.z}/${coord.x}/${coord.y}: ${msg.includes('abort') ? 'timeout' : msg}`);
      }
    }),
    ...metroTiles.map(async (coord) => {
      const url = template
        .replace('{z}', String(coord.z))
        .replace('{x}', String(coord.x))
        .replace('{y}', String(coord.y));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7500);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return;
        const buf = await resp.arrayBuffer();
        const decoded = decodeOpenFreeMapTile(
          buf,
          coord.z,
          coord.x,
          coord.y,
          center,
          Math.min(clampedRadius, 75),
        );
        metroLoaded++;
        for (const p of decoded.polygons) {
          if (p.kind === 'URBAN') metroUrbanPolys.push(p);
        }
        for (const l of decoded.polylines) {
          if (l.kind === 'ROAD') metroRoadLines.push(l);
        }
      } catch {
        clearTimeout(timer);
      }
    }),
  ]);

  if (metroLoaded > 0) {
    // Merge high-detail z10 urban quarters & city arteries into the regional base map
    polygons.push(...metroUrbanPolys);
    polylines.push(...metroRoadLines);
  }

  if (tilesLoaded === 0) {
    return {
      baseMap: null,
      source: 'error',
      stats: {
        polygons: 0,
        urban: 0,
        rivers: 0,
        roads: 0,
        coastlines: 0,
        boundaries: 0,
        cities: 0,
        tilesLoaded: 0,
        zoom: grid.zoom,
      },
      errorMessage: `OpenFreeMap tiles unavailable (${errors.slice(0, 2).join('; ') || 'network error'}). Load a local .geojson file or retry.`,
    };
  }

  // Deduplicate and rank place labels with spatial spacing so city names stay crisp
  placeCandidates.sort((a, b) => a.priority - b.priority);
  const labels: GeoMapLabel[] = [];
  const seenNames = new Set<string>();
  const minSpacingKm = clampedRadius > 190 ? 24 : 18;

  for (const cand of placeCandidates) {
    if (labels.length >= 28) break;
    if (seenNames.has(cand.text)) continue;
    const tooClose = labels.some(
      (existing) => LocalENUProjector.distanceKm(existing.position, cand.position) < minSpacingKm,
    );
    if (tooClose) continue;
    seenNames.add(cand.text);
    labels.push({
      id: cand.id,
      text: cand.text,
      position: cand.position,
      kind: cand.kind,
      placeTier: cand.placeTier,
      rank: cand.rank,
    });
  }

  const initialBaseMap: BaseMapData = {
    name: `OpenFreeMap Terrain · ${airportCode} (z${grid.zoom})`,
    waterBase: false,
    polygons,
    polylines,
    labels,
  };

  if (polygons.length > 0 || polylines.length > 0 || labels.length > 0) {
    await idbSetBaseMap(cacheKey, initialBaseMap);
    return {
      baseMap: initialBaseMap,
      source: 'openfreemap',
      stats: summarizeBaseMapStats(initialBaseMap, 'OpenFreeMap MVT', tilesLoaded, grid.zoom),
    };
  }

  return {
    baseMap: null,
    source: 'error',
    stats: {
      polygons: 0,
      urban: 0,
      rivers: 0,
      roads: 0,
      coastlines: 0,
      boundaries: 0,
      cities: 0,
      tilesLoaded,
      zoom: grid.zoom,
    },
    errorMessage: `OpenFreeMap returned ${tilesLoaded} tiles with 0 vector features in radius ${clampedRadius} km.`,
  };
}
