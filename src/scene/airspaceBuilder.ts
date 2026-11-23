import * as THREE from 'three';
import type {
  AirspaceDataset,
  AirspaceKind,
  AirspaceVolume,
  BaseMapData,
  RestrictedCircle,
} from '../types/radar';
import { FT_TO_KM, LocalENUProjector } from '../core/geo';
import type { SceneThemePalette } from './themes';
import {
  buildNightCityLightsGroup,
  type NightCityLightsHandle,
} from './nightCityLights';

export interface SectorLabelAnchor {
  id: string;
  name: string;
  frequency?: string;
  kind: AirspaceKind;
  x: number;
  yCeilKm: number;
  z: number;
}


export interface AirspaceSceneHandles {
  root: THREE.Group;
  baseMapGroup: THREE.Group;
  volumesGroup: THREE.Group;
  /** Optional translucent solid walls/caps group (OFF by default for airy wireframe) */
  sectorFillGroup: THREE.Group;
  airwaysGroup: THREE.Group;
  /** Per-runway SID/STAR procedure groups keyed as "18R:SID", "18R:STAR", etc. */
  procedureGroups: Map<string, THREE.Group>;
  restrictedGroup: THREE.Group;
  waypointsGroup: THREE.Group;
  groundGroup: THREE.Group;
  sectorLabelAnchors: SectorLabelAnchor[];
  setVerticalExaggeration: (vex: number) => void;
  setProcedureVisibility: (visMap: Record<string, boolean>, showAirways: boolean) => void;
  setRadarRange: (rangeKm: number) => void;
  setUrbanGlowVisible: (visible: boolean) => void;
  setCityRoadsVisible: (visible: boolean) => void;
  updateWaypointMarkers: (visibleIds: Set<string>, dimmedIds: Set<string>) => void;
  dispose: () => void;
}

/**
 * Build a feather-light airy wireframe 3D airspace volume:
 * - Thin dashed perimeter contours on floor & ceiling (`opacity ~0.22` in dark mode)
 * - Barely-visible vertical corner edges (`opacity ~0.10`)
 * - Optional translucent walls/caps placed in `fillParent` (toggled via Solid Fill option, OFF by default)
 */
function buildVolumeObject(
  vol: AirspaceVolume,
  projector: LocalENUProjector,
  fillHex: number,
  edgeHex: number,
  fillOpacity: number,
  rimOpacity: number,
  pillarOpacity: number,
  renderOrder: number,
  dashed: boolean,
  fillParent: THREE.Group | null,
): {
  wireframeGroup: THREE.Group;
  labelAnchor: SectorLabelAnchor | null;
} {
  const wireframeGroup = new THREE.Group();
  wireframeGroup.name = `vol-${vol.id}`;

  const pts = vol.polygon.map((p) => projector.toENU(p.lat, p.lon, 0));
  if (pts.length < 3) return { wireframeGroup, labelAnchor: null };

  const yFloor = vol.floorFt * FT_TO_KM;
  const yCeil = Math.max(yFloor + 0.15, vol.ceilingFt * FT_TO_KM);

  // Optional Solid Fill (placed in separate group so default view stays 100% crisp airy wireframe)
  if (fillParent) {
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) {
      shape.lineTo(pts[i].x, -pts[i].z);
    }
    shape.closePath();

    const capGeo = new THREE.ShapeGeometry(shape);
    capGeo.rotateX(-Math.PI / 2);

    const fillMat = new THREE.MeshBasicMaterial({
      color: fillHex,
      transparent: true,
      opacity: fillOpacity,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const floorCap = new THREE.Mesh(capGeo, fillMat);
    floorCap.position.y = yFloor + 0.015 * (renderOrder + 1);
    floorCap.renderOrder = renderOrder;
    fillParent.add(floorCap);

    const ceilMat = fillMat.clone();
    ceilMat.opacity = fillOpacity * 0.4;
    const ceilCap = new THREE.Mesh(capGeo, ceilMat);
    ceilCap.position.y = yCeil;
    ceilCap.renderOrder = renderOrder;
    fillParent.add(ceilCap);

    const wallVerts: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      wallVerts.push(
        a.x, yFloor, a.z,
        b.x, yFloor, b.z,
        b.x, yCeil, b.z,
        a.x, yFloor, a.z,
        b.x, yCeil, b.z,
        a.x, yCeil, a.z,
      );
    }
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallVerts, 3));
    const wallMat = new THREE.MeshBasicMaterial({
      color: fillHex,
      transparent: true,
      opacity: fillOpacity * 0.72,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);
    wallMesh.renderOrder = renderOrder;
    fillParent.add(wallMesh);
  }

  // Thin dashed upper & lower perimeter outlines (strictly NormalBlending, depthWrite: false, calm non-bloom RGB)
  const floorLoopPts = pts.map((p) => new THREE.Vector3(p.x, yFloor + 0.025, p.z));
  floorLoopPts.push(floorLoopPts[0].clone());
  const ceilLoopPts = pts.map((p) => new THREE.Vector3(p.x, yCeil, p.z));
  ceilLoopPts.push(ceilLoopPts[0].clone());

  const dashScale = vol.kind === 'FIR' ? 5.5 : vol.kind === 'APP' ? 3.4 : 2.1;
  const rimMat = dashed
    ? new THREE.LineDashedMaterial({
        color: edgeHex,
        dashSize: dashScale,
        gapSize: dashScale * 0.78,
        transparent: true,
        opacity: rimOpacity,
        blending: THREE.NormalBlending,
        depthWrite: false,
      })
    : new THREE.LineBasicMaterial({
        color: edgeHex,
        transparent: true,
        opacity: rimOpacity,
        blending: THREE.NormalBlending,
        depthWrite: false,
      });

  const floorLineGeo = new THREE.BufferGeometry().setFromPoints(floorLoopPts);
  const floorLine = new THREE.Line(floorLineGeo, rimMat);
  if (dashed) floorLine.computeLineDistances();
  floorLine.renderOrder = renderOrder + 1;
  wireframeGroup.add(floorLine);

  const ceilLineGeo = new THREE.BufferGeometry().setFromPoints(ceilLoopPts);
  const ceilLine = new THREE.Line(ceilLineGeo, rimMat);
  if (dashed) ceilLine.computeLineDistances();
  ceilLine.renderOrder = renderOrder + 1;
  wireframeGroup.add(ceilLine);

  // Sharp-corner-only vertical seams (turn angle > 30 deg AND spacing >= 18 km; eliminates vertical fence bars on curves!)
  const pillarVerts: number[] = [];
  const cos30 = Math.cos((30 * Math.PI) / 180);
  const minPillarSpacingKm = vol.kind === 'CTR' ? 12 : 18;
  let distSinceLast = minPillarSpacingKm;
  let placedCount = 0;

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const curr = pts[i];
    const next = pts[(i + 1) % pts.length];

    const e1x = curr.x - prev.x;
    const e1z = curr.z - prev.z;
    const e2x = next.x - curr.x;
    const e2z = next.z - curr.z;
    const l1 = Math.hypot(e1x, e1z);
    const l2 = Math.hypot(e2x, e2z);
    distSinceLast += l1;

    if (l1 > 1e-4 && l2 > 1e-4) {
      const cosTurn = (e1x * e2x + e1z * e2z) / (l1 * l2);
      // Sharp corner (> 30 deg bend) spaced at least 18 km (12 km for small CTR)
      if (cosTurn < cos30 && distSinceLast >= minPillarSpacingKm && placedCount < 10) {
        pillarVerts.push(curr.x, yFloor + 0.025, curr.z, curr.x, yCeil, curr.z);
        distSinceLast = 0;
        placedCount++;
      }
    }
  }
  const pillarGeo = new THREE.BufferGeometry();
  pillarGeo.setAttribute('position', new THREE.Float32BufferAttribute(pillarVerts, 3));
  const pillarMat = new THREE.LineBasicMaterial({
    color: edgeHex,
    transparent: true,
    opacity: pillarOpacity,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  const pillars = new THREE.LineSegments(pillarGeo, pillarMat);
  pillars.renderOrder = renderOrder;
  wireframeGroup.add(pillars);

  // Distinct boundary anchor for floating WebGL sector label
  let labelAnchor: SectorLabelAnchor | null = null;
  if (vol.kind !== 'RESTRICTED') {
    let targetIdx = 0;
    if (vol.kind === 'CTR') {
      let bestZ = Infinity;
      pts.forEach((p, idx) => {
        if (p.z < bestZ) {
          bestZ = p.z;
          targetIdx = idx;
        }
      });
    } else if (vol.kind === 'TMA') {
      let bestScore = -Infinity;
      pts.forEach((p, idx) => {
        const s = -p.x - p.z * 0.9;
        if (s > bestScore) {
          bestScore = s;
          targetIdx = idx;
        }
      });
    } else if (vol.kind === 'APP') {
      let bestScore = -Infinity;
      pts.forEach((p, idx) => {
        const s = p.x - p.z;
        if (s > bestScore) {
          bestScore = s;
          targetIdx = idx;
        }
      });
    } else {
      let sumX = 0;
      let sumZ = 0;
      pts.forEach((p) => {
        sumX += p.x;
        sumZ += p.z;
      });
      labelAnchor = {
        id: vol.id,
        name: vol.name,
        frequency: vol.frequency,
        kind: vol.kind,
        x: (sumX / pts.length) * 0.52,
        yCeilKm: Math.min(yCeil, 10.5),
        z: (sumZ / pts.length) * 0.52,
      };
    }

    if (!labelAnchor) {
      const p = pts[targetIdx];
      labelAnchor = {
        id: vol.id,
        name: vol.name,
        frequency: vol.frequency,
        kind: vol.kind,
        x: p.x,
        yCeilKm: yCeil,
        z: p.z,
      };
    }
  }

  return {
    wireframeGroup,
    labelAnchor,
  };
}

function buildRestrictedCircle(
  circle: RestrictedCircle,
  projector: LocalENUProjector,
  palette: SceneThemePalette,
): THREE.Group {
  const group = new THREE.Group();
  const center = projector.toENU(circle.center.lat, circle.center.lon, 0);
  const yFloor = circle.floorFt * FT_TO_KM;
  const yCeil = Math.max(yFloor + 0.3, circle.ceilingFt * FT_TO_KM);

  const segs = 32;
  const ringVerts: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const x0 = center.x + Math.cos(a0) * circle.radiusKm;
    const z0 = center.z + Math.sin(a0) * circle.radiusKm;
    const x1 = center.x + Math.cos(a1) * circle.radiusKm;
    const z1 = center.z + Math.sin(a1) * circle.radiusKm;
    ringVerts.push(x0, yFloor + 0.04, z0, x1, yFloor + 0.04, z1);
    ringVerts.push(x0, yCeil, z0, x1, yCeil, z1);
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringVerts, 3));
  const ringMat = new THREE.LineBasicMaterial({
    color: palette.restrictedEdgeHex,
    transparent: true,
    opacity: palette.isDark ? 0.34 : 0.72,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  const ringSegs = new THREE.LineSegments(ringGeo, ringMat);
  ringSegs.renderOrder = 7;
  group.add(ringSegs);

  return group;
}

function buildSkyDome(palette: SceneThemePalette): THREE.Mesh {
  const skyGeo = new THREE.SphereGeometry(1650, 32, 20);
  const horizonCol = new THREE.Color(palette.isDark ? 0x0b121e : 0x9aa0a7);
  const midSkyCol = new THREE.Color(palette.isDark ? 0x060b14 : 0xaab2bc);
  const zenithCol = new THREE.Color(palette.isDark ? 0x030509 : 0xbfc7d1);
  const glowCol = new THREE.Color(palette.isDark ? 0x162842 : 0xb8c0ca);

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uHorizon: { value: horizonCol },
      uMidSky: { value: midSkyCol },
      uZenith: { value: zenithCol },
      uGlow: { value: glowCol },
      uGlowStrength: { value: palette.isDark ? 0.22 : 0.08 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldDir;
      void main() {
        vWorldDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uMidSky;
      uniform vec3 uZenith;
      uniform vec3 uGlow;
      uniform float uGlowStrength;
      varying vec3 vWorldDir;

      void main() {
        float h = clamp(vWorldDir.y, 0.0, 1.0);
        // Below horizon stays seamlessly locked to fog/horizon color
        vec3 col = mix(uHorizon, uMidSky, smoothstep(0.0, 0.22, h));
        col = mix(col, uZenith, smoothstep(0.18, 0.78, h));
        // Subtle atmospheric rim glow right at the horizon band
        float horizonBand = exp(-abs(vWorldDir.y) * 10.5);
        col += uGlow * (horizonBand * uGlowStrength);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });

  const dome = new THREE.Mesh(skyGeo, skyMat);
  dome.name = 'sky-dome';
  dome.renderOrder = -20;
  return dome;
}

function createTerrainSurfaceMaterial(
  surfaceHex: number,
  horizonHex: number,
  sharedRadarRangeUniform: { value: number },
  fadeStartRatio = 0.75,
  usePolygonOffset = true,
  fadeAlpha = true,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: fadeAlpha,
    depthWrite: !fadeAlpha,
    fog: false,
    polygonOffset: usePolygonOffset,
    polygonOffsetFactor: usePolygonOffset ? -1 : 0,
    polygonOffsetUnits: usePolygonOffset ? -1 : 0,
    uniforms: {
      uCenterColor: { value: new THREE.Color(surfaceHex) },
      uHorizonColor: { value: new THREE.Color(horizonHex) },
      uRadarRange: sharedRadarRangeUniform,
      uFadeStartRatio: { value: fadeStartRatio },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vXZ = worldPos.xz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenterColor;
      uniform vec3 uHorizonColor;
      uniform float uRadarRange;
      uniform float uFadeStartRatio;
      varying vec2 vXZ;

      void main() {
        float r = length(vXZ);
        float blend = smoothstep(uRadarRange * uFadeStartRatio, uRadarRange, r);
        vec3 col = mix(uCenterColor, uHorizonColor, blend);
        float alpha = 1.0 - blend;
        if (alpha < 0.005) discard;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

function createRadialFadeLineMaterial(
  colorHex: number,
  opacity: number,
  sharedRadarRangeUniform: { value: number },
  fadeStartRatio = 0.75,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uOpacity: { value: opacity },
      uRadarRange: sharedRadarRangeUniform,
      uFadeStartRatio: { value: fadeStartRatio },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vXZ = worldPos.xz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uRadarRange;
      uniform float uFadeStartRatio;
      varying vec2 vXZ;

      void main() {
        float r = length(vXZ);
        float radialFade = 1.0 - smoothstep(uRadarRange * uFadeStartRatio, uRadarRange, r);
        float alpha = uOpacity * radialFade;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

function mergeTrianglePositions(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  let totalVerts = 0;
  for (const g of geos) {
    const pos = g.getAttribute('position');
    if (!pos) continue;
    const idx = g.getIndex();
    totalVerts += idx ? idx.count : pos.count;
  }
  if (totalVerts === 0) return null;

  const merged = new Float32Array(totalVerts * 3);
  let offset = 0;
  for (const g of geos) {
    const pos = g.getAttribute('position');
    if (!pos) continue;
    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        const vi = idx.getX(i);
        merged[offset++] = pos.getX(vi);
        merged[offset++] = pos.getY(vi);
        merged[offset++] = pos.getZ(vi);
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        merged[offset++] = pos.getX(i);
        merged[offset++] = pos.getY(i);
        merged[offset++] = pos.getZ(i);
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(merged, 3));
  return out;
}

function buildBaseMapGroup(
  baseMap: BaseMapData | undefined,
  projector: LocalENUProjector,
  palette: SceneThemePalette,
  sharedRadarRangeUniform: { value: number },
  initialShowUrbanGlow = true,
  initialShowCityRoads = true,
): {
  group: THREE.Group;
  urbanLightsHandle: NightCityLightsHandle | null;
  roadsObject: THREE.LineSegments | null;
} {
  const group = new THREE.Group();
  group.name = 'geographic-base-map';
  if (!baseMap) return { group, urbanLightsHandle: null, roadsObject: null };

  const waterGeos: THREE.BufferGeometry[] = [];
  const landGeos: THREE.BufferGeometry[] = [];

  for (const poly of baseMap.polygons) {
    // URBAN built-up zones are rasterized smoothly via buildUrbanFabricMesh instead of hard meshes
    if (poly.kind === 'URBAN' || poly.points.length < 3) continue;
    const pts = poly.points.map((p) => projector.toENU(p.lat, p.lon, 0));
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) {
      shape.lineTo(pts[i].x, -pts[i].z);
    }
    shape.closePath();

    // Attach polygon holes (e.g. islands inside lakes or reservoirs)
    if (poly.holes && poly.holes.length > 0) {
      for (const holeRing of poly.holes) {
        if (holeRing.length < 3) continue;
        const hPts = holeRing.map((p) => projector.toENU(p.lat, p.lon, 0));
        const holePath = new THREE.Path();
        holePath.moveTo(hPts[0].x, -hPts[0].z);
        for (let i = 1; i < hPts.length; i++) {
          holePath.lineTo(hPts[i].x, -hPts[i].z);
        }
        holePath.closePath();
        shape.holes.push(holePath);
      }
    }

    try {
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      if (poly.kind === 'WATER') {
        waterGeos.push(geo);
      } else {
        landGeos.push(geo);
      }
    } catch {
      // Skip degenerate self-intersecting rings cleanly
    }
  }

  // Merge static land & water polygons into 1 draw call per layer
  const mergedLandGeo = mergeTrianglePositions(landGeos);
  landGeos.forEach((g) => g.dispose());
  if (mergedLandGeo) {
    const landMat = createTerrainSurfaceMaterial(
      palette.mapLandHex,
      palette.fogHex,
      sharedRadarRangeUniform,
      0.75,
      true,
      true,
    );
    const landMesh = new THREE.Mesh(mergedLandGeo, landMat);
    landMesh.name = 'basemap-land-polygons';
    landMesh.position.y = 0.01;
    landMesh.renderOrder = -4;
    group.add(landMesh);
  }

  // 3-layer nocturnal aerial city lighting (atmospheric skyglow + continuous road/bridge filaments + pinpoint stars)
  const urbanLightsHandle = buildNightCityLightsGroup(
    baseMap,
    projector,
    palette,
    sharedRadarRangeUniform,
    initialShowUrbanGlow,
    initialShowCityRoads,
  );
  if (urbanLightsHandle) {
    group.add(urbanLightsHandle.group);
  }

  const mergedWaterGeo = mergeTrianglePositions(waterGeos);
  waterGeos.forEach((g) => g.dispose());
  if (mergedWaterGeo) {
    const waterMat = createTerrainSurfaceMaterial(
      palette.mapWaterHex,
      palette.fogHex,
      sharedRadarRangeUniform,
      0.75,
      true,
      true,
    );
    const waterMesh = new THREE.Mesh(mergedWaterGeo, waterMat);
    waterMesh.name = 'basemap-water-polygons';
    waterMesh.position.y = 0.045;
    waterMesh.renderOrder = -2;
    group.add(waterMesh);
  }

  // Borderless fills for cities & water: render subtle road vectors (`ROAD`), borders, and dark water rivers
  const roadVerts: number[] = [];
  const riverVerts: number[] = [];
  const boundaryVerts: number[] = [];

  for (const line of baseMap.polylines) {
    if (line.points.length < 2) continue;
    if (line.kind !== 'RIVER' && line.kind !== 'BOUNDARY' && line.kind !== 'ROAD') continue;
    const target =
      line.kind === 'ROAD' ? roadVerts : line.kind === 'RIVER' ? riverVerts : boundaryVerts;
    const y = line.kind === 'ROAD' ? 0.036 : line.kind === 'RIVER' ? 0.058 : 0.065;

    let prev = projector.toENU(line.points[0].lat, line.points[0].lon, 0);
    for (let i = 1; i < line.points.length; i++) {
      const curr = projector.toENU(line.points[i].lat, line.points[i].lon, 0);
      target.push(prev.x, y, prev.z, curr.x, y, curr.z);
      prev = curr;
    }
  }

  let roadsObject: THREE.LineSegments | null = null;
  if (roadVerts.length > 0) {
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadVerts, 3));
    const roadMat = createRadialFadeLineMaterial(
      palette.mapRoadHex,
      palette.isDark ? 0.018 : 0.16,
      sharedRadarRangeUniform,
      0.72,
    );
    roadsObject = new THREE.LineSegments(roadGeo, roadMat);
    roadsObject.name = 'basemap-city-roads';
    roadsObject.renderOrder = -1;
    roadsObject.visible = initialShowCityRoads;
    group.add(roadsObject);
  }

  if (boundaryVerts.length > 0) {
    const boundaryGeo = new THREE.BufferGeometry();
    boundaryGeo.setAttribute('position', new THREE.Float32BufferAttribute(boundaryVerts, 3));
    const boundaryMat = createRadialFadeLineMaterial(
      palette.mapBoundaryHex,
      palette.isDark ? 0.42 : 0.38,
      sharedRadarRangeUniform,
      0.75,
    );
    const boundaryLines = new THREE.LineSegments(boundaryGeo, boundaryMat);
    boundaryLines.name = 'basemap-boundaries';
    boundaryLines.renderOrder = 0;
    group.add(boundaryLines);
  }

  if (riverVerts.length > 0) {
    const riverGeo = new THREE.BufferGeometry();
    riverGeo.setAttribute('position', new THREE.Float32BufferAttribute(riverVerts, 3));
    const riverMat = createRadialFadeLineMaterial(
      palette.mapRiverHex,
      palette.isDark ? 0.85 : 0.65,
      sharedRadarRangeUniform,
      0.75,
    );
    const riverLines = new THREE.LineSegments(riverGeo, riverMat);
    riverLines.name = 'basemap-rivers';
    riverLines.renderOrder = 1;
    group.add(riverLines);
  }

  return { group, urbanLightsHandle, roadsObject };
}

function buildGroundPlane(
  palette: SceneThemePalette,
  sharedRadarRangeUniform: { value: number },
  waterBase = false,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'tactical-ground';

  // Seamless radial Fog-of-War ground disc dissolving into SkyDome horizon color (#0b121e) across 75%..100% of Radar Range
  const planeGeo = new THREE.CircleGeometry(960, 72);
  planeGeo.rotateX(-Math.PI / 2);
  const centerHex = waterBase ? palette.mapWaterHex : palette.groundHex;
  const planeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    fog: false,
    uniforms: {
      uCenterColor: { value: new THREE.Color(centerHex) },
      uHorizonColor: { value: new THREE.Color(palette.fogHex) },
      uRadarRange: sharedRadarRangeUniform,
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vXZ = worldPos.xz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenterColor;
      uniform vec3 uHorizonColor;
      uniform float uRadarRange;
      varying vec2 vXZ;

      void main() {
        float r = length(vXZ);
        float blend = smoothstep(uRadarRange * 0.72, uRadarRange, r);
        vec3 col = mix(uCenterColor, uHorizonColor, blend);
        float alpha = 1.0 - smoothstep(uRadarRange * 0.84, uRadarRange * 1.06, r);
        if (alpha < 0.005) discard;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
  const planeMesh = new THREE.Mesh(planeGeo, planeMat);
  planeMesh.position.y = -0.05;
  planeMesh.renderOrder = -6;
  group.add(planeMesh);

  const ringRadii = [25, 50, 100, 150, 200, 250];
  const ringVerts: number[] = [];
  const segs = 96;
  for (const r of ringRadii) {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      ringVerts.push(
        Math.cos(a0) * r, 0.095, Math.sin(a0) * r,
        Math.cos(a1) * r, 0.095, Math.sin(a1) * r,
      );
    }
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ringVerts.push(
      Math.cos(a) * 10, 0.095, Math.sin(a) * 10,
      Math.cos(a) * 260, 0.095, Math.sin(a) * 260,
    );
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringVerts, 3));
  const ringMat = createRadialFadeLineMaterial(
    palette.gridMajorHex,
    palette.gridOpacity * 0.65,
    sharedRadarRangeUniform,
    0.75,
  );
  group.add(new THREE.LineSegments(ringGeo, ringMat));

  return group;
}

/**
 * Build the complete 3D airspace scene with feather-light dashed wireframe sectors
 * (optional Solid Fill off by default), per-runway SID/STAR groups, and dynamic active sector highlighting.
 */
export function buildAirspaceScene(
  dataset: AirspaceDataset,
  projector: LocalENUProjector,
  palette: SceneThemePalette,
  initialVerticalExaggeration: number,
  showSectorFill = false,
  initialRadarRangeKm = 150,
  initialShowUrbanGlow = true,
  initialShowCityRoads = true,
): AirspaceSceneHandles {
  const root = new THREE.Group();
  root.name = 'airspace-root';

  const sharedRadarRangeUniform = { value: Math.max(40, initialRadarRangeKm) };

  const skyDome = buildSkyDome(palette);
  root.add(skyDome);

  const groundGroup = buildGroundPlane(
    palette,
    sharedRadarRangeUniform,
    Boolean(dataset.baseMap?.waterBase),
  );
  root.add(groundGroup);

  const { group: baseMapGroup, urbanLightsHandle, roadsObject } = buildBaseMapGroup(
    dataset.baseMap,
    projector,
    palette,
    sharedRadarRangeUniform,
    initialShowUrbanGlow,
    initialShowCityRoads,
  );
  root.add(baseMapGroup);

  const volumesGroup = new THREE.Group();
  volumesGroup.name = 'airspace-volumes';
  root.add(volumesGroup);

  const sectorFillGroup = new THREE.Group();
  sectorFillGroup.name = 'airspace-sector-fills';
  sectorFillGroup.visible = showSectorFill;
  volumesGroup.add(sectorFillGroup);

  const restrictedGroup = new THREE.Group();
  restrictedGroup.name = 'restricted-zones';
  root.add(restrictedGroup);

  const airwaysGroup = new THREE.Group();
  airwaysGroup.name = 'airways-and-procedures';
  root.add(airwaysGroup);

  const waypointsGroup = new THREE.Group();
  waypointsGroup.name = 'waypoints';
  root.add(waypointsGroup);

  const sectorLabelAnchors: SectorLabelAnchor[] = [];

  // 1. Calm Non-Bloom Wireframe 3D Airspace Volumes (strictly NormalBlending, renderOrder 4..6, constant opacity)
  dataset.volumes.forEach((vol) => {
    let fillHex = palette.appFillHex;
    let edgeHex = palette.appEdgeHex;
    let fillOp = palette.appFillOpacity;
    let rimOp = palette.isDark ? 0.16 : 0.45;
    let pillarOp = palette.isDark ? 0.08 : 0.18;
    let order = 4;

    if (vol.kind === 'FIR') {
      fillHex = palette.firFillHex;
      edgeHex = palette.firEdgeHex;
      fillOp = palette.firFillOpacity;
      rimOp = palette.isDark ? 0.13 : 0.34;
      pillarOp = palette.isDark ? 0.06 : 0.12;
      order = 4;
    } else if (vol.kind === 'APP') {
      fillHex = palette.appFillHex;
      edgeHex = palette.appEdgeHex;
      fillOp = palette.appFillOpacity;
      rimOp = palette.isDark ? 0.16 : 0.48;
      pillarOp = palette.isDark ? 0.07 : 0.16;
      order = 4;
    } else if (vol.kind === 'TMA') {
      fillHex = palette.tmaFillHex;
      edgeHex = palette.tmaEdgeHex;
      fillOp = palette.tmaFillOpacity;
      rimOp = palette.isDark ? 0.17 : 0.56;
      pillarOp = palette.isDark ? 0.08 : 0.18;
      order = 5;
    } else if (vol.kind === 'CTR') {
      fillHex = palette.ctrFillHex;
      edgeHex = palette.ctrEdgeHex;
      fillOp = palette.ctrFillOpacity;
      rimOp = palette.isDark ? 0.19 : 0.62;
      pillarOp = palette.isDark ? 0.09 : 0.2;
      order = 5;
    }

    const built = buildVolumeObject(
      vol,
      projector,
      fillHex,
      edgeHex,
      fillOp,
      rimOp,
      pillarOp,
      order,
      true,
      sectorFillGroup,
    );
    volumesGroup.add(built.wireframeGroup);
    if (built.labelAnchor) {
      sectorLabelAnchors.push(built.labelAnchor);
    }
  });

  // 2. Restricted / Prohibited Zones (calm wireframe outlines, renderOrder 6..7)
  dataset.restrictedZones.forEach((zone) => {
    const built = buildVolumeObject(
      zone,
      projector,
      palette.restrictedFillHex,
      palette.restrictedEdgeHex,
      palette.restrictedFillOpacity,
      palette.isDark ? 0.34 : 0.68,
      palette.isDark ? 0.14 : 0.24,
      6,
      false,
      null,
    );
    restrictedGroup.add(built.wireframeGroup);
  });

  dataset.restrictedCircles.forEach((circle) => {
    restrictedGroup.add(buildRestrictedCircle(circle, projector, palette));
  });

  // 3. Airways, Per-Runway SID/STAR Groups, Glowing Runways, and ILS Approach Axes
  const dashedMat = new THREE.LineDashedMaterial({
    color: palette.airwayHex,
    dashSize: 2.2,
    gapSize: 1.8,
    transparent: true,
    opacity: palette.isDark ? 0.32 : palette.airwayOpacity,
  });

  const sidMat = new THREE.LineBasicMaterial({
    color: palette.isDark ? 0x38bdf8 : 0x0284c7,
    transparent: true,
    opacity: palette.isDark ? 0.38 : 0.68,
  });

  const starMat = new THREE.LineBasicMaterial({
    color: palette.isDark ? 0xf59e0b : 0xb45309,
    transparent: true,
    opacity: palette.isDark ? 0.36 : 0.65,
  });

  const approachAxisMat = new THREE.LineDashedMaterial({
    color: palette.approachAxisHex,
    dashSize: 1.4,
    gapSize: 1.0,
    transparent: true,
    opacity: palette.approachAxisOpacity,
  });

  const runwayCoreMat = new THREE.MeshBasicMaterial({
    color: palette.runwayHex,
  });
  const runwayGlowMat = new THREE.MeshBasicMaterial({
    color: palette.runwayGlowHex,
    transparent: true,
    opacity: palette.isDark ? 0.24 : 0.14,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });

  const procedureGroups = new Map<string, THREE.Group>();
  const getOrCreateProcGroup = (key: string): THREE.Group => {
    let g = procedureGroups.get(key);
    if (!g) {
      g = new THREE.Group();
      g.name = `proc-group-${key}`;
      airwaysGroup.add(g);
      procedureGroups.set(key, g);
    }
    return g;
  };

  for (const seg of dataset.airways) {
    if (seg.points.length < 2) continue;
    const pts3 = seg.points.map((p) => {
      const enu = projector.toENU(p.lat, p.lon, 0);
      const y = seg.kind === 'APPROACH_AXIS' ? 0.16 : seg.kind === 'AIRWAY' ? 0.12 : 0.18;
      return new THREE.Vector3(enu.x, y, enu.z);
    });

    if (seg.kind === 'RUNWAY') {
      const p0 = pts3[0];
      const p1 = pts3[1];
      const len = p0.distanceTo(p1);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);

      const rwyGeo = new THREE.BoxGeometry(0.36, 0.06, Math.max(2.5, len));
      const rwyMesh = new THREE.Mesh(rwyGeo, runwayCoreMat);
      rwyMesh.position.set(mid.x, 0.11, mid.z);
      rwyMesh.rotation.y = yaw;
      rwyMesh.renderOrder = 14;
      airwaysGroup.add(rwyMesh);

      const glowGeo = new THREE.PlaneGeometry(0.95, Math.max(3.0, len + 0.6));
      glowGeo.rotateX(-Math.PI / 2);
      const glowMesh = new THREE.Mesh(glowGeo, runwayGlowMat);
      glowMesh.position.set(mid.x, 0.095, mid.z);
      glowMesh.rotation.y = yaw;
      glowMesh.renderOrder = 13;
      airwaysGroup.add(glowMesh);
    } else if (seg.kind === 'APPROACH_AXIS') {
      const geo = new THREE.BufferGeometry().setFromPoints(pts3);
      const line = new THREE.Line(geo, approachAxisMat);
      line.computeLineDistances();
      line.renderOrder = 11;
      airwaysGroup.add(line);
    } else if (seg.kind === 'AIRWAY') {
      const geo = new THREE.BufferGeometry().setFromPoints(pts3);
      const line = new THREE.Line(geo, dashedMat);
      line.computeLineDistances();
      line.renderOrder = 8;
      airwaysGroup.add(line);
    } else {
      // SID_STAR grouped cleanly by (runway, procedureType)
      const rwyKey = seg.runway || 'ALL';
      const procType = seg.procedureType || 'SID';
      const groupKey = `${rwyKey}:${procType}`;
      const targetGroup = getOrCreateProcGroup(groupKey);
      const geo = new THREE.BufferGeometry().setFromPoints(pts3);
      const line = new THREE.Line(geo, procType === 'STAR' ? starMat : sidMat);
      line.renderOrder = 9;
      targetGroup.add(line);
    }
  }

  // 4. Waypoints (Compact 4-point star outline markers split into Bright & Dimmed buffers for instant filter/LOD updates)
  const rOut = 0.85;
  const rIn = 0.28;
  const starPts: Array<[number, number]> = [
    [0, -rOut],
    [rIn, -rIn],
    [rOut, 0],
    [rIn, rIn],
    [0, rOut],
    [-rIn, rIn],
    [-rOut, 0],
    [-rIn, -rIn],
  ];
  const VERTS_PER_STAR = starPts.length * 2; // 16 vertices per waypoint
  const precomputedStars = dataset.waypoints.map((wp) => {
    const enu = projector.toENU(wp.lat, wp.lon, 0);
    const arr = new Float32Array(VERTS_PER_STAR * 3);
    const y = 0.2;
    let o = 0;
    for (let i = 0; i < starPts.length; i++) {
      const a = starPts[i];
      const b = starPts[(i + 1) % starPts.length];
      arr[o++] = enu.x + a[0];
      arr[o++] = y;
      arr[o++] = enu.z + a[1];
      arr[o++] = enu.x + b[0];
      arr[o++] = y;
      arr[o++] = enu.z + b[1];
    }
    return { id: wp.id, verts: arr };
  });

  const maxWpVerts = Math.max(1, precomputedStars.length) * VERTS_PER_STAR;
  const brightBuf = new Float32Array(maxWpVerts * 3);
  const dimmedBuf = new Float32Array(maxWpVerts * 3);

  const brightWpGeo = new THREE.BufferGeometry();
  const brightWpAttr = new THREE.BufferAttribute(brightBuf, 3);
  brightWpGeo.setAttribute('position', brightWpAttr);
  brightWpGeo.setDrawRange(0, 0);
  const brightWpMat = createRadialFadeLineMaterial(
    palette.waypointHex,
    palette.isDark ? 0.62 : 0.78,
    sharedRadarRangeUniform,
    0.75,
  );
  const brightWpLines = new THREE.LineSegments(brightWpGeo, brightWpMat);
  brightWpLines.frustumCulled = false;
  brightWpLines.renderOrder = 10;
  waypointsGroup.add(brightWpLines);

  const dimmedWpGeo = new THREE.BufferGeometry();
  const dimmedWpAttr = new THREE.BufferAttribute(dimmedBuf, 3);
  dimmedWpGeo.setAttribute('position', dimmedWpAttr);
  dimmedWpGeo.setDrawRange(0, 0);
  const dimmedWpMat = createRadialFadeLineMaterial(
    palette.waypointHex,
    palette.isDark ? 0.24 : 0.34,
    sharedRadarRangeUniform,
    0.75,
  );
  const dimmedWpLines = new THREE.LineSegments(dimmedWpGeo, dimmedWpMat);
  dimmedWpLines.frustumCulled = false;
  dimmedWpLines.renderOrder = 9;
  waypointsGroup.add(dimmedWpLines);

  const updateWaypointMarkers = (visibleIds: Set<string>, dimmedIds: Set<string>) => {
    let bVerts = 0;
    let dVerts = 0;
    for (let i = 0; i < precomputedStars.length; i++) {
      const item = precomputedStars[i];
      if (!visibleIds.has(item.id)) continue;
      if (dimmedIds.has(item.id)) {
        dimmedBuf.set(item.verts, dVerts * 3);
        dVerts += VERTS_PER_STAR;
      } else {
        brightBuf.set(item.verts, bVerts * 3);
        bVerts += VERTS_PER_STAR;
      }
    }
    brightWpAttr.needsUpdate = true;
    brightWpGeo.setDrawRange(0, bVerts);
    dimmedWpAttr.needsUpdate = true;
    dimmedWpGeo.setDrawRange(0, dVerts);
  };

  // Seed initial markers so first render shows all until syncToCamera filters them
  updateWaypointMarkers(new Set(dataset.waypoints.map((w) => w.id)), new Set());

  const setVerticalExaggeration = (vex: number) => {
    volumesGroup.scale.y = vex;
    restrictedGroup.scale.y = vex;
  };
  setVerticalExaggeration(initialVerticalExaggeration);

  const setProcedureVisibility = (visMap: Record<string, boolean>, showAirways: boolean) => {
    airwaysGroup.visible = showAirways;
    for (const [key, grp] of procedureGroups.entries()) {
      const enabled = visMap[key] !== false;
      grp.visible = enabled;
    }
  };

  const setRadarRange = (rangeKm: number) => {
    sharedRadarRangeUniform.value = Math.max(40, rangeKm);
  };

  const setUrbanGlowVisible = (visible: boolean) => {
    if (urbanLightsHandle) {
      urbanLightsHandle.group.visible = visible;
    }
  };

  const setCityRoadsVisible = (visible: boolean) => {
    if (roadsObject) {
      roadsObject.visible = visible;
    }
    if (urbanLightsHandle) {
      urbanLightsHandle.setRoadsVisible(visible);
    }
  };

  const dispose = () => {
    const disposedGeos = new Set<THREE.BufferGeometry>();
    const disposedMats = new Set<THREE.Material>();
    root.traverse((obj) => {
      if (obj.userData?.disposeTexture && typeof obj.userData.disposeTexture.dispose === 'function') {
        obj.userData.disposeTexture.dispose();
      }
      if ((obj as THREE.Mesh).geometry && !disposedGeos.has((obj as THREE.Mesh).geometry)) {
        disposedGeos.add((obj as THREE.Mesh).geometry);
        (obj as THREE.Mesh).geometry.dispose();
      }
      const mat = (obj as THREE.Mesh).material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => {
          if (!disposedMats.has(m)) {
            disposedMats.add(m);
            m.dispose();
          }
        });
      } else if (mat && !disposedMats.has(mat)) {
        disposedMats.add(mat);
        mat.dispose();
      }
    });
  };

  return {
    root,
    baseMapGroup,
    volumesGroup,
    sectorFillGroup,
    airwaysGroup,
    procedureGroups,
    restrictedGroup,
    waypointsGroup,
    groundGroup,
    sectorLabelAnchors,
    setVerticalExaggeration,
    setProcedureVisibility,
    setRadarRange,
    setUrbanGlowVisible,
    setCityRoadsVisible,
    updateWaypointMarkers,
    dispose,
  };
}
