import type { BaseMapData, GeoMapPolygon } from '../types/radar';
import type { LocalENUProjector } from './geo';

export type NightLightCategory =
  | 'core'
  | 'quarter'
  | 'road'
  | 'bridge'
  | 'interchange'
  | 'settlement';

export interface NightLightPoint {
  x: number;
  z: number;
  /** Calibrated nocturnal RGB in [0..1] (sodium amber, warm gold, warm/neutral white, restrained cool-white accents) */
  r: number;
  g: number;
  b: number;
  /** Relative optical size weight (0.45 .. 1.45) */
  size: number;
  /** Relative intensity weight (0.14 .. 1.0) */
  intensity: number;
  /** Semantic light source role for testing & tuning */
  category: NightLightCategory;
}

export interface BridgeLineSegment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface NightRoadRibbonSegment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Smooth mitered perpendicular unit normal at start endpoint */
  nx0: number;
  nz0: number;
  /** Smooth mitered perpendicular unit normal at end endpoint */
  nx1: number;
  nz1: number;
  /** Base optical ribbon half-width in km */
  halfWidthKm: number;
  /** Luminous intensity [0..1] at start and end endpoints */
  intensity0: number;
  intensity1: number;
  /** Color temperature [0..1] at start and end endpoints */
  temp0: number;
  temp1: number;
  /** Cumulative distance along road polyline in km (for organic non-periodic luminance modulation) */
  along0: number;
  along1: number;
  /** Per-road deterministic phase seed */
  seed: number;
  /** True for narrow river/waterway bridge spans */
  isBridge: boolean;
  /** Road hierarchy weight (0.4 .. 1.0) */
  roadWeight: number;
}

export interface UrbanHub {
  x: number;
  z: number;
  radiusKm: number;
  strength: number;
}

interface ProjectedPoly2D {
  outer: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cx: number;
  cz: number;
  areaKm2: number;
}

interface RoadSegment2D {
  roadIdx: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  ux: number;
  uz: number;
  len: number;
  weight: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 2D R2 plastic-constant quasirandom ratios (provably zero Cartesian lattice alignment or periodicity) */
const R2_A1 = 0.7548776662466927;
const R2_A2 = 0.5698402909980532;

/**
 * Deterministic 2D hash in [0..1) from integer cell coordinates & seed.
 * Guarantees zero random jumping or temporal flicker across frames and WebM export.
 */
export function hash2D(ix: number, iz: number, seed = 0): number {
  let h =
    Math.imul(ix | 0, 374761393) +
    Math.imul(iz | 0, 668265263) +
    Math.imul(seed | 0, 1442695041);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Deterministic 1D hash in [0..1) for road-segment and cluster sampling.
 */
export function hash1D(index: number, seed = 0): number {
  let h = (Math.imul(index | 0, 747796405) + Math.imul(seed | 0, 2891336453) + 1013904223) >>> 0;
  h = Math.imul((h >>> ((h >>> 28) + 4)) ^ h, 277803737) >>> 0;
  return ((h ^ (h >>> 22)) >>> 0) / 4294967296;
}

/**
 * Physically inspired nocturnal city-light color palette modeled on FL300 aerial night photography:
 * - Warm sodium-vapor amber & golden hues as the primary foundation (~62%)
 * - Moderate warm tungsten & soft neutral white (~30%)
 * - Very limited restrained cool-white LED accents (~8%, concentrated in major centers & interchanges)
 */
export function sampleNightLightColor(
  temp01: number,
  isCommercialHub = false,
): [number, number, number] {
  const t = Math.max(0, Math.min(1, temp01));
  const coolThreshold = isCommercialHub ? 0.89 : 0.965;

  if (t >= coolThreshold) {
    const u = (t - coolThreshold) / Math.max(1e-4, 1 - coolThreshold);
    return [0.85 - u * 0.05, 0.91 - u * 0.02, 0.99];
  }

  const w = t / coolThreshold;
  if (w < 0.42) {
    // Deep sodium-vapor amber (1950K - 2250K)
    const u = w / 0.42;
    return [0.97 + u * 0.03, 0.45 + u * 0.16, 0.10 + u * 0.08];
  }
  if (w < 0.74) {
    // Golden amber / warm highway sodium (2300K - 2800K)
    const u = (w - 0.42) / 0.32;
    return [1.0, 0.61 + u * 0.19, 0.18 + u * 0.28];
  }
  // Warm tungsten -> soft neutral white (3000K - 4000K)
  const u = (w - 0.74) / 0.26;
  return [1.0, 0.80 + u * 0.13, 0.46 + u * 0.36];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Rotated smooth 2D value noise (rotated by ~37 deg so axis alignment is broken even in FBM octaves).
 */
function valueNoise2D(x: number, z: number, seed = 0): number {
  const rx = x * 0.7986355 - z * 0.601815;
  const rz = x * 0.601815 + z * 0.7986355;
  const ix = Math.floor(rx);
  const iz = Math.floor(rz);
  const fx = rx - ix;
  const fz = rz - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2D(ix, iz, seed);
  const b = hash2D(ix + 1, iz, seed);
  const c = hash2D(ix, iz + 1, seed);
  const d = hash2D(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/**
 * Domain-warped organic 2-octave FBM in [0..1] for dark greenbelts, parks, and natural district breaks.
 */
function warpedFbm2D(xKm: number, zKm: number, scale: number, seed = 0): number {
  const sx = xKm * scale;
  const sz = zKm * scale;
  const wx = (valueNoise2D(sx * 0.65 + 4.2, sz * 0.65 - 2.9, seed + 17) - 0.5) * 1.45;
  const wz = (valueNoise2D(sx * 0.65 - 7.1, sz * 0.65 + 5.3, seed + 31) - 0.5) * 1.45;
  const n1 = valueNoise2D(sx + wx, sz + wz, seed + 53);
  const n2 = valueNoise2D((sx + wx) * 2.13 + 11.7, (sz + wz) * 2.13 - 8.4, seed + 89);
  return n1 * 0.64 + n2 * 0.36;
}

function distToSegmentSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-10) return (px - ax) * (px - ax) + (pz - az) * (pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const qx = ax + t * dx;
  const qz = az + t * dz;
  return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

function distanceToRingEdgeKm(x: number, z: number, ring: Array<[number, number]>): number {
  let minSq = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d2 = distToSegmentSq(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d2 < minSq) minSq = d2;
  }
  return Math.sqrt(minSq);
}

function pointInRing(x: number, z: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function projectPolygon(poly: GeoMapPolygon, projector: LocalENUProjector): ProjectedPoly2D | null {
  if (poly.points.length < 3) return null;
  const outer: Array<[number, number]> = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumX = 0;
  let sumZ = 0;

  for (const pt of poly.points) {
    const enu = projector.toENU(pt.lat, pt.lon, 0);
    outer.push([enu.x, enu.z]);
    if (enu.x < minX) minX = enu.x;
    if (enu.x > maxX) maxX = enu.x;
    if (enu.z < minZ) minZ = enu.z;
    if (enu.z > maxZ) maxZ = enu.z;
    sumX += enu.x;
    sumZ += enu.z;
  }

  let area2 = 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const areaKm2 = Math.abs(area2) * 0.5;
  if (areaKm2 < 0.03) return null;

  const holes: Array<Array<[number, number]>> = [];
  if (poly.holes) {
    for (const h of poly.holes) {
      if (h.length < 3) continue;
      holes.push(
        h.map((pt) => {
          const enu = projector.toENU(pt.lat, pt.lon, 0);
          return [enu.x, enu.z] as [number, number];
        }),
      );
    }
  }

  return {
    outer,
    holes,
    minX,
    maxX,
    minZ,
    maxZ,
    cx: sumX / outer.length,
    cz: sumZ / outer.length,
    areaKm2,
  };
}

function isPointInProjectedPoly(x: number, z: number, poly: ProjectedPoly2D): boolean {
  if (x < poly.minX || x > poly.maxX || z < poly.minZ || z > poly.maxZ) return false;
  if (!pointInRing(x, z, poly.outer)) return false;
  for (const hole of poly.holes) {
    if (pointInRing(x, z, hole)) return false;
  }
  return true;
}

/**
 * Fast spatial bucket index for polygons (used strictly for O(1) containment & distance lookups,
 * NEVER for placing light coordinates!).
 */
class SpatialPolyIndex {
  private readonly cellSize: number;
  private readonly buckets = new Map<string, ProjectedPoly2D[]>();
  public readonly polys: ProjectedPoly2D[];

  constructor(polys: ProjectedPoly2D[], cellSize = 6) {
    this.polys = polys;
    this.cellSize = cellSize;
    for (const p of polys) {
      const x0 = Math.floor(p.minX / cellSize);
      const x1 = Math.floor(p.maxX / cellSize);
      const z0 = Math.floor(p.minZ / cellSize);
      const z1 = Math.floor(p.maxZ / cellSize);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const key = `${gx},${gz}`;
          let arr = this.buckets.get(key);
          if (!arr) {
            arr = [];
            this.buckets.set(key, arr);
          }
          arr.push(p);
        }
      }
    }
  }

  contains(x: number, z: number): boolean {
    if (this.polys.length === 0) return false;
    const gx = Math.floor(x / this.cellSize);
    const gz = Math.floor(z / this.cellSize);
    const arr = this.buckets.get(`${gx},${gz}`);
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
      if (isPointInProjectedPoly(x, z, arr[i])) return true;
    }
    return false;
  }

  minDistanceKm(x: number, z: number, maxSearchKm = 8): number {
    if (this.polys.length === 0) return Infinity;
    if (this.contains(x, z)) return 0;
    const rCells = Math.ceil(maxSearchKm / this.cellSize);
    const cgx = Math.floor(x / this.cellSize);
    const cgz = Math.floor(z / this.cellSize);
    const checked = new Set<ProjectedPoly2D>();
    let best = maxSearchKm + 0.001;

    for (let dx = -rCells; dx <= rCells; dx++) {
      for (let dz = -rCells; dz <= rCells; dz++) {
        const arr = this.buckets.get(`${cgx + dx},${cgz + dz}`);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (checked.has(p)) continue;
          checked.add(p);
          const bx = x < p.minX ? p.minX - x : x > p.maxX ? x - p.maxX : 0;
          const bz = z < p.minZ ? p.minZ - z : z > p.maxZ ? z - p.maxZ : 0;
          if (Math.hypot(bx, bz) >= best) continue;
          const d = distanceToRingEdgeKm(x, z, p.outer);
          if (d < best) best = d;
        }
      }
    }
    return best > maxSearchKm ? Infinity : best;
  }
}

/**
 * Fast spatial bucket index for road segments to query nearest street direction & detect real junctions.
 */
class SpatialRoadIndex {
  private readonly cellSize: number;
  private readonly buckets = new Map<string, RoadSegment2D[]>();
  public readonly segments: RoadSegment2D[];

  constructor(segments: RoadSegment2D[], cellSize = 4) {
    this.segments = segments;
    this.cellSize = cellSize;
    for (const seg of segments) {
      const x0 = Math.floor(seg.minX / cellSize);
      const x1 = Math.floor(seg.maxX / cellSize);
      const z0 = Math.floor(seg.minZ / cellSize);
      const z1 = Math.floor(seg.maxZ / cellSize);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const key = `${gx},${gz}`;
          let arr = this.buckets.get(key);
          if (!arr) {
            arr = [];
            this.buckets.set(key, arr);
          }
          arr.push(seg);
        }
      }
    }
  }

  nearestRoad(
    x: number,
    z: number,
    maxSearchKm = 3.2,
  ): { distKm: number; ux: number; uz: number; weight: number } | null {
    if (this.segments.length === 0) return null;
    const rCells = Math.ceil(maxSearchKm / this.cellSize);
    const cgx = Math.floor(x / this.cellSize);
    const cgz = Math.floor(z / this.cellSize);
    let bestSq = maxSearchKm * maxSearchKm;
    let bestSeg: RoadSegment2D | null = null;

    for (let dx = -rCells; dx <= rCells; dx++) {
      for (let dz = -rCells; dz <= rCells; dz++) {
        const arr = this.buckets.get(`${cgx + dx},${cgz + dz}`);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const s = arr[i];
          if (x < s.minX - maxSearchKm || x > s.maxX + maxSearchKm) continue;
          if (z < s.minZ - maxSearchKm || z > s.maxZ + maxSearchKm) continue;
          const d2 = distToSegmentSq(x, z, s.x0, s.z0, s.x1, s.z1);
          if (d2 < bestSq) {
            bestSq = d2;
            bestSeg = s;
          }
        }
      }
    }
    if (!bestSeg) return null;
    return {
      distKm: Math.sqrt(bestSq),
      ux: bestSeg.ux,
      uz: bestSeg.uz,
      weight: bestSeg.weight,
    };
  }

  queryNearbySegments(x: number, z: number, radiusKm: number): RoadSegment2D[] {
    const rCells = Math.ceil(radiusKm / this.cellSize);
    const cgx = Math.floor(x / this.cellSize);
    const cgz = Math.floor(z / this.cellSize);
    const out: RoadSegment2D[] = [];
    const seen = new Set<RoadSegment2D>();
    for (let dx = -rCells; dx <= rCells; dx++) {
      for (let dz = -rCells; dz <= rCells; dz++) {
        const arr = this.buckets.get(`${cgx + dx},${cgz + dz}`);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const s = arr[i];
          if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
          }
        }
      }
    }
    return out;
  }
}

function segmentIntersection2D(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): [number, number] | null {
  const rX = bx - ax;
  const rZ = bz - az;
  const sX = dx - cx;
  const sZ = dz - cz;
  const denom = rX * sZ - rZ * sX;
  if (Math.abs(denom) < 1e-8) return null;
  const qpx = cx - ax;
  const qpz = cz - az;
  const t = (qpx * sZ - qpz * sX) / denom;
  const u = (qpx * rZ - qpz * rX) / denom;
  if (t >= -0.02 && t <= 1.02 && u >= -0.02 && u <= 1.02) {
    return [ax + t * rX, az + t * rZ];
  }
  return null;
}

interface PreparedMapGeometry {
  hubs: UrbanHub[];
  urbanPolys: ProjectedPoly2D[];
  waterPolys: ProjectedPoly2D[];
  urbanIndex: SpatialPolyIndex;
  waterIndex: SpatialPolyIndex;
  roadLines: Array<{ pts: Array<[number, number]>; weight: number }>;
  roadSegments: RoadSegment2D[];
  roadIndex: SpatialRoadIndex;
  cityLabels: Array<{ x: number; z: number; isMajor: boolean; rank: number }>;
}

function prepareMapGeometry(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
  maxRadiusKm: number,
): PreparedMapGeometry {
  const hubs = buildUrbanHubs(baseMap, projector);

  const urbanPolys: ProjectedPoly2D[] = [];
  const waterPolys: ProjectedPoly2D[] = [];

  for (const poly of baseMap.polygons) {
    const proj = projectPolygon(poly, projector);
    if (!proj) continue;
    if (Math.hypot(proj.cx, proj.cz) > maxRadiusKm * 1.25) continue;
    if (poly.kind === 'URBAN') urbanPolys.push(proj);
    else if (poly.kind === 'WATER') waterPolys.push(proj);
  }

  const roadLines: Array<{ pts: Array<[number, number]>; weight: number }> = [];
  const roadSegments: RoadSegment2D[] = [];

  for (const pl of baseMap.polylines) {
    if (pl.kind !== 'ROAD' || pl.points.length < 2) continue;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < pl.points.length; i++) {
      const enu = projector.toENU(pl.points[i].lat, pl.points[i].lon, 0);
      pts.push([enu.x, enu.z]);
    }
    const roadIdx = roadLines.length;
    const weight = pl.weight ?? 0.78;
    roadLines.push({ pts, weight });

    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.02) continue;
      if (Math.hypot((x0 + x1) * 0.5, (z0 + z1) * 0.5) > maxRadiusKm * 1.12) continue;
      roadSegments.push({
        roadIdx,
        x0,
        z0,
        x1,
        z1,
        ux: dx / len,
        uz: dz / len,
        len,
        weight,
        minX: Math.min(x0, x1),
        maxX: Math.max(x0, x1),
        minZ: Math.min(z0, z1),
        maxZ: Math.max(z0, z1),
      });
    }
  }

  const cityLabels: Array<{ x: number; z: number; isMajor: boolean; rank: number }> = [];
  for (const lb of baseMap.labels) {
    if (lb.kind !== 'CITY') continue;
    const enu = projector.toENU(lb.position.lat, lb.position.lon, 0);
    if (Math.hypot(enu.x, enu.z) > maxRadiusKm * 1.05) continue;
    const rank = lb.rank ?? 10;
    const isMajor = lb.placeTier === 'major' || rank <= 4;
    cityLabels.push({ x: enu.x, z: enu.z, isMajor, rank });
  }

  return {
    hubs,
    urbanPolys,
    waterPolys,
    urbanIndex: new SpatialPolyIndex(urbanPolys, 6),
    waterIndex: new SpatialPolyIndex(waterPolys, 6),
    roadLines,
    roadSegments,
    roadIndex: new SpatialRoadIndex(roadSegments, 4),
    cityLabels,
  };
}

/**
 * Extract geographic urban centers (from city labels + large built-up district centroids)
 * so downtown cores are denser and brighter than residential quarters and outskirts.
 */
export function buildUrbanHubs(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
): UrbanHub[] {
  const hubs: UrbanHub[] = [];

  for (const lb of baseMap.labels) {
    if (lb.kind !== 'CITY') continue;
    const enu = projector.toENU(lb.position.lat, lb.position.lon, 0);
    const isMajor = lb.placeTier === 'major' || (lb.rank ?? 10) <= 4;
    hubs.push({
      x: enu.x,
      z: enu.z,
      radiusKm: isMajor ? 13.5 : 5.8,
      strength: isMajor ? 1.0 : 0.62,
    });
  }

  for (const poly of baseMap.polygons) {
    if (poly.kind !== 'URBAN' || poly.points.length < 3) continue;
    const proj = projectPolygon(poly, projector);
    if (!proj || proj.areaKm2 < 3.5) continue;
    const nearExisting = hubs.some((h) => Math.hypot(h.x - proj.cx, h.z - proj.cz) < 6.5);
    if (!nearExisting) {
      hubs.push({
        x: proj.cx,
        z: proj.cz,
        radiusKm: Math.min(11, Math.max(4.0, Math.sqrt(proj.areaKm2) * 1.05)),
        strength: Math.min(0.88, 0.44 + Math.sqrt(proj.areaKm2) * 0.048),
      });
    }
  }

  return hubs;
}

/**
 * Compute smooth urban centrality intensity in [0.10 .. 1.0] based on proximity to downtown hubs.
 */
export function computeUrbanCoreWeight(xKm: number, zKm: number, hubs: UrbanHub[]): number {
  let maxW = 0;
  for (let i = 0; i < hubs.length; i++) {
    const h = hubs[i];
    const d = Math.hypot(xKm - h.x, zKm - h.z);
    if (d >= h.radiusKm * 2.1) continue;
    const norm = d / Math.max(1, h.radiusKm);
    const w = h.strength * Math.exp(-norm * norm * 1.45);
    if (w > maxW) maxW = w;
  }
  return Math.max(0.1, Math.min(1.0, 0.1 + maxW * 0.9));
}

function minDistanceToHubEdgeKm(x: number, z: number, hubs: UrbanHub[]): number {
  let best = Infinity;
  for (let i = 0; i < hubs.length; i++) {
    const h = hubs[i];
    const d = Math.hypot(x - h.x, z - h.z) - h.radiusKm * 0.48;
    if (d < best) best = d;
  }
  return Math.max(0, best);
}

/**
 * Extract exact narrow roadway bridge spans where `ROAD` polylines cross `WATER` polygons.
 */
export function generateNightBridgeSegments(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
  maxRadiusKm = 250,
): BridgeLineSegment[] {
  const waterPolys: ProjectedPoly2D[] = [];
  for (const poly of baseMap.polygons) {
    if (poly.kind !== 'WATER') continue;
    const proj = projectPolygon(poly, projector);
    if (!proj) continue;
    if (Math.hypot(proj.cx, proj.cz) > maxRadiusKm * 1.3) continue;
    waterPolys.push(proj);
  }
  if (waterPolys.length === 0) return [];
  const waterIndex = new SpatialPolyIndex(waterPolys, 6);

  const segments: BridgeLineSegment[] = [];
  const sampleStepKm = 0.16;

  for (const pl of baseMap.polylines) {
    if (pl.kind !== 'ROAD' || pl.points.length < 2) continue;
    const pts = pl.points.map((p) => {
      const enu = projector.toENU(p.lat, p.lon, 0);
      return [enu.x, enu.z] as [number, number];
    });

    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.04) continue;
      if (Math.hypot((x0 + x1) * 0.5, (z0 + z1) * 0.5) > maxRadiusKm * 1.05) continue;

      const steps = Math.max(1, Math.ceil(len / sampleStepKm));
      let spanStart: [number, number] | null = null;
      let prevPt: [number, number] = [x0, z0];

      for (let s = 1; s <= steps; s++) {
        const frac = s / steps;
        const cx = x0 + dx * frac;
        const cz = z0 + dz * frac;
        const midX = (prevPt[0] + cx) * 0.5;
        const midZ = (prevPt[1] + cz) * 0.5;
        const overWater = waterIndex.contains(midX, midZ);

        if (overWater) {
          if (!spanStart) spanStart = [prevPt[0], prevPt[1]];
        } else if (spanStart) {
          segments.push({
            x0: spanStart[0],
            z0: spanStart[1],
            x1: prevPt[0],
            z1: prevPt[1],
          });
          spanStart = null;
        }
        prevPt = [cx, cz];
      }

      if (spanStart) {
        segments.push({
          x0: spanStart[0],
          z0: spanStart[1],
          x1: prevPt[0],
          z1: prevPt[1],
        });
      }
    }
  }

  return segments;
}

/**
 * Evaluate continuous road illumination intensity & temperature at world point `(x, z)`
 * based on road hierarchy weight, urban containment, bridge status, and suburban approach taper.
 */
function evaluateRoadPointLighting(
  x: number,
  z: number,
  roadWeight: number,
  prep: PreparedMapGeometry,
): { intensity: number; temp: number; halfWidthKm: number; isBridge: boolean } {
  const isBridge = prep.waterIndex.contains(x, z);
  const coreW = computeUrbanCoreWeight(x, z, prep.hubs);

  if (isBridge) {
    // Crisp, recognizable illuminated river crossing strictly confined to bridge deck width
    const bridgeBoost = 0.52 + coreW * 0.36;
    return {
      intensity: Math.min(0.92, (0.48 + roadWeight * 0.34) * bridgeBoost),
      temp: 0.48 + coreW * 0.24,
      halfWidthKm: 0.085 + roadWeight * 0.035,
      isBridge: true,
    };
  }

  const inUrban = prep.urbanIndex.contains(x, z);
  if (inUrban) {
    // Clear urban hierarchy: motorways/trunks brightest, primary boulevards strong, secondary finer, tertiary delicate
    const tierScale =
      roadWeight >= 0.9
        ? 1.0
        : roadWeight >= 0.75
          ? 0.80
          : roadWeight >= 0.55
            ? 0.56
            : 0.38;
    const widthScale =
      roadWeight >= 0.9
        ? 0.26
        : roadWeight >= 0.75
          ? 0.20
          : roadWeight >= 0.55
            ? 0.145
            : 0.105;
    const intensity = Math.min(0.94, (0.34 + coreW * 0.54) * tierScale);
    const temp = Math.min(0.84, 0.24 + coreW * 0.36 + roadWeight * 0.16);
    return {
      intensity,
      temp,
      halfWidthKm: widthScale * (0.85 + coreW * 0.28),
      isBridge: false,
    };
  }

  // Outside explicit URBAN polygon: check proximity to built-up border or city hub
  const distUrban = Math.min(
    prep.urbanIndex.minDistanceKm(x, z, 8.5),
    minDistanceToHubEdgeKm(x, z, prep.hubs),
  );

  if (distUrban < 7.5) {
    // Smooth organic suburban approach fade (highways gradually dim as they leave the city)
    const approach = 1.0 - smoothstep(0.0, 7.5, distUrban);
    const approachCurve = approach * approach;
    const tierScale = roadWeight >= 0.9 ? 0.86 : roadWeight >= 0.75 ? 0.62 : 0.38;
    const ruralFloor = roadWeight >= 0.88 ? 0.075 : roadWeight >= 0.78 ? 0.035 : 0;
    const intensity = ruralFloor + approachCurve * (0.28 + coreW * 0.42) * tierScale;
    const halfWidthKm = (0.11 + roadWeight * 0.11) * (0.65 + 0.35 * approach);
    return {
      intensity,
      temp: 0.22 + approach * 0.24,
      halfWidthKm,
      isBridge: false,
    };
  }

  // Deep dark countryside: only major trunk/motorway corridors retain a subtle faint whisper of highway lighting/traffic
  if (roadWeight >= 0.88) {
    return {
      intensity: 0.075,
      temp: 0.18,
      halfWidthKm: 0.125,
      isBridge: false,
    };
  }
  if (roadWeight >= 0.78) {
    return {
      intensity: 0.032,
      temp: 0.16,
      halfWidthKm: 0.095,
      isBridge: false,
    };
  }
  return {
    intensity: 0,
    temp: 0.15,
    halfWidthKm: 0.08,
    isBridge: false,
  };
}

/**
 * Generate continuous hierarchical road & bridge luminous filament segments with smooth miter normals.
 * Renders streets and highways as real continuous warm light chains rather than sparse random dots.
 */
export function generateNightRoadRibbons(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
  maxRadiusKm = 250,
  prepared?: PreparedMapGeometry,
): NightRoadRibbonSegment[] {
  const prep = prepared ?? prepareMapGeometry(baseMap, projector, maxRadiusKm);
  const ribbons: NightRoadRibbonSegment[] = [];
  const maxStepKm = 0.75;

  for (let rIdx = 0; rIdx < prep.roadLines.length; rIdx++) {
    const road = prep.roadLines[rIdx];
    const roadWeight = road.weight;
    const seed = hash1D(rIdx + 1, 907) * 97.3;

    // Subdivide road polyline smoothly so urban borders & river bridge transitions are accurate
    const subPts: Array<{ x: number; z: number; along: number }> = [];
    let cumAlong = 0;

    for (let i = 0; i < road.pts.length; i++) {
      const [cx, cz] = road.pts[i];
      if (i === 0) {
        subPts.push({ x: cx, z: cz, along: 0 });
        continue;
      }
      const [px, pz] = road.pts[i - 1];
      const dx = cx - px;
      const dz = cz - pz;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 0.02) continue;

      const steps = Math.max(1, Math.ceil(segLen / maxStepKm));
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        subPts.push({
          x: px + dx * f,
          z: pz + dz * f,
          along: cumAlong + segLen * f,
        });
      }
      cumAlong += segLen;
    }

    if (subPts.length < 2) continue;

    // Precompute smooth miter normals along the subdivided polyline
    const normals: Array<[number, number]> = new Array(subPts.length);
    for (let i = 0; i < subPts.length; i++) {
      const prev = subPts[Math.max(0, i - 1)];
      const next = subPts[Math.min(subPts.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const tLen = Math.hypot(tx, tz);
      if (tLen < 1e-6) {
        normals[i] = [0, 1];
      } else {
        tx /= tLen;
        tz /= tLen;
        normals[i] = [-tz, tx];
      }
    }

    const evals = subPts.map((pt) => evaluateRoadPointLighting(pt.x, pt.z, roadWeight, prep));

    for (let i = 1; i < subPts.length; i++) {
      const p0 = subPts[i - 1];
      const p1 = subPts[i];
      const midX = (p0.x + p1.x) * 0.5;
      const midZ = (p0.z + p1.z) * 0.5;
      if (Math.hypot(midX, midZ) > maxRadiusKm * 1.05) continue;

      const e0 = evals[i - 1];
      const e1 = evals[i];
      const midBridge = prep.waterIndex.contains(midX, midZ);

      // Skip totally unlit secondary rural roads
      if (!midBridge && e0.intensity < 0.015 && e1.intensity < 0.015) continue;

      const halfWidthKm = midBridge
        ? 0.085 + roadWeight * 0.032
        : (e0.halfWidthKm + e1.halfWidthKm) * 0.5;

      ribbons.push({
        x0: p0.x,
        z0: p0.z,
        x1: p1.x,
        z1: p1.z,
        nx0: normals[i - 1][0],
        nz0: normals[i - 1][1],
        nx1: normals[i][0],
        nz1: normals[i][1],
        halfWidthKm,
        intensity0: midBridge ? Math.max(e0.intensity, 0.56) : e0.intensity,
        intensity1: midBridge ? Math.max(e1.intensity, 0.56) : e1.intensity,
        temp0: midBridge ? Math.max(e0.temp, 0.52) : e0.temp,
        temp1: midBridge ? Math.max(e1.temp, 0.52) : e1.temp,
        along0: p0.along,
        along1: p1.along,
        seed,
        isBridge: midBridge,
        roadWeight,
      });
    }
  }

  return ribbons;
}

/**
 * Detect genuine road-to-road junctions & intersections (both shared vertices and geometric crossings).
 */
function detectRoadJunctions(
  prep: PreparedMapGeometry,
  maxRadiusKm: number,
): { urbanJunctions: Array<[number, number, number]>; ruralJunctions: Array<[number, number, number]> } {
  const urbanJunctions: Array<[number, number, number]> = [];
  const ruralJunctions: Array<[number, number, number]> = [];
  const seenUrban = new Set<string>();
  const seenRural = new Set<string>();

  const segs = prep.roadSegments;
  // Limit pairwise intersection work on dense OpenFreeMap datasets via spatial buckets
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    if (a.weight < 0.62) continue; // Only meaningful arterials & highways form major illuminated junctions
    const mx = (a.x0 + a.x1) * 0.5;
    const mz = (a.z0 + a.z1) * 0.5;
    if (Math.hypot(mx, mz) > maxRadiusKm * 1.02) continue;

    const nearby = prep.roadIndex.queryNearbySegments(mx, mz, Math.max(1.0, a.len * 0.6 + 0.6));
    for (let j = 0; j < nearby.length; j++) {
      const b = nearby[j];
      if (b.roadIdx <= a.roadIdx) continue;
      if (b.weight < 0.60) continue;

      let jx: number | null = null;
      let jz: number | null = null;

      // Exact crossing check
      const cross = segmentIntersection2D(a.x0, a.z0, a.x1, a.z1, b.x0, b.z0, b.x1, b.z1);
      if (cross) {
        jx = cross[0];
        jz = cross[1];
      } else {
        // Check endpoint proximity (T-junctions / ramps within 0.45 km)
        const d0 = distToSegmentSq(a.x0, a.z0, b.x0, b.z0, b.x1, b.z1);
        if (d0 < 0.45 * 0.45) {
          jx = a.x0;
          jz = a.z0;
        } else {
          const d1 = distToSegmentSq(a.x1, a.z1, b.x0, b.z0, b.x1, b.z1);
          if (d1 < 0.45 * 0.45) {
            jx = a.x1;
            jz = a.z1;
          }
        }
      }

      if (jx === null || jz === null) continue;
      if (prep.waterIndex.contains(jx, jz)) continue;

      const combinedWeight = Math.min(1.0, (a.weight + b.weight) * 0.55);
      const inUrban = prep.urbanIndex.contains(jx, jz) || prep.urbanIndex.minDistanceKm(jx, jz, 1.5) < 1.5;

      if (inUrban) {
        const key = `${Math.round(jx * 1.6)},${Math.round(jz * 1.6)}`;
        if (!seenUrban.has(key)) {
          seenUrban.add(key);
          urbanJunctions.push([jx, jz, combinedWeight]);
        }
      } else if (a.weight >= 0.78 && b.weight >= 0.74) {
        const key = `${Math.round(jx * 0.65)},${Math.round(jz * 0.65)}`;
        if (!seenRural.has(key)) {
          seenRural.add(key);
          ruralJunctions.push([jx, jz, combinedWeight]);
        }
      }
    }
  }

  return { urbanJunctions, ruralJunctions };
}

/**
 * Build both the continuous road/bridge filaments and the structured pinpoint night city lights
 * in one shared geographic preparation pass (fast & 100% deterministic).
 */
export function buildNightCityLightingData(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
  maxRadiusKm = 250,
  maxTotalPoints = 28000,
): {
  ribbons: NightRoadRibbonSegment[];
  points: NightLightPoint[];
  hubs: UrbanHub[];
} {
  const prep = prepareMapGeometry(baseMap, projector, maxRadiusKm);
  const ribbons = generateNightRoadRibbons(baseMap, projector, maxRadiusKm, prep);
  const points = generateNightCityLightPointsFromPrepared(prep, maxRadiusKm, maxTotalPoints);
  return { ribbons, points, hubs: prep.hubs };
}

/**
 * Deterministically generate aircraft-view nocturnal city lights with ZERO regular grid / repeating patterns
 * and ZERO random stray countryside garbage points:
 *
 * 1. Non-grid hierarchical urban quarter clusters inside `URBAN` footprints (using R2 quasirandom
 *    seeds + local road-aligned micro-district orientations + domain-warped dark park/courtyard breaks)
 * 2. Road-anchored avenue/streetlamp chains, flanking frontage clusters, river bridges, and intersections
 * 3. Luminous downtown core constellations around major urban hubs
 * 4. Coherent small satellite settlement clusters for mapped towns lacking detailed `URBAN` polygons
 * 5. Compact illuminated highway interchange clusters ONLY at real rural highway-to-highway junctions.
 */
export function generateNightCityLightPoints(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
  maxRadiusKm = 250,
  maxTotalPoints = 28000,
): NightLightPoint[] {
  const prep = prepareMapGeometry(baseMap, projector, maxRadiusKm);
  return generateNightCityLightPointsFromPrepared(prep, maxRadiusKm, maxTotalPoints);
}

function generateNightCityLightPointsFromPrepared(
  prep: PreparedMapGeometry,
  maxRadiusKm: number,
  maxTotalPoints: number,
): NightLightPoint[] {
  const points: NightLightPoint[] = [];

  // Budget split prioritizing dense urban centers, structured quarters, and crisp road chains
  const quarterBudget = Math.floor(maxTotalPoints * 0.50);
  const coreBudget = Math.floor(maxTotalPoints * 0.15);
  const roadBudget = Math.floor(maxTotalPoints * 0.28);
  const settlementBudget = Math.floor(maxTotalPoints * 0.04);
  const interchangeBudget = maxTotalPoints - quarterBudget - coreBudget - roadBudget - settlementBudget;

  const { urbanJunctions, ruralJunctions } = detectRoadJunctions(prep, maxRadiusKm);

  // --- 1. NON-GRID HIERARCHICAL URBAN QUARTER CLUSTERS (Zero Cartesian Grid!) ---
  const weightedPolys = prep.urbanPolys.map((poly) => {
    const polyCoreW = computeUrbanCoreWeight(poly.cx, poly.cz, prep.hubs);
    const weight = poly.areaKm2 * (0.30 + 1.65 * polyCoreW * polyCoreW);
    return { poly, polyCoreW, weight };
  });
  let totalWeightedUrbanArea = 0;
  for (const wp of weightedPolys) totalWeightedUrbanArea += wp.weight;

  if (weightedPolys.length > 0 && totalWeightedUrbanArea > 0.02) {
    // Sort highest-weight metropolitan districts first so major centers receive full crisp density
    weightedPolys.sort((a, b) => b.weight - a.weight);

    for (let pIdx = 0; pIdx < weightedPolys.length && points.length < quarterBudget; pIdx++) {
      const { poly } = weightedPolys[pIdx];
      const polyShare = weightedPolys[pIdx].weight / totalWeightedUrbanArea;
      const polyPointTarget = Math.min(
        quarterBudget - points.length,
        Math.max(12, Math.round(quarterBudget * polyShare * 1.12)),
      );
      const polyCharScale = Math.sqrt(poly.areaKm2);
      const featherKm = Math.max(0.45, Math.min(2.1, polyCharScale * 0.22));
      const bboxW = Math.max(0.2, poly.maxX - poly.minX);
      const bboxH = Math.max(0.2, poly.maxZ - poly.minZ);
      const fillRatio = Math.max(0.15, Math.min(1.0, poly.areaKm2 / (bboxW * bboxH)));

      // Each district cluster emits ~5..10 lights; estimate how many R2 quasirandom probes to test
      const desiredClusters = Math.max(3, Math.ceil(polyPointTarget / 6.2));
      const maxProbes = Math.min(14000, Math.ceil((desiredClusters / fillRatio) * 3.4));

      let emittedForPoly = 0;
      const seedOffset1 = hash1D(pIdx + 17, 131);
      const seedOffset2 = hash1D(pIdx + 31, 257);

      for (let probe = 1; probe <= maxProbes && emittedForPoly < polyPointTarget && points.length < quarterBudget; probe++) {
        // 2D R2 low-discrepancy quasirandom coordinates — strictly zero Cartesian grid or periodic tiling!
        const u = (seedOffset1 + probe * R2_A1) % 1.0;
        const v = (seedOffset2 + probe * R2_A2) % 1.0;

        let sx = poly.minX + u * bboxW;
        let sz = poly.minZ + v * bboxH;

        // Subtle organic domain-warp perturbation so seeds never sit on any geometric curve
        const warpScale = Math.min(0.45, polyCharScale * 0.08);
        sx += (valueNoise2D(sx * 0.72 + 3.1, sz * 0.72 - 1.9, 101) - 0.5) * warpScale;
        sz += (valueNoise2D(sx * 0.72 - 4.7, sz * 0.72 + 2.8, 137) - 0.5) * warpScale;

        if (!isPointInProjectedPoly(sx, sz, poly)) continue;
        if (prep.waterIndex.contains(sx, sz)) continue;

        const coreW = computeUrbanCoreWeight(sx, sz, prep.hubs);
        const nearRoad = prep.roadIndex.nearestRoad(sx, sz, 2.8);
        const roadAffinity = nearRoad ? Math.exp(-nearRoad.distKm * 0.95) : 0.12;

        // Organic dark voids (parks, rail yards, unlit courtyards, forests) via domain-warped FBM
        const districtNoise = warpedFbm2D(sx, sz, 0.36, 401);
        const blockNoise = warpedFbm2D(sx, sz, 1.05, 613);
        const builtActivity = districtNoise * 0.56 + blockNoise * 0.44 + roadAffinity * 0.22;

        // Edge feathering: suburbs taper organically into dark countryside instead of hard polygon walls
        const edgeDist = distanceToRingEdgeKm(sx, sz, poly.outer);
        const edgeFade = smoothstep(
          0.0,
          featherKm,
          edgeDist + (districtNoise - 0.48) * featherKm * 0.95,
        );

        // Dark gap carving: stronger in suburbs/outskirts, tighter in dense downtown cores
        const darkCutoff = 0.44 - coreW * 0.18 - roadAffinity * 0.08;
        if (builtActivity < darkCutoff) continue;

        const keepProb =
          (0.28 + coreW * 0.46 + roadAffinity * 0.26) * (0.18 + 0.82 * edgeFade);
        if (hash1D(probe * 37 + pIdx * 1013, 311) > keepProb) continue;

        // Local street-block bearing: align micro-district to nearest real avenue, or smooth local curl noise!
        let localAngle: number;
        if (nearRoad && nearRoad.distKm < 2.2) {
          localAngle = Math.atan2(nearRoad.uz, nearRoad.ux);
          // Slight natural variation per micro-block (+/- 10 deg)
          localAngle += (hash1D(probe * 19 + pIdx, 353) - 0.5) * 0.35;
        } else {
          localAngle = warpedFbm2D(sx, sz, 0.18, 709) * Math.PI * 2.0;
        }
        const cosA = Math.cos(localAngle);
        const sinA = Math.sin(localAngle);

        // Emit a coherent organic micro-district cluster (4..11 lights forming angled blocks/courtyards)
        const densityBoost = smoothstep(darkCutoff, 0.95, builtActivity);
        const rawClusterCount =
          4 + Math.floor((coreW * 4.5 + densityBoost * 3.0 + roadAffinity * 1.5) * (0.55 + hash1D(probe, 419) * 0.65));
        const clusterCount = Math.min(11, Math.max(4, rawClusterCount));
        const clusterSpanKm = (0.28 + (1 - coreW * 0.35) * 0.38) * (0.75 + hash1D(probe, 443) * 0.55);

        // Slight per-cluster color tint consistency (real neighborhoods share sodium vs LED retrofits!)
        const districtTintBias = (hash1D(probe * 13 + pIdx * 7, 467) - 0.5) * 0.22;

        for (let k = 0; k < clusterCount && emittedForPoly < polyPointTarget && points.length < quarterBudget; k++) {
          const hKey = probe * 97 + k * 29 + pIdx * 389;
          // Distribute along two orthogonal local block axes with organic irregularity (zero global grid!)
          const alongAxis = k < Math.ceil(clusterCount * 0.65);
          const u1 = hash1D(hKey, 503) - 0.5;
          const u2 = hash1D(hKey, 521) - 0.5;
          // Concentrate more tightly toward the micro-block core (triangular / Gaussian-like spread)
          const spreadA = (u1 + (hash1D(hKey, 541) - 0.5)) * 0.5;
          const spreadB = (u2 + (hash1D(hKey, 557) - 0.5)) * 0.5;

          const localX = alongAxis ? spreadA * clusterSpanKm * 1.35 : spreadB * clusterSpanKm * 0.55;
          const localZ = alongAxis ? spreadB * clusterSpanKm * 0.48 : spreadA * clusterSpanKm * 1.15;

          const lx = sx + localX * cosA - localZ * sinA;
          const lz = sz + localX * sinA + localZ * cosA;

          if (!isPointInProjectedPoly(lx, lz, poly) || prep.waterIndex.contains(lx, lz)) continue;

          const isCommercialSpot = coreW > 0.58 && (k === 0 || (k === 1 && hash1D(hKey, 569) < 0.45));
          const tempRoll = Math.max(
            0,
            Math.min(
              1,
              hash1D(hKey, 587) * (0.64 + coreW * 0.36) + districtTintBias + (isCommercialSpot ? 0.18 : 0),
            ),
          );
          const [r, g, b] = sampleNightLightColor(tempRoll, isCommercialSpot);

          const lumJitter = 0.62 + hash1D(hKey, 601) * 0.62;
          const intensity = Math.min(
            0.94,
            (0.24 + coreW * 0.44 + densityBoost * 0.18 + (isCommercialSpot ? 0.14 : 0)) *
              (0.42 + 0.58 * edgeFade) *
              lumJitter,
          );
          const size =
            (0.55 + coreW * 0.30 + (isCommercialSpot ? 0.24 : 0)) *
            (0.76 + hash1D(hKey, 617) * 0.46);

          points.push({
            x: lx,
            z: lz,
            r,
            g,
            b,
            size,
            intensity,
            category: 'quarter',
          });
          emittedForPoly++;
        }
      }
    }
  }

  // --- 2. LUMINOUS DOWNTOWN CORE CONSTELLATIONS (Dense bright city hearts) ---
  const coreEnd = points.length + coreBudget;
  const majorHubs = prep.hubs.filter((h) => h.strength >= 0.55);
  if (majorHubs.length > 0) {
    let totalHubWeight = 0;
    for (const h of majorHubs) totalHubWeight += h.strength * h.strength;

    for (let hIdx = 0; hIdx < majorHubs.length && points.length < coreEnd; hIdx++) {
      const hub = majorHubs[hIdx];
      const hubWeight = hub.strength * hub.strength;
      const hubCount = Math.min(
        coreEnd - points.length,
        Math.max(24, Math.round((coreBudget * hubWeight) / Math.max(0.1, totalHubWeight))),
      );
      const coreRadiusKm = Math.max(2.0, hub.radiusKm * 0.40);

      let emitted = 0;
      for (let i = 1; i <= hubCount * 3 && emitted < hubCount && points.length < coreEnd; i++) {
        const key = hIdx * 10007 + i;
        // Polar quasirandom golden-angle spiral with exponential radial falloff (dense center, smooth outer halo)
        const angle = i * 2.399963229728653 + hash1D(key, 641) * 0.55;
        const rNorm = Math.pow(hash1D(key, 647), 1.65);
        const rad = rNorm * coreRadiusKm;

        const lx = hub.x + Math.cos(angle) * rad;
        const lz = hub.z + Math.sin(angle) * rad;
        if (prep.waterIndex.contains(lx, lz)) continue;
        // Keep downtown core accents grounded on built-up land (or within 2.5km of hub if OSM polygon had a hole)
        if (prep.urbanPolys.length > 0 && !prep.urbanIndex.contains(lx, lz) && rad > 2.4) continue;

        const centerFactor = 1.0 - rNorm;
        const tempRoll = Math.min(1, hash1D(key, 653) * 0.85 + centerFactor * 0.20);
        const [r, g, b] = sampleNightLightColor(tempRoll, true);

        const intensity = Math.min(
          0.98,
          (0.46 + centerFactor * 0.42) * (0.72 + hash1D(key, 659) * 0.42),
        );
        const size = (0.70 + centerFactor * 0.45) * (0.80 + hash1D(key, 661) * 0.40);

        points.push({
          x: lx,
          z: lz,
          r,
          g,
          b,
          size,
          intensity,
          category: 'core',
        });
        emitted++;
      }
    }
  }

  // --- 3. ROAD-ANCHORED STREETLAMP CHAINS, BRIDGES, FRONTAGE & URBAN INTERSECTIONS ---
  const roadEnd = points.length + roadBudget;

  // 3a. Crisp illuminated urban arterial intersections (focal nodes where avenues cross)
  const maxUrbanJuncPts = Math.floor(roadBudget * 0.22);
  let urbanJuncEmitted = 0;
  for (let ji = 0; ji < urbanJunctions.length && urbanJuncEmitted < maxUrbanJuncPts && points.length < roadEnd; ji++) {
    const [jx, jz, jWeight] = urbanJunctions[ji];
    const coreW = computeUrbanCoreWeight(jx, jz, prep.hubs);
    const lamps = 3 + Math.floor(jWeight * 3.5 + coreW * 2.0);
    for (let k = 0; k < lamps && urbanJuncEmitted < maxUrbanJuncPts && points.length < roadEnd; k++) {
      const hKey = ji * 53 + k * 17;
      const ang = hash1D(hKey, 701) * Math.PI * 2;
      const rad = k === 0 ? 0.02 : 0.05 + hash1D(hKey, 709) * 0.26;
      const lx = jx + Math.cos(ang) * rad;
      const lz = jz + Math.sin(ang) * rad;
      if (prep.waterIndex.contains(lx, lz)) continue;

      const isHighMast = k === 0 || (k === 1 && coreW > 0.55);
      const [r, g, b] = sampleNightLightColor(
        isHighMast ? 0.72 + hash1D(hKey, 719) * 0.28 : 0.30 + hash1D(hKey, 727) * 0.52,
        isHighMast,
      );
      points.push({
        x: lx,
        z: lz,
        r,
        g,
        b,
        size: (isHighMast ? 1.05 : 0.68) * (0.85 + hash1D(hKey, 733) * 0.30),
        intensity: Math.min(0.96, (0.52 + coreW * 0.34) * (isHighMast ? 1.12 : 0.82)),
        category: 'road',
      });
      urbanJuncEmitted++;
    }
  }

  // 3b. Variable-spaced streetlamp & avenue frontage beads along urban roads, bridges & suburban approaches
  let litRoadKm = 0;
  for (const seg of prep.roadSegments) {
    const mx = (seg.x0 + seg.x1) * 0.5;
    const mz = (seg.z0 + seg.z1) * 0.5;
    if (
      prep.urbanIndex.contains(mx, mz) ||
      prep.waterIndex.contains(mx, mz) ||
      prep.urbanIndex.minDistanceKm(mx, mz, 3.2) < 3.2
    ) {
      litRoadKm += seg.len;
    }
  }

  const remainingRoadPts = Math.max(250, roadEnd - points.length);
  const baseLampStepKm = Math.max(0.16, Math.min(0.55, (litRoadKm * 1.45) / remainingRoadPts));

  let lampSeq = 0;
  for (let rIdx = 0; rIdx < prep.roadLines.length && points.length < roadEnd; rIdx++) {
    const road = prep.roadLines[rIdx];
    const roadWeight = road.weight;
    const roadPhase = hash1D(rIdx + 7, 751) * 50.0;

    for (let i = 1; i < road.pts.length && points.length < roadEnd; i++) {
      const [x0, z0] = road.pts[i - 1];
      const [x1, z1] = road.pts[i];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 0.04) continue;
      if (Math.hypot((x0 + x1) * 0.5, (z0 + z1) * 0.5) > maxRadiusKm * 1.04) continue;

      const ux = dx / segLen;
      const uz = dz / segLen;
      const nx = -uz;
      const nz = ux;

      // Variable non-periodic step walk (NEVER identical evenly-spaced dashed garlands!)
      let dist = hash1D(rIdx * 997 + i * 31, 761) * baseLampStepKm * 0.65;
      while (dist <= segLen && points.length < roadEnd) {
        lampSeq++;
        const px = x0 + ux * dist;
        const pz = z0 + uz * dist;

        const onBridge = prep.waterIndex.contains(px, pz);
        const inUrban = !onBridge && prep.urbanIndex.contains(px, pz);
        const coreW = computeUrbanCoreWeight(px, pz, prep.hubs);

        // Organic lengthwise luminance variation so streets have brighter stretches & quieter blocks
        const stretchMod =
          0.62 +
          0.38 *
            (0.5 +
              0.5 *
                Math.sin((dist + roadPhase) * 1.37 + Math.sin((dist + roadPhase) * 0.49) * 2.1));

        if (onBridge) {
          // Crisp bridge roadway lamps strictly centered on bridge deck (zero water bleed)
          const [r, g, b] = sampleNightLightColor(0.46 + hash1D(lampSeq, 773) * 0.34, false);
          points.push({
            x: px,
            z: pz,
            r,
            g,
            b,
            size: 0.72 + hash1D(lampSeq, 787) * 0.22,
            intensity: Math.min(0.92, (0.58 + coreW * 0.26) * Math.max(0.75, roadWeight)),
            category: 'bridge',
          });
          dist += baseLampStepKm * (0.55 + hash1D(lampSeq, 797) * 0.35);
          continue;
        }

        if (inUrban) {
          // Streetlamp bead + occasional paired frontage/building lights hugging the avenue
          const keepStreet = roadWeight >= 0.72 ? 0.92 : roadWeight >= 0.55 ? 0.76 : 0.58;
          if (hash1D(lampSeq, 809) <= keepStreet) {
            const side = hash1D(lampSeq, 811) < 0.5 ? -1 : 1;
            const curbOffset = (0.02 + hash1D(lampSeq, 821) * 0.05) * side;
            const lx = px + nx * curbOffset;
            const lz = pz + nz * curbOffset;
            if (!prep.waterIndex.contains(lx, lz)) {
              const tempRoll = hash1D(lampSeq, 823) * (0.68 + coreW * 0.26) + roadWeight * 0.08;
              const [r, g, b] = sampleNightLightColor(tempRoll, coreW > 0.65 && roadWeight >= 0.85);
              points.push({
                x: lx,
                z: lz,
                r,
                g,
                b,
                size: (0.62 + roadWeight * 0.24) * (0.82 + hash1D(lampSeq, 827) * 0.34),
                intensity: Math.min(
                  0.90,
                  (0.36 + coreW * 0.34 + roadWeight * 0.16) * stretchMod,
                ),
                category: 'road',
              });
            }

            // Flanking urban avenue frontage lights (buildings/shopfronts hugging major streets!)
            if (roadWeight >= 0.65 && hash1D(lampSeq, 829) < 0.42 + coreW * 0.36 && points.length < roadEnd) {
              const fSide = hash1D(lampSeq, 839) < 0.5 ? -1 : 1;
              const fLat = (0.10 + hash1D(lampSeq, 853) * 0.34) * fSide;
              const fAlong = (hash1D(lampSeq, 857) - 0.5) * baseLampStepKm * 0.45;
              const fx = px + nx * fLat + ux * fAlong;
              const fz = pz + nz * fLat + uz * fAlong;
              if (!prep.waterIndex.contains(fx, fz)) {
                const [fr, fg, fb] = sampleNightLightColor(
                  hash1D(lampSeq, 859) * (0.62 + coreW * 0.34),
                  coreW > 0.68,
                );
                points.push({
                  x: fx,
                  z: fz,
                  r: fr,
                  g: fg,
                  b: fb,
                  size: (0.56 + coreW * 0.26) * (0.80 + hash1D(lampSeq, 863) * 0.36),
                  intensity: Math.min(0.84, (0.28 + coreW * 0.38) * stretchMod),
                  category: 'quarter',
                });
              }
            }
          }

          const tierStepMul = roadWeight >= 0.88 ? 0.72 : roadWeight >= 0.72 ? 0.92 : 1.22;
          dist += baseLampStepKm * tierStepMul * (0.55 + hash1D(lampSeq, 877) * 0.92);
          continue;
        }

        // Suburban approach within 3.2 km of an URBAN edge: smooth tapering chain into city
        // Farther out in open countryside: ZERO random stray dots (handled cleanly by road ribbons + real junctions!)
        const distUrban = prep.urbanIndex.minDistanceKm(px, pz, 3.2);
        if (distUrban <= 3.2 && roadWeight >= 0.74) {
          const entryFade = 1.0 - smoothstep(0.0, 3.2, distUrban);
          if (hash1D(lampSeq, 881) < entryFade * entryFade * 0.78) {
            const [r, g, b] = sampleNightLightColor(0.24 + hash1D(lampSeq, 883) * 0.38, false);
            points.push({
              x: px + (hash1D(lampSeq, 887) - 0.5) * 0.05,
              z: pz + (hash1D(lampSeq, 907) - 0.5) * 0.05,
              r,
              g,
              b,
              size: 0.58 + entryFade * 0.18,
              intensity: (0.22 + entryFade * 0.34) * stretchMod,
              category: 'road',
            });
          }
          dist += baseLampStepKm * (0.95 + (1 - entryFade) * 1.1) * (0.65 + hash1D(lampSeq, 911) * 0.75);
        } else {
          // Skip cleanly through dark countryside without emitting stray noise points
          dist += Math.max(1.4, baseLampStepKm * 3.0);
        }
      }
    }
  }

  // --- 4. SATELLITE SETTLEMENTS (Mapped towns without detailed URBAN polygons, e.g. Arzamas) ---
  const settlementEnd = points.length + settlementBudget;
  for (let ci = 0; ci < prep.cityLabels.length && points.length < settlementEnd; ci++) {
    const city = prep.cityLabels[ci];
    // Skip cities already well-covered by explicit URBAN polygons
    if (prep.urbanIndex.contains(city.x, city.z) || prep.urbanIndex.minDistanceKm(city.x, city.z, 2.2) < 2.2) {
      continue;
    }
    if (prep.waterIndex.contains(city.x, city.z)) continue;

    const townRadiusKm = city.isMajor ? 4.8 : city.rank <= 7 ? 3.1 : 2.1;
    const townLights = Math.min(
      settlementEnd - points.length,
      city.isMajor ? 75 : city.rank <= 7 ? 42 : 24,
    );

    const nearRoad = prep.roadIndex.nearestRoad(city.x, city.z, 4.0);
    const axisAng = nearRoad ? Math.atan2(nearRoad.uz, nearRoad.ux) : hash1D(ci + 11, 929) * Math.PI;
    const cosA = Math.cos(axisAng);
    const sinA = Math.sin(axisAng);

    for (let k = 0; k < townLights && points.length < settlementEnd; k++) {
      const hKey = ci * 733 + k * 23;
      // Slightly elongated along the town's main highway axis, denser in the center
      const ang = k * 2.3999632 + hash1D(hKey, 937) * 0.8;
      const rNorm = Math.pow(hash1D(hKey, 941), 1.45);
      const ex = Math.cos(ang) * rNorm * townRadiusKm * 1.25;
      const ez = Math.sin(ang) * rNorm * townRadiusKm * 0.78;
      const lx = city.x + ex * cosA - ez * sinA;
      const lz = city.z + ex * sinA + ez * cosA;

      if (prep.waterIndex.contains(lx, lz)) continue;

      const centerW = 1.0 - rNorm;
      const [r, g, b] = sampleNightLightColor(
        0.18 + hash1D(hKey, 947) * 0.56 + centerW * 0.16,
        city.isMajor && centerW > 0.75,
      );
      points.push({
        x: lx,
        z: lz,
        r,
        g,
        b,
        size: (0.56 + centerW * 0.36) * (0.82 + hash1D(hKey, 953) * 0.34),
        intensity: Math.min(0.84, (0.24 + centerW * 0.44) * (0.76 + hash1D(hKey, 967) * 0.40)),
        category: 'settlement',
      });
    }
  }

  // --- 5. REAL RURAL HIGHWAY INTERCHANGES (Strictly at verified highway-to-highway junctions) ---
  const interchangeEnd = Math.min(maxTotalPoints, points.length + interchangeBudget);
  for (let ji = 0; ji < ruralJunctions.length && points.length < interchangeEnd; ji++) {
    const [jx, jz, jWeight] = ruralJunctions[ji];
    const lamps = 5 + Math.floor(hash1D(ji + 5, 971) * 4);
    for (let k = 0; k < lamps && points.length < interchangeEnd; k++) {
      const hKey = ji * 43 + k * 19;
      const ang = (k / lamps) * Math.PI * 2 + hash1D(hKey, 977) * 0.6;
      const rad = k === 0 ? 0.02 : 0.06 + hash1D(hKey, 983) * 0.24;
      const lx = jx + Math.cos(ang) * rad;
      const lz = jz + Math.sin(ang) * rad;
      if (prep.waterIndex.contains(lx, lz)) continue;

      const isMast = k === 0;
      const [r, g, b] = sampleNightLightColor(
        isMast ? 0.80 + hash1D(hKey, 991) * 0.18 : 0.25 + hash1D(hKey, 997) * 0.46,
        isMast,
      );
      points.push({
        x: lx,
        z: lz,
        r,
        g,
        b,
        size: (isMast ? 0.92 : 0.62) * (0.84 + hash1D(hKey, 1009) * 0.28),
        intensity: Math.min(0.76, (0.34 + jWeight * 0.26) * (isMast ? 1.15 : 0.82)),
        category: 'interchange',
      });
    }
  }

  return points;
}
