import * as THREE from 'three';
import type {
  AirspaceKind,
  BaseMapData,
  DatablockMode,
  GeoMapLabel,
  GeoPoint,
  InterpolatedAircraftState,
  ProjectedLabel,
  SceneSettings,
  ThemePreset,
  Waypoint,
} from '../types/radar';
import { formatFlightLevel, LocalENUProjector } from '../core/geo';
import { resolveLabelOverlaps } from '../core/labelLayout';
import { shouldShowGroundLabel } from '../core/mapLabelFilter';
import { computeRadialFadeAlpha, shiftCityLabelAwayFromRunway } from '../core/radialFog';
import { classifyWaypoint, shouldShowWaypoint } from '../core/waypointFilter';
import type { SectorLabelAnchor } from './airspaceBuilder';

interface CachedLabelTexture {
  texture: THREE.CanvasTexture;
  logicalW: number;
  logicalH: number;
}

interface AircraftSpriteEntry {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  lastKey: string;
}

const MAX_AIRCRAFT_LEADERS = 180;
const _proj = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _worldBoxCenter = new THREE.Vector3();
const _worldEdge = new THREE.Vector3();

function hexNumberToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

function getSectorTagColorCss(kind: AirspaceKind | 'ENROUTE' | undefined, isDark: boolean): string {
  if (isDark) {
    switch (kind) {
      case 'CTR':
        return 'rgba(186, 200, 218, 0.72)';
      case 'TMA':
        return 'rgba(156, 174, 198, 0.68)';
      case 'APP':
        return 'rgba(128, 158, 192, 0.66)';
      case 'FIR':
      case 'ENROUTE':
      default:
        return 'rgba(114, 138, 168, 0.62)';
    }
  }
  switch (kind) {
    case 'CTR':
      return '#b45309';
    case 'TMA':
      return '#c2410c';
    case 'APP':
      return '#0369a1';
    case 'FIR':
    case 'ENROUTE':
    default:
      return '#1d4ed8';
  }
}

/**
 * Draw crisp outlined text with zero background box (`outlineWidth` halo for razor-sharp contrast
 * over any dark or light background, matching troika-three-text visual quality).
 */
function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fillCss: string,
  isDark: boolean,
  outlineWidth = 3.2,
  letterSpacingPx = 0,
): void {
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = outlineWidth;
  ctx.strokeStyle = isDark ? 'rgba(3, 7, 16, 0.92)' : 'rgba(241, 245, 249, 0.9)';
  ctx.fillStyle = fillCss;

  if (letterSpacingPx > 0) {
    let cursorX = x;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      ctx.strokeText(ch, cursorX, y);
      ctx.fillText(ch, cursorX, y);
      cursorX += ctx.measureText(ch).width + letterSpacingPx;
    }
  } else {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
}

/**
 * Render clean background-free high-DPI outlined text texture for waypoints, ground labels, or sector labels.
 */
function buildCleanTextTexture(
  text: string,
  colorCss: string,
  fontPx: number,
  fontWeight: number,
  isDark: boolean,
  outlineWidth = 2.8,
  letterSpacingPx = 0,
): CachedLabelTexture {
  const dpr = 2;
  const padX = 5;
  const padY = 4;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `${fontWeight} ${fontPx}px "JetBrains Mono", "Inter", monospace`;
  ctx.font = font;

  const measured = ctx.measureText(text).width + Math.max(0, text.length - 1) * letterSpacingPx;
  const logicalW = Math.ceil(measured + padX * 2);
  const logicalH = Math.ceil(fontPx * 1.35 + padY * 2);

  canvas.width = Math.max(4, logicalW * dpr);
  canvas.height = Math.max(4, logicalH * dpr);

  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  if (outlineWidth > 0) {
    drawOutlinedText(ctx, text, padX, logicalH * 0.52, colorCss, isDark, outlineWidth, letterSpacingPx);
  } else {
    ctx.fillStyle = colorCss;
    if (letterSpacingPx > 0) {
      let cursorX = padX;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        ctx.fillText(ch, cursorX, logicalH * 0.52);
        cursorX += ctx.measureText(ch).width + letterSpacingPx;
      }
    } else {
      ctx.fillText(text, padX, logicalH * 0.52);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, logicalW, logicalH };
}

/**
 * Render clean background-free aircraft datablock with subtle thin dark outline:
 * - Minimal (default):
 *     Line 1: Callsign (e.g. AFL2182)
 *     Line 2 (smaller, live sector RGB): Controlling position (CTR / APP / TWR / RADAR)
 * - Detailed:
 *     Line 1: Callsign + Dest + Sector
 *     Line 2: FL + Vertical Arrow + Cleared FL + GS
 *     Line 3: Type + SID/STAR
 */
function buildDatablockTexture(
  state: InterpolatedAircraftState,
  mode: DatablockMode,
  isDark: boolean,
  selected: boolean,
  accentHex: number,
): CachedLabelTexture {
  const dpr = 2;
  const accentCss = hexNumberToCss(accentHex);
  const sectorCode = state.sectorCode ?? 'CTR';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  if (mode === 'minimal') {
    const line1Font = '700 11.5px "JetBrains Mono", monospace';
    const line2Font = '600 9px "JetBrains Mono", monospace';

    ctx.font = line1Font;
    const w1 = ctx.measureText(state.callsign).width;
    ctx.font = line2Font;
    const w2 = ctx.measureText(sectorCode).width;

    const padX = 5;
    const logicalW = Math.ceil(Math.max(w1, w2) + padX * 2 + 2);
    const logicalH = 29;

    canvas.width = logicalW * dpr;
    canvas.height = logicalH * dpr;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Line 1: Crisp Callsign (no dark background box!)
    ctx.font = line1Font;
    const primaryCss = selected
      ? isDark
        ? '#ffffff'
        : '#0369a1'
      : isDark
        ? '#f1f5f9'
        : '#0f172a';
    drawOutlinedText(ctx, state.callsign, padX, 3, primaryCss, isDark, 3.2);

    // Line 2: Compact Controlling Position Code tinted strictly by smoothly-lerped live RGB
    ctx.font = line2Font;
    drawOutlinedText(ctx, sectorCode, padX, 16, accentCss, isDark, 2.8);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return { texture, logicalW, logicalH };
  }

  // Detailed 3-line floating outlined datablock (still background-free!)
  const arrow = state.verticalRateFpm > 250 ? '↑' : state.verticalRateFpm < -250 ? '↓' : '→';
  const flStr = formatFlightLevel(state.altFt);
  const clearedStr = state.clearedFl ? `F${String(state.clearedFl).padStart(3, '0')}` : '';
  const line1Left = state.callsign;
  const line1Right = `${state.destination || ''} ${sectorCode}`.trim();
  const line2 = `${flStr}${arrow}${clearedStr} Kt${Math.round(state.gsKt)}`;
  const line3 = `${state.aircraftType} ${state.sidOrStar ?? ''}`.trim();

  const fBold = '700 11px "JetBrains Mono", monospace';
  const fSub = '600 9.5px "JetBrains Mono", monospace';
  const fReg = '500 9.5px "JetBrains Mono", monospace';
  ctx.font = fBold;
  const w1 = ctx.measureText(`${line1Left}  ${line1Right}`).width;
  ctx.font = fReg;
  const w2 = ctx.measureText(line2).width;
  const w3 = ctx.measureText(line3).width;

  const padX = 5;
  const logicalW = Math.max(118, Math.ceil(Math.max(w1, w2, w3) + padX * 2 + 8));
  const logicalH = 44;

  canvas.width = logicalW * dpr;
  canvas.height = logicalH * dpr;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.font = fBold;
  drawOutlinedText(
    ctx,
    line1Left,
    padX,
    3,
    selected ? (isDark ? '#fde68a' : '#0369a1') : isDark ? '#f8fafc' : '#0f172a',
    isDark,
    3.2,
  );

  ctx.font = fSub;
  const rW = ctx.measureText(line1Right).width;
  drawOutlinedText(ctx, line1Right, logicalW - rW - padX, 4, accentCss, isDark, 2.8);

  ctx.font = fReg;
  drawOutlinedText(ctx, line2, padX, 17, isDark ? '#e2e8f0' : '#1e293b', isDark, 2.8);
  drawOutlinedText(ctx, line3, padX, 30, isDark ? '#94a3b8' : '#334155', isDark, 2.6);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, logicalW, logicalH };
}

/**
 * Zero-jitter WebGL-native Label Manager.
 * All text renders cleanly without opaque background boxes (using crisp dark outlines)
 * and updates synchronously in the exact same tick after `controls.update()` & `camera.updateMatrixWorld()`.
 */
export class WebGLLabelManager {
  public readonly root: THREE.Group;

  private groundLabelsGroup: THREE.Group;
  private sectorLabelsGroup: THREE.Group;
  private waypointLabelsGroup: THREE.Group;
  private aircraftLabelsGroup: THREE.Group;

  private leaderLines: THREE.LineSegments;
  private leaderGeo: THREE.BufferGeometry;
  private leaderPosAttr: THREE.BufferAttribute;
  private leaderColAttr: THREE.BufferAttribute;

  private groundLabelEntries: Array<{
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    label: GeoMapLabel;
    x: number;
    z: number;
    baseOpacity: number;
  }> = [];
  private sectorSprites: Array<{
    sprite: THREE.Sprite;
    material: THREE.SpriteMaterial;
    anchor: SectorLabelAnchor;
    logicalW: number;
    logicalH: number;
    baseOpacity: number;
  }> = [];
  private waypointSprites: Array<{
    sprite: THREE.Sprite;
    material: THREE.SpriteMaterial;
    waypoint: Waypoint;
    x: number;
    z: number;
    logicalW: number;
    logicalH: number;
    baseOpacity: number;
  }> = [];
  private aircraftSprites = new Map<string, AircraftSpriteEntry>();
  private textureCache = new Map<string, CachedLabelTexture>();

  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'webgl-labels-root';

    this.groundLabelsGroup = new THREE.Group();
    this.groundLabelsGroup.name = 'webgl-ground-labels';
    this.root.add(this.groundLabelsGroup);

    this.sectorLabelsGroup = new THREE.Group();
    this.sectorLabelsGroup.name = 'webgl-sector-labels';
    this.root.add(this.sectorLabelsGroup);

    this.waypointLabelsGroup = new THREE.Group();
    this.waypointLabelsGroup.name = 'webgl-waypoint-labels';
    this.root.add(this.waypointLabelsGroup);

    this.aircraftLabelsGroup = new THREE.Group();
    this.aircraftLabelsGroup.name = 'webgl-aircraft-labels';
    this.root.add(this.aircraftLabelsGroup);

    const posBuf = new Float32Array(MAX_AIRCRAFT_LEADERS * 2 * 3);
    const colBuf = new Float32Array(MAX_AIRCRAFT_LEADERS * 2 * 3);
    this.leaderGeo = new THREE.BufferGeometry();
    this.leaderPosAttr = new THREE.BufferAttribute(posBuf, 3);
    this.leaderColAttr = new THREE.BufferAttribute(colBuf, 3);
    this.leaderGeo.setAttribute('position', this.leaderPosAttr);
    this.leaderGeo.setAttribute('color', this.leaderColAttr);
    this.leaderGeo.setDrawRange(0, 0);

    const leaderMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
      depthWrite: false,
    });
    this.leaderLines = new THREE.LineSegments(this.leaderGeo, leaderMat);
    this.leaderLines.frustumCulled = false;
    this.leaderLines.renderOrder = 45;
    this.root.add(this.leaderLines);
  }

  private clearGroup(group: THREE.Group): void {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if ((child as THREE.Mesh).geometry) {
        (child as THREE.Mesh).geometry.dispose();
      }
      const mat = (child as THREE.Mesh | THREE.Sprite).material;
      if (mat && !Array.isArray(mat)) {
        if ('map' in mat && mat.map) {
          (mat.map as THREE.Texture).dispose();
        }
        mat.dispose();
      }
    }
  }

  public rebuildStaticLabels(
    baseMap: BaseMapData | undefined,
    sectorAnchors: SectorLabelAnchor[],
    waypoints: Waypoint[],
    projector: LocalENUProjector,
    theme: ThemePreset,
    targetAirportCode = 'UWGG',
    airportCenter: GeoPoint = { lat: projector.originLat, lon: projector.originLon },
  ): void {
    const isDark = theme === 'cinematic-dark';

    this.clearGroup(this.groundLabelsGroup);
    this.clearGroup(this.sectorLabelsGroup);
    this.clearGroup(this.waypointLabelsGroup);
    this.groundLabelEntries = [];
    this.sectorSprites = [];
    this.waypointSprites = [];

    // 1. Flat ground geographic labels (muted background typography, kept clear of airport runway)
    if (baseMap) {
      for (const lbl of baseMap.labels) {
        const rawEnu = projector.toENU(lbl.position.lat, lbl.position.lon, 0);
        const pos =
          lbl.kind === 'CITY'
            ? shiftCityLabelAwayFromRunway(rawEnu.x, rawEnu.z, 19)
            : { x: rawEnu.x, z: rawEnu.z };
        const fontPx = lbl.kind === 'CITY' ? 13 : lbl.kind === 'REGION' ? 11.5 : 10.5;
        const colorCss =
          lbl.kind === 'WATER'
            ? isDark
              ? 'rgba(94, 126, 166, 0.30)'
              : 'rgba(30, 58, 95, 0.42)'
            : isDark
              ? 'rgba(148, 163, 184, 0.25)'
              : 'rgba(30, 41, 59, 0.38)';
        const built = buildCleanTextTexture(
          lbl.text,
          colorCss,
          fontPx,
          lbl.kind === 'CITY' ? 600 : 500,
          isDark,
          0,
          2.2,
        );

        const worldScale = lbl.kind === 'CITY' ? 0.135 : 0.115;
        const planeGeo = new THREE.PlaneGeometry(
          built.logicalW * worldScale,
          built.logicalH * worldScale,
        );
        planeGeo.rotateX(-Math.PI / 2);
        const baseOpacity = isDark ? 0.92 : 0.85;
        const planeMat = new THREE.MeshBasicMaterial({
          map: built.texture,
          transparent: true,
          depthWrite: false,
          opacity: baseOpacity,
        });
        const mesh = new THREE.Mesh(planeGeo, planeMat);
        mesh.position.set(pos.x, 0.13, pos.z);
        mesh.renderOrder = 6;
        this.groundLabelsGroup.add(mesh);
        this.groundLabelEntries.push({
          mesh,
          material: planeMat,
          label: lbl,
          x: pos.x,
          z: pos.z,
          baseOpacity,
        });
      }
    }

    // 2. Clean Background-Free Sector Boundary & Frequency Labels
    for (const anchor of sectorAnchors) {
      const labelText = anchor.frequency ? `${anchor.name} · ${anchor.frequency}` : anchor.name;
      const colorCss = getSectorTagColorCss(anchor.kind, isDark);
      const built = buildCleanTextTexture(labelText, colorCss, 9.5, 600, isDark, 2.6, 0.4);

      const baseOpacity = isDark ? 0.68 : 0.8;
      const mat = new THREE.SpriteMaterial({
        map: built.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: baseOpacity,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.frustumCulled = false;
      sprite.renderOrder = 40;
      this.sectorLabelsGroup.add(sprite);
      this.sectorSprites.push({
        sprite,
        material: mat,
        anchor,
        logicalW: built.logicalW,
        logicalH: built.logicalH,
        baseOpacity,
      });
    }

    // 3. Clean Background-Free Waypoint & Airport Labels (tiered by primary vs secondary vs fixes)
    for (const wp of waypoints) {
      const enu = projector.toENU(wp.lat, wp.lon, 0);
      const cat = classifyWaypoint(wp, targetAirportCode, airportCenter);
      const isPrimaryAirport = cat === 'primary_airport';
      const isSecondaryAirport = cat === 'secondary_airport';
      const colorCss = isPrimaryAirport
        ? isDark
          ? 'rgba(224, 242, 254, 0.94)'
          : 'rgba(15, 23, 42, 0.95)'
        : isSecondaryAirport
          ? isDark
            ? 'rgba(186, 206, 228, 0.78)'
            : 'rgba(30, 41, 59, 0.8)'
          : isDark
            ? 'rgba(148, 163, 184, 0.56)'
            : 'rgba(30, 41, 59, 0.72)';
      const built = buildCleanTextTexture(
        wp.id,
        colorCss,
        isPrimaryAirport ? 11 : isSecondaryAirport ? 9.5 : 9,
        isPrimaryAirport ? 700 : isSecondaryAirport ? 600 : 500,
        isDark,
        2.4,
        0.3,
      );

      const baseOpacity = isPrimaryAirport ? 1.0 : isSecondaryAirport ? 0.88 : 0.84;
      const mat = new THREE.SpriteMaterial({
        map: built.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: baseOpacity,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(enu.x, 0.35, enu.z);
      sprite.frustumCulled = false;
      sprite.renderOrder = isPrimaryAirport ? 38 : 36;
      this.waypointLabelsGroup.add(sprite);
      this.waypointSprites.push({
        sprite,
        material: mat,
        waypoint: wp,
        x: enu.x,
        z: enu.z,
        logicalW: built.logicalW,
        logicalH: built.logicalH,
        baseOpacity,
      });
    }

    this.clearAircraftTextureCache();
  }

  public resetLayoutSmoothing(): void {
    // Datablocks are now rigidly locked to their 3D world anchors with zero lag/inertia.
  }

  private clearAircraftTextureCache(): void {
    for (const entry of this.textureCache.values()) {
      entry.texture.dispose();
    }
    this.textureCache.clear();
    for (const entry of this.aircraftSprites.values()) {
      entry.lastKey = '';
    }
  }

  public syncToCamera(
    camera: THREE.PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number,
    states: Map<string, InterpolatedAircraftState>,
    aircraftColors: Map<string, THREE.Color>,
    settings: SceneSettings,
    selectedCallsign: string | null,
    overrideShowLabels?: boolean,
    targetAirportCode = 'UWGG',
    airportCenter: GeoPoint = { lat: 56.23, lon: 43.78417 },
    cameraDistanceKm = 160,
  ): void {
    const showAircraftLabels = overrideShowLabels ?? settings.showLabels;
    const isDark = settings.theme === 'cinematic-dark';
    const vex = settings.verticalExaggeration;
    const labelScale = settings.labelScale || 1;
    const radarRangeKm = Math.max(40, settings.radarRangeKm || 150);

    this.groundLabelsGroup.visible = settings.showBaseMap;
    this.sectorLabelsGroup.visible = settings.showVolumes;
    this.waypointLabelsGroup.visible = settings.showWaypoints;
    this.aircraftLabelsGroup.visible = showAircraftLabels;
    this.leaderLines.visible = showAircraftLabels;

    camera.matrixWorld.extractBasis(_camRight, _camUp, _camDir);
    _camDir.negate().normalize();

    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const worldPerPixelAtUnitDepth = (2 * tanHalfFov) / Math.max(1, viewportHeight);

    // 0. Ground city & water labels (City Labels mode + overrides + radial Fog-of-War fade)
    if (settings.showBaseMap) {
      for (let i = 0; i < this.groundLabelEntries.length; i++) {
        const g = this.groundLabelEntries[i];
        const allowed = shouldShowGroundLabel(
          g.label,
          settings.cityLabelsMode,
          settings.cityLabelOverrides,
        );
        if (!allowed) {
          g.mesh.visible = false;
          continue;
        }
        const fade = computeRadialFadeAlpha(g.x, g.z, radarRangeKm, 0.72);
        g.mesh.visible = fade > 0.02;
        if (g.mesh.visible) {
          g.material.opacity = g.baseOpacity * fade;
        }
      }
    }

    // 1. Sector boundary & frequency sprites (with radial fade)
    if (settings.showVolumes) {
      for (let i = 0; i < this.sectorSprites.length; i++) {
        const item = this.sectorSprites[i];
        const fade = computeRadialFadeAlpha(item.anchor.x, item.anchor.z, radarRangeKm, 0.75);
        item.sprite.visible = fade > 0.02;
        if (!item.sprite.visible) continue;
        item.material.opacity = item.baseOpacity * fade;

        const yPos = item.anchor.yCeilKm * vex + 0.35;
        item.sprite.position.set(item.anchor.x, yPos, item.anchor.z);
        _rel.subVectors(item.sprite.position, camera.position);
        const depth = Math.max(1, _rel.dot(_camDir));
        const wpp = depth * worldPerPixelAtUnitDepth * labelScale;
        item.sprite.scale.set(item.logicalW * wpp, item.logicalH * wpp, 1);
      }
    }

    // 2. Waypoint & airport sprites (filtered by category, Zoom LOD, secondary mode, overrides & radial fade)
    if (settings.showWaypoints) {
      for (let i = 0; i < this.waypointSprites.length; i++) {
        const item = this.waypointSprites[i];
        const vis = shouldShowWaypoint(item.waypoint, {
          showWaypoints: settings.showWaypoints,
          showEnrouteFixes: settings.showEnrouteFixes,
          showApproachFixes: settings.showApproachFixes,
          secondaryAirportsMode: settings.secondaryAirportsMode,
          waypointOverrides: settings.waypointOverrides,
          targetAirportCode,
          airportCenter,
          cameraDistanceKm,
          radarRangeKm,
        });
        if (!vis.visible) {
          item.sprite.visible = false;
          continue;
        }
        const radialFade = computeRadialFadeAlpha(item.x, item.z, radarRangeKm, 0.75);
        if (radialFade <= 0.02) {
          item.sprite.visible = false;
          continue;
        }
        item.sprite.visible = true;
        item.material.opacity = item.baseOpacity * (vis.dimmed ? 0.38 : 1.0) * radialFade;

        _worldBoxCenter.set(item.x, 0.35, item.z);
        _rel.subVectors(_worldBoxCenter, camera.position);
        const depth = Math.max(1, _rel.dot(_camDir));
        const wpp = depth * worldPerPixelAtUnitDepth * labelScale;
        const offsetX = (item.logicalW * 0.5 + 6) * wpp;
        item.sprite.position.copy(_worldBoxCenter).addScaledVector(_camRight, offsetX);
        item.sprite.scale.set(item.logicalW * wpp, item.logicalH * wpp, 1);
      }
    }

    // 3. Clean Floating Aircraft Datablocks + Subtle Leader Lines (rigidly locked to 3D world anchors, zero border lag)
    if (!showAircraftLabels) {
      this.leaderGeo.setDrawRange(0, 0);
      return;
    }

    for (const entry of this.aircraftSprites.values()) {
      entry.sprite.visible = false;
    }

    const rawLabels: ProjectedLabel[] = [];
    const depthByCallsign = new Map<string, number>();
    const worldAnchorByCallsign = new Map<string, THREE.Vector3>();
    const texByCallsign = new Map<string, CachedLabelTexture>();
    const alphaByCallsign = new Map<string, number>();
    const usedTextureKeys = new Set<string>();

    for (const state of states.values()) {
      const visAlpha = state.visibilityAlpha ?? 1;
      if (visAlpha <= 0.02) continue;

      const yScene = state.y * vex;
      const worldAnchor = new THREE.Vector3(state.x, yScene, state.z);
      _rel.subVectors(worldAnchor, camera.position);
      const depth = _rel.dot(_camDir);
      // Skip strictly behind camera plane
      if (depth <= 1.0) continue;

      _proj.copy(worldAnchor).project(camera);
      if (_proj.z > 1) continue;

      const sx = (_proj.x * 0.5 + 0.5) * viewportWidth;
      const sy = (-_proj.y * 0.5 + 0.5) * viewportHeight;
      // Wide off-screen margin so labels glide naturally off-screen with their aircraft without popping or sticking
      if (sx < -320 || sx > viewportWidth + 320 || sy < -320 || sy > viewportHeight + 320) continue;

      const selected = state.callsign === selectedCallsign;
      const liveCol = aircraftColors.get(state.callsign);
      const accentHex = liveCol ? liveCol.getHex() : 0x38bdf8;
      // Fine 6-bit color quantization so 1.5s color lerping looks silky smooth on position text too
      const qR = (accentHex >> 18) & 0x3f;
      const qG = (accentHex >> 10) & 0x3f;
      const qB = (accentHex >> 2) & 0x3f;
      const quantKey = `${qR}-${qG}-${qB}`;

      const altBucket = settings.datablockMode === 'detailed' ? Math.round(state.altFt / 100) : 0;
      const gsBucket = settings.datablockMode === 'detailed' ? Math.round(state.gsKt / 5) : 0;
      const vrBucket =
        settings.datablockMode === 'detailed'
          ? state.verticalRateFpm > 250
            ? 1
            : state.verticalRateFpm < -250
              ? -1
              : 0
          : 0;
      const cacheKey = `${settings.theme}|${settings.datablockMode}|${state.callsign}|${state.sectorCode ?? 'CTR'}|${selected ? 1 : 0}|${quantKey}|${altBucket}|${gsBucket}|${vrBucket}`;

      let cached = this.textureCache.get(cacheKey);
      if (!cached) {
        cached = buildDatablockTexture(state, settings.datablockMode, isDark, selected, accentHex);
        this.textureCache.set(cacheKey, cached);
      }
      usedTextureKeys.add(cacheKey);

      const w = cached.logicalW * labelScale;
      const h = cached.logicalH * labelScale;

      depthByCallsign.set(state.callsign, depth);
      worldAnchorByCallsign.set(state.callsign, worldAnchor);
      texByCallsign.set(state.callsign, cached);
      alphaByCallsign.set(state.callsign, visAlpha);

      rawLabels.push({
        callsign: state.callsign,
        anchorX: sx,
        anchorY: sy,
        boxX: sx + 16,
        boxY: sy - h * 0.5 - 6,
        width: w,
        height: h,
        altFt: state.altFt,
        gsKt: state.gsKt,
        verticalRateFpm: state.verticalRateFpm,
        aircraftType: state.aircraftType,
        destination: state.destination,
        clearedFl: state.clearedFl,
        sidOrStar: state.sidOrStar,
        sectorCode: state.sectorCode,
        selected,
      });
    }

    const resolved = resolveLabelOverlaps(rawLabels, viewportWidth, viewportHeight, 5);

    let leaderIdx = 0;
    for (let i = 0; i < resolved.length; i++) {
      const lb = resolved[i];
      const depth = depthByCallsign.get(lb.callsign);
      const worldAnchor = worldAnchorByCallsign.get(lb.callsign);
      const cached = texByCallsign.get(lb.callsign);
      const visAlpha = alphaByCallsign.get(lb.callsign) ?? 1;
      if (depth === undefined || !worldAnchor || !cached) continue;

      let entry = this.aircraftSprites.get(lb.callsign);
      if (!entry) {
        const mat = new THREE.SpriteMaterial({
          map: cached.texture,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.frustumCulled = false;
        sprite.renderOrder = 52;
        this.aircraftLabelsGroup.add(sprite);
        entry = { sprite, material: mat, lastKey: '' };
        this.aircraftSprites.set(lb.callsign, entry);
      }

      if (entry.material.map !== cached.texture) {
        entry.material.map = cached.texture;
        entry.material.needsUpdate = true;
      }
      entry.material.opacity = visAlpha;

      const wpp = depth * worldPerPixelAtUnitDepth;
      // Direct instantaneous world-space lock (zero viewport-edge damping lag!)
      const dxPx = lb.boxX + lb.width * 0.5 - lb.anchorX;
      const dyPx = lb.boxY + lb.height * 0.5 - lb.anchorY;

      const dxWorld = dxPx * wpp;
      const dyWorld = -dyPx * wpp;

      _worldBoxCenter
        .copy(worldAnchor)
        .addScaledVector(_camRight, dxWorld)
        .addScaledVector(_camUp, dyWorld);

      entry.sprite.position.copy(_worldBoxCenter);
      entry.sprite.scale.set(lb.width * wpp, lb.height * wpp, 1);
      entry.sprite.renderOrder = lb.selected ? 58 : 52;
      entry.sprite.visible = true;

      if (leaderIdx < MAX_AIRCRAFT_LEADERS) {
        const attachLeft = dxPx >= 0;
        const edgeShiftWorld = (attachLeft ? -lb.width * 0.5 + 3 : lb.width * 0.5 - 3) * wpp;
        _worldEdge.copy(_worldBoxCenter).addScaledVector(_camRight, edgeShiftWorld);

        const v0 = leaderIdx * 2;
        const v1 = v0 + 1;
        this.leaderPosAttr.setXYZ(v0, worldAnchor.x, worldAnchor.y, worldAnchor.z);
        this.leaderPosAttr.setXYZ(v1, _worldEdge.x, _worldEdge.y, _worldEdge.z);

        const col = aircraftColors.get(lb.callsign);
        const boost = lb.selected ? 1.15 : 1.0;
        const fadeScale = visAlpha;
        const r = Math.min(1, (col ? col.r : isDark ? 0.49 : 0.12) * boost) * fadeScale;
        const g = Math.min(1, (col ? col.g : isDark ? 0.83 : 0.16) * boost) * fadeScale;
        const b = Math.min(1, (col ? col.b : isDark ? 0.99 : 0.23) * boost) * fadeScale;

        this.leaderColAttr.setXYZ(v0, r, g, b);
        this.leaderColAttr.setXYZ(v1, r * 0.7, g * 0.7, b * 0.7);
        leaderIdx++;
      }
    }

    // Safe post-loop LRU eviction of unused textures so bound sprites are never disposed mid-frame
    if (this.textureCache.size > 480) {
      for (const [key, entry] of this.textureCache.entries()) {
        if (!usedTextureKeys.has(key)) {
          entry.texture.dispose();
          this.textureCache.delete(key);
          if (this.textureCache.size <= 360) break;
        }
      }
    }

    this.leaderPosAttr.needsUpdate = true;
    this.leaderColAttr.needsUpdate = true;
    this.leaderGeo.setDrawRange(0, leaderIdx * 2);
  }

  public dispose(): void {
    this.clearGroup(this.groundLabelsGroup);
    this.clearGroup(this.sectorLabelsGroup);
    this.clearGroup(this.waypointLabelsGroup);
    for (const entry of this.aircraftSprites.values()) {
      entry.material.dispose();
    }
    this.aircraftSprites.clear();
    this.clearAircraftTextureCache();
    this.leaderGeo.dispose();
    (this.leaderLines.material as THREE.Material).dispose();
  }
}
