import * as THREE from 'three';
import type { BaseMapData, GeoMapPolygon } from '../types/radar';
import type { LocalENUProjector } from '../core/geo';
import type { SceneThemePalette } from './themes';
import { enuToCanvasPixel } from '../core/urbanFabric';
import {
  buildNightCityLightingData,
  type NightRoadRibbonSegment,
  type UrbanHub,
} from '../core/nightLights';

const NIGHT_EXTENT_KM = 270;
const CONTROL_TEX_PX = 1024;

export interface NightCityLightsHandle {
  group: THREE.Group;
  setRoadsVisible: (visible: boolean) => void;
}

function traceGeoPolygonPath(
  ctx: CanvasRenderingContext2D,
  poly: GeoMapPolygon,
  projector: LocalENUProjector,
  extentKm: number,
  sizePx: number,
): void {
  if (poly.points.length < 3) return;
  const p0 = projector.toENU(poly.points[0].lat, poly.points[0].lon, 0);
  const [x0, y0] = enuToCanvasPixel(p0.x, p0.z, extentKm, sizePx);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < poly.points.length; i++) {
    const p = projector.toENU(poly.points[i].lat, poly.points[i].lon, 0);
    const [x, y] = enuToCanvasPixel(p.x, p.z, extentKm, sizePx);
    ctx.lineTo(x, y);
  }
  ctx.closePath();

  if (poly.holes && poly.holes.length > 0) {
    for (const hole of poly.holes) {
      if (hole.length < 3) continue;
      const h0 = projector.toENU(hole[0].lat, hole[0].lon, 0);
      const [hx0, hy0] = enuToCanvasPixel(h0.x, h0.z, extentKm, sizePx);
      ctx.moveTo(hx0, hy0);
      for (let i = 1; i < hole.length; i++) {
        const hp = projector.toENU(hole[i].lat, hole[i].lon, 0);
        const [hx, hy] = enuToCanvasPixel(hp.x, hp.z, extentKm, sizePx);
        ctx.lineTo(hx, hy);
      }
      ctx.closePath();
    }
  }
}

/**
 * Bake a 1024x1024 geographic control map (`uGeoMap`) covering [-270..+270] km:
 * - R: built-up urban footprint (`landuse`, organically feathered — never hard-edged blocks)
 * - G: downtown core centrality gradient around true urban hubs (0 in countryside, peaks in city centers)
 * - B: urban-clipped arterial road density skyglow (strictly masked to built-up polygons, zero rural bleed)
 * - A: strict land mask (255 on land, 0 strictly inside WATER polygons so rivers/lakes stay pitch dark)
 */
function bakeGeographicControlTexture(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
  hubs: UrbanHub[],
): THREE.DataTexture | null {
  if (typeof document === 'undefined') return null;

  const size = CONTROL_TEX_PX;
  const urbanPolys = baseMap.polygons.filter((p) => p.kind === 'URBAN' && p.points.length >= 3);
  const waterPolys = baseMap.polygons.filter((p) => p.kind === 'WATER' && p.points.length >= 3);
  const roadLines = baseMap.polylines.filter((l) => l.kind === 'ROAD' && l.points.length >= 2);
  if (urbanPolys.length === 0 && hubs.length === 0) return null;

  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  };

  // 1. Channel R: Multi-pass organically feathered urban footprint
  const builtCanvas = makeCanvas();
  const builtCtx = builtCanvas.getContext('2d', { willReadFrequently: true });
  if (!builtCtx) return null;
  builtCtx.fillStyle = '#000000';
  builtCtx.fillRect(0, 0, size, size);

  if (urbanPolys.length > 0) {
    // Tight core footprint
    builtCtx.save();
    builtCtx.filter = 'blur(2.2px)';
    builtCtx.fillStyle = 'rgba(255,255,255,0.82)';
    for (const poly of urbanPolys) {
      builtCtx.beginPath();
      traceGeoPolygonPath(builtCtx, poly, projector, NIGHT_EXTENT_KM, size);
      builtCtx.fill('evenodd');
    }
    builtCtx.restore();

    // Soft outer suburban atmospheric scatter
    builtCtx.save();
    builtCtx.globalCompositeOperation = 'lighter';
    builtCtx.filter = 'blur(6.0px)';
    builtCtx.fillStyle = 'rgba(255,255,255,0.22)';
    for (const poly of urbanPolys) {
      builtCtx.beginPath();
      traceGeoPolygonPath(builtCtx, poly, projector, NIGHT_EXTENT_KM, size);
      builtCtx.fill('evenodd');
    }
    builtCtx.restore();
  }
  const builtData = builtCtx.getImageData(0, 0, size, size).data;

  // 2. Channel G: Urban centrality gradient (strictly 0 baseline so outskirts never get muddy fill)
  const coreCanvas = makeCanvas();
  const coreCtx = coreCanvas.getContext('2d', { willReadFrequently: true });
  if (!coreCtx) return null;
  coreCtx.fillStyle = '#000000';
  coreCtx.fillRect(0, 0, size, size);
  coreCtx.globalCompositeOperation = 'lighter';
  for (const hub of hubs) {
    const [hx, hy] = enuToCanvasPixel(hub.x, hub.z, NIGHT_EXTENT_KM, size);
    const radPx = Math.max(8, (hub.radiusKm / NIGHT_EXTENT_KM) * (size * 0.5) * 1.45);
    const grad = coreCtx.createRadialGradient(hx, hy, 0, hx, hy, radPx);
    const peak = Math.min(0.95, hub.strength * 0.92);
    grad.addColorStop(0, `rgba(255,255,255,${peak.toFixed(3)})`);
    grad.addColorStop(0.38, `rgba(255,255,255,${(peak * 0.44).toFixed(3)})`);
    grad.addColorStop(0.75, `rgba(255,255,255,${(peak * 0.14).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    coreCtx.fillStyle = grad;
    coreCtx.beginPath();
    coreCtx.arc(hx, hy, radPx, 0, Math.PI * 2);
    coreCtx.fill();
  }
  const coreData = coreCtx.getImageData(0, 0, size, size).data;

  // 3. Channel B: Urban-clipped arterial road skyglow aura (gives gentle atmospheric bounce along city boulevards)
  const roadGlowCanvas = makeCanvas();
  const roadGlowCtx = roadGlowCanvas.getContext('2d', { willReadFrequently: true });
  if (!roadGlowCtx) return null;
  roadGlowCtx.fillStyle = '#000000';
  roadGlowCtx.fillRect(0, 0, size, size);

  if (roadLines.length > 0 && urbanPolys.length > 0) {
    roadGlowCtx.save();
    roadGlowCtx.filter = 'blur(2.8px)';
    roadGlowCtx.lineCap = 'round';
    roadGlowCtx.lineJoin = 'round';
    for (const line of roadLines) {
      const weight = line.weight ?? 0.65;
      roadGlowCtx.lineWidth = weight >= 0.88 ? 2.6 : weight >= 0.72 ? 1.9 : 1.3;
      const alpha = weight >= 0.88 ? 0.58 : weight >= 0.72 ? 0.42 : 0.28;
      roadGlowCtx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
      roadGlowCtx.beginPath();
      const p0 = projector.toENU(line.points[0].lat, line.points[0].lon, 0);
      const [x0, y0] = enuToCanvasPixel(p0.x, p0.z, NIGHT_EXTENT_KM, size);
      roadGlowCtx.moveTo(x0, y0);
      for (let i = 1; i < line.points.length; i++) {
        const p = projector.toENU(line.points[i].lat, line.points[i].lon, 0);
        const [x, y] = enuToCanvasPixel(p.x, p.z, NIGHT_EXTENT_KM, size);
        roadGlowCtx.lineTo(x, y);
      }
      roadGlowCtx.stroke();
    }
    roadGlowCtx.restore();

    // Clip road skyglow strictly to the feathered urban mask so rural corridors stay crisp and clean
    roadGlowCtx.save();
    roadGlowCtx.globalCompositeOperation = 'destination-in';
    roadGlowCtx.drawImage(builtCanvas, 0, 0);
    roadGlowCtx.restore();
  }
  const roadGlowData = roadGlowCtx.getImageData(0, 0, size, size).data;

  // 4. Channel A: Strict land mask (255 on land, 0 strictly inside WATER polygons)
  const landCanvas = makeCanvas();
  const landCtx = landCanvas.getContext('2d', { willReadFrequently: true });
  if (!landCtx) return null;
  landCtx.fillStyle = '#ffffff';
  landCtx.fillRect(0, 0, size, size);
  if (waterPolys.length > 0) {
    landCtx.save();
    landCtx.fillStyle = '#000000';
    for (const wPoly of waterPolys) {
      landCtx.beginPath();
      traceGeoPolygonPath(landCtx, wPoly, projector, NIGHT_EXTENT_KM, size);
      landCtx.fill('evenodd');
    }
    landCtx.restore();
  }
  const landData = landCtx.getImageData(0, 0, size, size).data;

  const packed = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    packed[o] = builtData[o];        // R: builtUp
    packed[o + 1] = coreData[o];     // G: urbanCore
    packed[o + 2] = roadGlowData[o]; // B: urbanRoadAura
    packed[o + 3] = landData[o];     // A: landMask
  }

  const tex = new THREE.DataTexture(packed, size, size, THREE.RGBAFormat);
  tex.flipY = true;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a single merged mitered triangle-strip BufferGeometry for continuous anti-aliased
 * luminous road & bridge filaments. Camera-distance-aware optical width with energy conservation
 * eliminates sub-pixel aliasing, WebGL 1px line limits, and dashed-garland artifacts.
 */
function buildRoadFilamentsMesh(
  ribbons: NightRoadRibbonSegment[],
  sharedRadarRangeUniform: { value: number },
  visible: boolean,
): THREE.Mesh | null {
  if (ribbons.length === 0) return null;

  const segCount = ribbons.length;
  const vertCount = segCount * 6;
  const positions = new Float32Array(vertCount * 3);
  const normalWidths = new Float32Array(vertCount * 3);
  const crossUs = new Float32Array(vertCount);
  const params = new Float32Array(vertCount * 4);
  const isBridges = new Float32Array(vertCount);

  const Y_ROAD = 0.054;
  let v = 0;

  const pushVert = (
    x: number,
    z: number,
    nx: number,
    nz: number,
    signedHalfW: number,
    crossU: number,
    intensity: number,
    temp: number,
    along: number,
    seed: number,
    isBridge: number,
  ) => {
    const p3 = v * 3;
    positions[p3] = x;
    positions[p3 + 1] = Y_ROAD;
    positions[p3 + 2] = z;

    normalWidths[p3] = nx;
    normalWidths[p3 + 1] = nz;
    normalWidths[p3 + 2] = signedHalfW;

    crossUs[v] = crossU;

    const p4 = v * 4;
    params[p4] = intensity;
    params[p4 + 1] = temp;
    params[p4 + 2] = along;
    params[p4 + 3] = seed;

    isBridges[v] = isBridge;
    v++;
  };

  for (let i = 0; i < segCount; i++) {
    const s = ribbons[i];
    const hw = s.halfWidthKm;
    const br = s.isBridge ? 1.0 : 0.0;

    // Quad corners:
    // L0 (start, -1), R0 (start, +1), L1 (end, -1), R1 (end, +1)
    // Triangle 1: L0 -> R0 -> R1
    pushVert(s.x0, s.z0, s.nx0, s.nz0, -hw, -1.0, s.intensity0, s.temp0, s.along0, s.seed, br);
    pushVert(s.x0, s.z0, s.nx0, s.nz0, hw, 1.0, s.intensity0, s.temp0, s.along0, s.seed, br);
    pushVert(s.x1, s.z1, s.nx1, s.nz1, hw, 1.0, s.intensity1, s.temp1, s.along1, s.seed, br);

    // Triangle 2: L0 -> R1 -> L1
    pushVert(s.x0, s.z0, s.nx0, s.nz0, -hw, -1.0, s.intensity0, s.temp0, s.along0, s.seed, br);
    pushVert(s.x1, s.z1, s.nx1, s.nz1, hw, 1.0, s.intensity1, s.temp1, s.along1, s.seed, br);
    pushVert(s.x1, s.z1, s.nx1, s.nz1, -hw, -1.0, s.intensity1, s.temp1, s.along1, s.seed, br);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aNormalWidth', new THREE.BufferAttribute(normalWidths, 3));
  geo.setAttribute('aCrossU', new THREE.BufferAttribute(crossUs, 1));
  geo.setAttribute('aParams', new THREE.BufferAttribute(params, 4));
  geo.setAttribute('aIsBridge', new THREE.BufferAttribute(isBridges, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uRadarRange: sharedRadarRangeUniform,
    },
    vertexShader: /* glsl */ `
      attribute vec3 aNormalWidth;
      attribute float aCrossU;
      attribute vec4 aParams;
      attribute float aIsBridge;

      uniform float uRadarRange;

      varying float vCrossU;
      varying float vIntensity;
      varying float vTemp;
      varying float vAlong;
      varying float vSeed;
      varying float vIsBridge;
      varying float vRadialFade;

      void main() {
        vec4 centerWorld = modelMatrix * vec4(position, 1.0);
        vec4 centerMV = viewMatrix * centerWorld;
        float dist = max(8.0, -centerMV.z);

        float signedHalfW = aNormalWidth.z;
        float absHalfW = abs(signedHalfW);
        float sideSign = signedHalfW >= 0.0 ? 1.0 : -1.0;

        // Anti-aliased minimum screen-space optical half-width so roads never shimmer or drop out
        // Bridges stay slightly tighter for razor-crisp river crossings
        float minRatio = mix(0.00145, 0.00120, aIsBridge);
        float minHalfW = dist * minRatio;
        float effHalfW = max(absHalfW, minHalfW);

        // Energy conservation: when expanded above physical width for AA, softly attenuate luminance
        float widthRatio = clamp(absHalfW / effHalfW, 0.16, 1.0);
        float energyScale = pow(widthRatio, 0.62);

        vec3 displacedPos = position;
        displacedPos.x += aNormalWidth.x * sideSign * effHalfW;
        displacedPos.z += aNormalWidth.y * sideSign * effHalfW;

        vec4 worldPos = modelMatrix * vec4(displacedPos, 1.0);
        float rKm = length(worldPos.xz);
        vRadialFade = 1.0 - smoothstep(uRadarRange * 0.72, uRadarRange * 0.99, rKm);

        vCrossU = aCrossU;
        vIntensity = aParams.x * energyScale;
        vTemp = aParams.y;
        vAlong = aParams.z;
        vSeed = aParams.w;
        vIsBridge = aIsBridge;

        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vCrossU;
      varying float vIntensity;
      varying float vTemp;
      varying float vAlong;
      varying float vSeed;
      varying float vIsBridge;
      varying float vRadialFade;

      void main() {
        if (vRadialFade < 0.004 || vIntensity < 0.004) discard;

        float u = abs(vCrossU);
        if (u > 1.0) discard;

        // Crisp luminous street core + tight warm sodium halo skirt (bridges stay razor-sharp)
        float coreExp = mix(10.5, 15.5, vIsBridge);
        float core = exp(-u * u * coreExp);
        float halo = mix(0.24, 0.16, vIsBridge) * exp(-u * u * 2.5);
        float crossProfile = (core + halo) * smoothstep(1.0, 0.42, u);

        // Organic non-periodic lengthwise modulation (incommensurate frequencies — zero dashed-garland look)
        float w1 = sin(vAlong * 1.93 + vSeed * 1.71);
        float w2 = sin(vAlong * 5.29 - vSeed * 2.83);
        float w3 = sin(vAlong * 12.67 + vSeed * 4.19);
        float alongVar = 0.54 * w1 + 0.30 * w2 + 0.16 * w3;
        float organicMod = mix(0.82 + 0.18 * alongVar, 0.92 + 0.08 * alongVar, vIsBridge);

        // Warm sodium-vapor amber -> golden arterial -> warm incandescent white core
        vec3 deepAmber = vec3(0.96, 0.44, 0.09);
        vec3 warmGold  = vec3(1.00, 0.68, 0.24);
        vec3 warmWhite = vec3(1.00, 0.87, 0.58);

        vec3 baseCol = mix(deepAmber, warmGold, smoothstep(0.08, 0.62, vTemp));
        baseCol = mix(baseCol, warmWhite, smoothstep(0.58, 1.0, vTemp) * 0.65);

        // Core center shifts warmer/brighter like real optical halation on nocturnal aerial photography
        vec3 haloTint = baseCol * vec3(0.96, 0.72, 0.42);
        vec3 col = mix(haloTint, mix(baseCol, vec3(1.0, 0.92, 0.74), 0.36), core);

        float alpha = clamp(crossProfile * vIntensity * organicMod * vRadialFade * 0.56, 0.0, 0.68);
        if (alpha < 0.004) discard;

        // AdditiveBlending uses (SRC_ALPHA, ONE) — pass disciplined HDR-safe RGB + alpha
        gl_FragColor = vec4(col * 0.78, alpha);
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'basemap-night-road-filaments';
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.visible = visible;
  return mesh;
}

/**
 * Build the redesigned 3-layer nocturnal aerial city lighting system:
 * 1. `basemap-urban-fabric`: subtle additive warm atmospheric skyglow strictly beneath populated
 *    districts & urban arterial networks (switches to matte slate cartography in `tactical-light`).
 * 2. `basemap-night-road-filaments`: continuous anti-aliased hierarchical road & bridge ribbons
 *    (brighter motorways/arterials, finer secondary avenues, crisp river bridge decks, dark countryside).
 * 3. `basemap-night-light-points`: up to 28,000 non-grid deterministic pinpoint light stars aligned to
 *    real streets, angled neighborhood quarters, downtown cores, satellite towns, and real interchanges.
 */
export function buildNightCityLightsGroup(
  baseMap: BaseMapData,
  projector: LocalENUProjector,
  palette: SceneThemePalette,
  sharedRadarRangeUniform: { value: number },
  visible: boolean,
  initialShowCityRoads = true,
): NightCityLightsHandle | null {
  const { ribbons, points, hubs } = buildNightCityLightingData(baseMap, projector, 250, 28000);
  const geoTex = bakeGeographicControlTexture(baseMap, projector, hubs);

  if (!geoTex && ribbons.length === 0 && points.length === 0) return null;

  const group = new THREE.Group();
  group.name = 'basemap-night-lights';
  group.visible = visible;

  // --- Layer 1: Atmospheric Urban Skyglow (Dark) / Matte Cartographic Urban Blocks (Light) ---
  if (geoTex) {
    const planeGeo = new THREE.PlaneGeometry(NIGHT_EXTENT_KM * 2, NIGHT_EXTENT_KM * 2);
    planeGeo.rotateX(-Math.PI / 2);

    const fabricMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: palette.isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
      uniforms: {
        uGeoMap: { value: geoTex },
        uRadarRange: sharedRadarRangeUniform,
        uIsDark: { value: palette.isDark ? 1.0 : 0.0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec2 vXZ;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vXZ = worldPos.xz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uGeoMap;
        uniform float uRadarRange;
        uniform float uIsDark;
        varying vec2 vUv;
        varying vec2 vXZ;

        float hash21(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.53);
          return fract(p.x * p.y);
        }

        float valueNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        float fbm2(vec2 p) {
          // Domain-rotated second octave prevents any axis-aligned texture bias
          mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
          return valueNoise(p) * 0.64 + valueNoise(rot * p * 2.11 + vec2(13.7, -9.4)) * 0.36;
        }

        void main() {
          float rKm = length(vXZ);
          float radialFade = 1.0 - smoothstep(uRadarRange * 0.72, uRadarRange * 0.99, rKm);
          if (radialFade < 0.004) discard;

          vec4 geo = texture2D(uGeoMap, vUv);
          float builtUp = geo.r;
          float urbanCore = geo.g;
          float roadAura = geo.b;
          float landMask = geo.a;

          // Tactical Light daytime chart mode: clean matte cartographic urban blocks
          if (uIsDark < 0.5) {
            float mask = smoothstep(0.26, 0.66, builtUp) * landMask;
            if (mask < 0.04) discard;
            vec3 dayCol = mix(vec3(0.56, 0.59, 0.63), vec3(0.64, 0.67, 0.71), urbanCore);
            gl_FragColor = vec4(dayCol, mask * 0.48 * radialFade);
            #include <colorspace_fragment>
            return;
          }

          // Domain-warped organic variation carves dark parks/industrial breaks inside cities
          vec2 warp = vec2(
            fbm2(vXZ * 0.19 + vec2(4.2, -7.8)),
            fbm2(vXZ * 0.19 + vec2(-11.5, 6.3))
          ) - 0.5;
          vec2 warpedXZ = vXZ + warp * 2.6;

          float edgeNoise = fbm2(warpedXZ * 0.32);
          float districtMod = smoothstep(0.18, 0.82, fbm2(warpedXZ * 0.52 + vec2(19.4, -12.7)));
          float organicBuilt = smoothstep(0.14 + edgeNoise * 0.28, 0.78, builtUp);
          float landStrict = smoothstep(0.42, 0.90, landMask);
          float urbanMask = organicBuilt * landStrict;

          if (urbanMask < 0.004 && roadAura < 0.01) discard;

          // Very restrained additive atmospheric haze: zero flat brown carpet, concentrates softly in centers & avenues
          float districtHaze = urbanMask * (0.28 + 0.72 * districtMod) * (0.032 + urbanCore * 0.075 + urbanCore * urbanCore * 0.055);
          float avenueBounce = roadAura * landStrict * (0.048 + urbanCore * 0.042);
          float totalGlow = clamp(districtHaze + avenueBounce, 0.0, 0.18) * radialFade;
          if (totalGlow < 0.003) discard;

          vec3 colOutskirt = vec3(0.76, 0.34, 0.07);
          vec3 colQuarter  = vec3(0.92, 0.50, 0.14);
          vec3 colCore     = vec3(1.00, 0.68, 0.28);

          vec3 col = mix(colOutskirt, colQuarter, smoothstep(0.0, 0.52, urbanCore + roadAura * 0.25));
          col = mix(col, colCore, smoothstep(0.52, 1.0, urbanCore));

          gl_FragColor = vec4(col, totalGlow);
          #include <colorspace_fragment>
        }
      `,
    });

    const fabricMesh = new THREE.Mesh(planeGeo, fabricMat);
    fabricMesh.name = 'basemap-urban-fabric';
    fabricMesh.position.y = 0.032;
    fabricMesh.renderOrder = -3;
    fabricMesh.userData.disposeTexture = geoTex;
    group.add(fabricMesh);
  }

  // --- Layer 2: Continuous Anti-Aliased Road & Bridge Luminous Filaments (Dark Theme only) ---
  let roadFilamentsMesh: THREE.Mesh | null = null;
  if (palette.isDark && ribbons.length > 0) {
    roadFilamentsMesh = buildRoadFilamentsMesh(ribbons, sharedRadarRangeUniform, initialShowCityRoads);
    if (roadFilamentsMesh) {
      group.add(roadFilamentsMesh);
    }
  }

  // --- Layer 3: Structured Non-Grid Photographic Pinpoint City Light Stars (Dark Theme only) ---
  if (palette.isDark && points.length > 0) {
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    const intensities = new Float32Array(points.length);

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = 0.064;
      positions[i * 3 + 2] = p.z;
      colors[i * 3] = p.r;
      colors[i * 3 + 1] = p.g;
      colors[i * 3 + 2] = p.b;
      sizes[i] = p.size;
      intensities[i] = p.intensity;
    }

    const ptsGeo = new THREE.BufferGeometry();
    ptsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    ptsGeo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    ptsGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    ptsGeo.setAttribute('aIntensity', new THREE.BufferAttribute(intensities, 1));

    const ptsMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uRadarRange: sharedRadarRangeUniform,
        uPixelRatio: {
          value: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1,
        },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aIntensity;
        uniform float uRadarRange;
        uniform float uPixelRatio;

        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          float rKm = length(worldPos.xz);
          float radialFade = 1.0 - smoothstep(uRadarRange * 0.72, uRadarRange * 0.99, rKm);

          vec4 mvPosition = viewMatrix * worldPos;
          float dist = max(8.0, -mvPosition.z);

          // Crisp distance-adaptive optical PSF diameter:
          // - Close zoom (dist ~ 30 km): individual streetlamps & quarter nodes (2.8..5.2 px)
          // - Default iso view (dist ~ 160 km): luminous jewel-like city clusters (1.45..2.9 px)
          // - High orbit (dist ~ 280+ km): smooth >= 1.40 px anti-flicker points merging into city masses
          float rawPx = (176.0 * aSize / dist) * uPixelRatio;
          float clampedPx = clamp(rawPx, 1.40 * uPixelRatio, 5.2 * uPixelRatio);
          gl_PointSize = clampedPx;

          // Smooth energy conservation across zoom levels prevents shimmer or blowout
          float farEnergyScale = mix(0.56, 0.98, smoothstep(1.35 * uPixelRatio, 3.4 * uPixelRatio, rawPx));
          vColor = aColor;
          vAlpha = aIntensity * farEnergyScale * radialFade;

          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          if (vAlpha < 0.008) discard;
          vec2 c = gl_PointCoord - vec2(0.5);
          float r2 = dot(c, c) * 4.0;
          if (r2 > 1.0) discard;

          // Photographic pinpoint PSF: razor-sharp incandescent core + tight warm optical halo
          float core = exp(-r2 * 13.0);
          float halo = 0.24 * exp(-r2 * 3.1);
          float profile = (core + halo) * smoothstep(1.0, 0.50, r2);

          // Warm sodium halo -> incandescent golden/warm-white core, disciplined below aircraft/trails
          vec3 haloCol = vColor * vec3(0.98, 0.74, 0.42);
          vec3 coreCol = mix(haloCol, mix(vColor, vec3(1.0, 0.95, 0.86), 0.40), core) * 0.78;

          // AdditiveBlending uses (SRC_ALPHA, ONE)
          float finalAlpha = clamp(profile * vAlpha * 0.82, 0.0, 0.88);
          if (finalAlpha < 0.006) discard;

          gl_FragColor = vec4(coreCol, finalAlpha);
          #include <colorspace_fragment>
        }
      `,
    });

    const pointsObj = new THREE.Points(ptsGeo, ptsMat);
    pointsObj.name = 'basemap-night-light-points';
    pointsObj.renderOrder = 0;
    pointsObj.frustumCulled = false;
    group.add(pointsObj);
  }

  const setRoadsVisible = (show: boolean) => {
    if (roadFilamentsMesh) {
      roadFilamentsMesh.visible = show;
    }
  };

  return { group, setRoadsVisible };
}
