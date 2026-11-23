import * as THREE from 'three';
import type {
  AircraftTrack,
  AirspaceVolume,
  InterpolatedAircraftState,
  TrailStyle,
} from '../types/radar';
import { LocalENUProjector } from '../core/geo';
import { getSectorControlColorHex, resolveAircraftController } from '../core/airspaceZones';
import { sampleTrailPoints } from '../core/trajectory';
import type { SceneThemePalette } from './themes';

const MAX_TRAIL_SAMPLES = 60;
const MAX_TICKS = 22;

const _segColor = new THREE.Color();
const _tmpColor = new THREE.Color();
const _selectedColor = new THREE.Color();

/**
 * Camera-Facing Billboard Ribbon Vertex Shader.
 * Expands ribbon width along `normalize(cross(aTangent, viewDirection))` in world space
 * so steep climbs/descents NEVER twist into paper-thin edges at any pitch or camera angle.
 */
const RIBBON_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aTangent;
  attribute float aSide;
  attribute float aWidth;
  attribute float aAge;
  attribute vec3 aColor;

  varying vec2 vUv;
  varying float vAge;
  varying vec3 vColor;
  varying vec2 vWorldXZ;

  void main() {
    vUv = vec2(aAge, aSide * 0.5 + 0.5);
    vAge = aAge;
    vColor = aColor;

    vec4 worldCenter = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldCenter.xz;
    vec3 worldTangent = normalize(mat3(modelMatrix) * aTangent);
    vec3 viewDir = normalize(cameraPosition - worldCenter.xyz);

    vec3 sideVec = cross(worldTangent, viewDir);
    float sideLen = length(sideVec);
    if (sideLen < 0.0005) {
      sideVec = cross(worldTangent, vec3(0.0, 1.0, 0.0));
      sideLen = length(sideVec);
      if (sideLen < 0.0005) {
        sideVec = vec3(1.0, 0.0, 0.0);
      } else {
        sideVec /= sideLen;
      }
    } else {
      sideVec /= sideLen;
    }

    vec3 displacedWorld = worldCenter.xyz + sideVec * (aSide * aWidth);
    gl_Position = projectionMatrix * viewMatrix * vec4(displacedWorld, 1.0);
  }
`;

/**
 * Soft-Edge Luminous Ribbon Fragment Shader with Radial Fog-of-War fade (80%..100% of uRadarRange).
 */
const RIBBON_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  uniform float uFade;
  uniform float uIsDark;
  uniform float uRadarRange;

  varying vec2 vUv;
  varying float vAge;
  varying vec3 vColor;
  varying vec2 vWorldXZ;

  void main() {
    float crossDist = abs(vUv.y * 2.0 - 1.0);
    float crossFalloff = pow(clamp(1.0 - crossDist, 0.0, 1.0), 2.5);
    float longFade = pow(clamp(vAge, 0.0, 1.0), 1.35);
    float radialFade = 1.0 - smoothstep(uRadarRange * 0.80, uRadarRange, length(vWorldXZ));

    // Subtle delicate core gleam along the center filament near the aircraft
    float coreBoost = pow(clamp(1.0 - crossDist, 0.0, 1.0), 5.0) * smoothstep(0.55, 1.0, vAge) * 0.44;
    vec3 finalRgb = vColor * (uIsDark > 0.5 ? 1.12 : 1.0) + vec3(coreBoost * uIsDark);

    float alpha = crossFalloff * longFade * radialFade * uOpacity * uFade;
    if (alpha < 0.004) discard;

    // Three.js AdditiveBlending already multiplies srcRGB * srcAlpha (SRC_ALPHA, ONE) — do NOT double-premultiply!
    gl_FragColor = vec4(finalRgb, alpha);
  }
`;

export interface AircraftTrailRig {
  callsign: string;
  root: THREE.Group;
  classicLine: THREE.Line;
  classicTicks: THREE.LineSegments;
  ribbonMesh: THREE.Mesh;
  ribbonGeo: THREE.BufferGeometry;
  ribbonMat: THREE.ShaderMaterial;
  classicLineMat: THREE.LineBasicMaterial;
  classicTicksMat: THREE.LineBasicMaterial;
  dispose: () => void;
}

/**
 * Create a dual-mode trail rig for a single aircraft (Camera-Facing Billboard Shader Ribbon + optional Radar Ticks).
 */
export function createAircraftTrailRig(
  callsign: string,
  palette: SceneThemePalette,
): AircraftTrailRig {
  const root = new THREE.Group();
  root.name = `trail-${callsign}`;

  // 1. Optional Classic radar backbone line
  const linePos = new Float32Array(MAX_TRAIL_SAMPLES * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setDrawRange(0, 0);
  const classicLineMat = new THREE.LineBasicMaterial({
    color: palette.radarTrailHex,
    transparent: true,
    opacity: 0.86,
  });
  const classicLine = new THREE.Line(lineGeo, classicLineMat);
  classicLine.frustumCulled = false;
  root.add(classicLine);

  // 2. Optional Classic radar perpendicular tick-marks
  const tickPos = new Float32Array(MAX_TICKS * 2 * 3);
  const tickGeo = new THREE.BufferGeometry();
  tickGeo.setAttribute('position', new THREE.BufferAttribute(tickPos, 3));
  tickGeo.setDrawRange(0, 0);
  const classicTicksMat = new THREE.LineBasicMaterial({
    color: palette.radarTickHex,
    transparent: true,
    opacity: 0.78,
  });
  const classicTicks = new THREE.LineSegments(tickGeo, classicTicksMat);
  classicTicks.frustumCulled = false;
  root.add(classicTicks);

  // 3. Camera-Facing Billboard Luminous Ribbon (custom GLSL ShaderMaterial)
  const numVerts = MAX_TRAIL_SAMPLES * 2;
  const posArr = new Float32Array(numVerts * 3);
  const tanArr = new Float32Array(numVerts * 3);
  const sideArr = new Float32Array(numVerts);
  const widthArr = new Float32Array(numVerts);
  const ageArr = new Float32Array(numVerts);
  const colArr = new Float32Array(numVerts * 3);

  const indices: number[] = [];
  for (let i = 0; i < MAX_TRAIL_SAMPLES - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  for (let i = 0; i < MAX_TRAIL_SAMPLES; i++) {
    sideArr[i * 2] = -1;
    sideArr[i * 2 + 1] = 1;
  }

  const ribbonGeo = new THREE.BufferGeometry();
  ribbonGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  ribbonGeo.setAttribute('aTangent', new THREE.BufferAttribute(tanArr, 3));
  ribbonGeo.setAttribute('aSide', new THREE.BufferAttribute(sideArr, 1));
  ribbonGeo.setAttribute('aWidth', new THREE.BufferAttribute(widthArr, 1));
  ribbonGeo.setAttribute('aAge', new THREE.BufferAttribute(ageArr, 1));
  ribbonGeo.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3));
  ribbonGeo.setIndex(indices);
  ribbonGeo.setDrawRange(0, 0);

  const ribbonMat = new THREE.ShaderMaterial({
    vertexShader: RIBBON_VERTEX_SHADER,
    fragmentShader: RIBBON_FRAGMENT_SHADER,
    uniforms: {
      uOpacity: { value: palette.isDark ? 0.92 : 0.85 },
      uFade: { value: 1.0 },
      uIsDark: { value: palette.isDark ? 1.0 : 0.0 },
      uRadarRange: { value: 150.0 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: palette.isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const ribbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat);
  ribbonMesh.frustumCulled = false;
  ribbonMesh.renderOrder = 15;
  root.add(ribbonMesh);

  const dispose = () => {
    lineGeo.dispose();
    tickGeo.dispose();
    ribbonGeo.dispose();
    classicLineMat.dispose();
    classicTicksMat.dispose();
    ribbonMat.dispose();
  };

  return {
    callsign,
    root,
    classicLine,
    classicTicks,
    ribbonMesh,
    ribbonGeo,
    ribbonMat,
    classicLineMat,
    classicTicksMat,
    dispose,
  };
}

export function applyThemeToTrailRig(
  rig: AircraftTrailRig,
  palette: SceneThemePalette,
  selected: boolean,
): void {
  rig.classicLineMat.color.setHex(selected ? palette.aircraftSelectedHex : palette.radarTrailHex);
  rig.classicTicksMat.color.setHex(selected ? palette.aircraftSelectedHex : palette.radarTickHex);
  rig.ribbonMat.uniforms.uIsDark.value = palette.isDark ? 1.0 : 0.0;
  rig.ribbonMat.uniforms.uOpacity.value = palette.isDark ? 0.94 : 0.85;
  rig.ribbonMat.blending = palette.isDark ? THREE.AdditiveBlending : THREE.NormalBlending;
  rig.ribbonMat.needsUpdate = true;
}

/**
 * Update pre-allocated trail geometry buffers for a single aircraft at `simTimeSec`.
 * Writes per-vertex 3D tangents and smooth trajectory zone-color gradients so the
 * billboard ribbon never twists and color transitions smoothly along the flight path.
 */
export function updateAircraftTrailRig(
  rig: AircraftTrailRig,
  track: AircraftTrack,
  state: InterpolatedAircraftState | null,
  simTimeSec: number,
  trailLengthSec: number,
  trailStyle: TrailStyle,
  verticalExaggeration: number,
  projector: LocalENUProjector,
  volumes: AirspaceVolume[],
  palette: SceneThemePalette,
  dynamicColor: THREE.Color,
  selected: boolean,
  visibilityAlpha: number,
  altSmoothSec = 0,
  airportElevationFt = 256,
  radarRangeKm = 150,
): void {
  if (!state || !state.active || visibilityAlpha <= 0.01) {
    rig.root.visible = false;
    return;
  }
  rig.root.visible = true;

  const isClassic = trailStyle === 'radar-ticks';
  rig.classicLine.visible = isClassic;
  rig.classicTicks.visible = isClassic;
  rig.ribbonMesh.visible = !isClassic;

  const pts = sampleTrailPoints(
    track,
    simTimeSec,
    trailLengthSec,
    MAX_TRAIL_SAMPLES,
    projector,
    altSmoothSec,
  );
  const count = Math.min(pts.length, MAX_TRAIL_SAMPLES);

  if (isClassic) {
    rig.classicLineMat.color.copy(
      selected ? _selectedColor.setHex(palette.aircraftSelectedHex) : dynamicColor,
    );
    rig.classicLineMat.opacity = 0.86 * visibilityAlpha;
    rig.classicTicksMat.color.copy(
      selected ? _selectedColor.setHex(palette.aircraftSelectedHex) : dynamicColor,
    );
    rig.classicTicksMat.opacity = 0.78 * visibilityAlpha;

    const lineAttr = rig.classicLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const p = pts[i];
      lineAttr.setXYZ(i, p.x, p.y * verticalExaggeration, p.z);
    }
    lineAttr.needsUpdate = true;
    rig.classicLine.geometry.setDrawRange(0, count);

    const tickAttr = rig.classicTicks.geometry.getAttribute('position') as THREE.BufferAttribute;
    let tickIdx = 0;
    const step = Math.max(1, Math.floor(count / 16));
    for (let i = step; i < count - 1 && tickIdx < MAX_TICKS; i += step) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const dx = curr.x - prev.x;
      const dz = curr.z - prev.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const px = -dz / len;
      const pz = dx / len;
      const halfTick = 0.65;
      const y = curr.y * verticalExaggeration;
      tickAttr.setXYZ(tickIdx * 2, curr.x - px * halfTick, y, curr.z - pz * halfTick);
      tickAttr.setXYZ(tickIdx * 2 + 1, curr.x + px * halfTick, y, curr.z + pz * halfTick);
      tickIdx++;
    }
    tickAttr.needsUpdate = true;
    rig.classicTicks.geometry.setDrawRange(0, tickIdx * 2);
    return;
  }

  // Camera-Facing Billboard Ribbon with smooth per-vertex zone color gradient
  if (count < 2) {
    rig.ribbonGeo.setDrawRange(0, 0);
    return;
  }

  rig.ribbonMat.uniforms.uFade.value = visibilityAlpha;
  rig.ribbonMat.uniforms.uRadarRange.value = Math.max(40, radarRangeKm);

  const posAttr = rig.ribbonGeo.getAttribute('position') as THREE.BufferAttribute;
  const tanAttr = rig.ribbonGeo.getAttribute('aTangent') as THREE.BufferAttribute;
  const widthAttr = rig.ribbonGeo.getAttribute('aWidth') as THREE.BufferAttribute;
  const ageAttr = rig.ribbonGeo.getAttribute('aAge') as THREE.BufferAttribute;
  const colAttr = rig.ribbonGeo.getAttribute('aColor') as THREE.BufferAttribute;

  // Sleek billboard half-width sized for pow(..., 2.5) soft halo falloff (crisp ~0.22km core + soft feathered edges, no bulky cone)
  const maxHalfWidth = selected ? 0.92 : 0.68;
  _selectedColor.setHex(palette.aircraftSelectedHex);

  // Sample historical sector color at sparse checkpoints and smooth-blend along the trail
  const colorSampleStride = 4;
  let lastZoneHex = dynamicColor.getHex();
  let prevSmoothedR = dynamicColor.r;
  let prevSmoothedG = dynamicColor.g;
  let prevSmoothedB = dynamicColor.b;

  for (let i = 0; i < count; i++) {
    const curr = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(count - 1, i + 1)];

    const yCurr = curr.y * verticalExaggeration;
    const dx = next.x - prev.x;
    const dy = (next.y - prev.y) * verticalExaggeration;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const tx = dx / len;
    const ty = dy / len;
    const tz = dz / len;

    const age = curr.ageRatio; // 0 (oldest tail) -> 1 (aircraft head)
    // Gentle linear-ish taper to 0 at tail, staying sleek & narrow at the head
    const halfW = maxHalfWidth * (0.04 + 0.96 * Math.pow(age, 0.85));

    // Evaluate historical controlling ATC color strictly from log events first (geometric fallback only if absent)
    if (i % colorSampleStride === 0 || i === count - 1) {
      const geo = projector.toGeo(curr.x, curr.z);
      const sec = resolveAircraftController(
        track.controllerEvents,
        curr.timeSec,
        geo.lat,
        geo.lon,
        curr.altFt,
        volumes,
        undefined,
        undefined,
        4.5,
        airportElevationFt,
      );
      lastZoneHex = getSectorControlColorHex(sec.kind, palette.isDark);
    }
    _segColor.setHex(lastZoneHex);

    if (i === 0) {
      prevSmoothedR = _segColor.r;
      prevSmoothedG = _segColor.g;
      prevSmoothedB = _segColor.b;
    } else {
      // Exponential spatial smoothing along trail so zone crossings always paint a silky gradient
      const smoothK = 0.22;
      prevSmoothedR += (_segColor.r - prevSmoothedR) * smoothK;
      prevSmoothedG += (_segColor.g - prevSmoothedG) * smoothK;
      prevSmoothedB += (_segColor.b - prevSmoothedB) * smoothK;
    }

    _tmpColor.setRGB(prevSmoothedR, prevSmoothedG, prevSmoothedB);

    // Blend seamlessly into the aircraft's live 1.5s-lerped head color over the newest 30% of trail
    if (age > 0.7) {
      const headBlend = (age - 0.7) / 0.3;
      _tmpColor.lerp(dynamicColor, headBlend);
    }

    const v0 = i * 2;
    const v1 = v0 + 1;

    posAttr.setXYZ(v0, curr.x, yCurr, curr.z);
    posAttr.setXYZ(v1, curr.x, yCurr, curr.z);

    tanAttr.setXYZ(v0, tx, ty, tz);
    tanAttr.setXYZ(v1, tx, ty, tz);

    widthAttr.setX(v0, halfW);
    widthAttr.setX(v1, halfW);

    ageAttr.setX(v0, age);
    ageAttr.setX(v1, age);

    colAttr.setXYZ(v0, _tmpColor.r, _tmpColor.g, _tmpColor.b);
    colAttr.setXYZ(v1, _tmpColor.r, _tmpColor.g, _tmpColor.b);
  }

  posAttr.needsUpdate = true;
  tanAttr.needsUpdate = true;
  widthAttr.needsUpdate = true;
  ageAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  rig.ribbonGeo.setDrawRange(0, (count - 1) * 6);
}
