import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import type {
  AirspaceDataset,
  AirportTrafficCounters,
  CameraKeyframe,
  CameraPresetId,
  InterpolatedAircraftState,
  RadarDataset,
  SceneSettings,
} from '../types/radar';
import { LocalENUProjector } from '../core/geo';
import {
  getSectorControlColorHex,
  resolveAircraftController,
  type HysteresisState,
} from '../core/airspaceZones';
import {
  buildAirportFlightEventIndex,
  computeAirportTrafficCounters,
  type AirportFlightEventIndex,
} from '../core/airportTrafficStats';
import { computeAircraftVisibilityAlpha } from '../core/groundFilter';
import { computeRadialFadeAlpha } from '../core/radialFog';
import {
  APPROACH_FIX_LOD_MAX_CAMERA_DIST_KM,
  shouldShowWaypoint,
} from '../core/waypointFilter';
import { evaluateAircraftAtTime, evaluateCameraKeyframes } from '../core/trajectory';
import { focalLengthMmToFovDeg, sampleCameraPathPreview } from '../core/cameraRig';
import { SCENE_THEMES } from './themes';
import {
  applyDynamicColorToAircraftActor,
  createAircraftActor,
  disposeAircraftActor,
  type AircraftActor,
} from './aircraftMesh';
import { buildAirspaceScene, type AirspaceSceneHandles } from './airspaceBuilder';
import {
  applyThemeToTrailRig,
  createAircraftTrailRig,
  updateAircraftTrailRig,
  type AircraftTrailRig,
} from './trailSystem';
import { WebGLLabelManager } from './webglLabels';

export interface SceneCallbacks {
  onSelectAircraft: (callsign: string | null) => void;
  onActiveCountChange: (activeCount: number) => void;
  onActiveCallsignsChange?: (callsigns: string[]) => void;
  onAirportStatsChange?: (stats: AirportTrafficCounters) => void;
  onTimeAdvance: (newTimeSec: number) => void;
}

const CAMERA_PRESETS: Record<
  CameraPresetId,
  { position: [number, number, number]; target: [number, number, number] }
> = {
  'tactical-top': { position: [12, 168, 82], target: [14, 4, -2] },
  'iso-south': { position: [14, 114, 132], target: [12, 10, -6] },
  'approach-low': { position: [-42, 40, 72], target: [4, 11, -8] },
  'orbit-wide': { position: [148, 126, 144], target: [10, 12, -8] },
};

// Reusable scratch vectors/colors/quaternions outside render loop (zero per-frame allocations)
const _targetPos = new THREE.Vector3();
const _followDelta = new THREE.Vector3();
const _rayPointer = new THREE.Vector2();
const _targetColor = new THREE.Color();
const _targetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _targetQuat = new THREE.Quaternion();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export class RadarSceneEngine {
  public readonly isSoftwareGl: boolean;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private keyLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private rimLight: THREE.DirectionalLight;

  private container: HTMLElement;
  private callbacks: SceneCallbacks;
  private projector: LocalENUProjector;
  private airspaceDataset: AirspaceDataset;
  private radarDataset: RadarDataset;
  private settings: SceneSettings;

  private airspaceHandles: AirspaceSceneHandles | null = null;
  private labelManager: WebGLLabelManager;
  private aircraftGroup: THREE.Group;
  private trailsGroup: THREE.Group;
  private cameraPathGroup: THREE.Group;
  private cameraPathLine: THREE.Line;
  private cameraPathNodes: THREE.Points;
  private actors = new Map<string, AircraftActor>();
  private trailRigs = new Map<string, AircraftTrailRig>();
  private hitProxies: THREE.Object3D[] = [];
  private latestStates = new Map<string, InterpolatedAircraftState>();
  private aircraftColors = new Map<string, THREE.Color>();
  private controllerHysteresis = new Map<string, HysteresisState>();
  private airportEventIndex: AirportFlightEventIndex;

  private raycaster = new THREE.Raycaster();
  private pointerDownPos = { x: 0, y: 0 };

  // Playback & camera state
  private simTimeSec = 0;
  private isPlaying = false;
  private speedMultiplier = 15;
  private selectedCallsign: string | null = null;
  private followSelected = false;
  private followPrevAircraftPos: THREE.Vector3 | null = null;
  private followTrackCallsign: string | null = null;
  private useKeyframes = false;
  private keyframes: CameraKeyframe[] = [];
  private cinemaModeHidden = false;

  // Smooth camera transition goal (cancelled immediately when user orbits)
  private transitionGoal: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  // Frame loop / software-WebGL pacing handles
  private frameId = 0;
  private lastWallMs = 0;
  private lastActiveCount = -1;
  private lastActiveKey = '';
  private lastAirportStatsKey = '';
  private lastWpFilterKey = '';
  private lastTimeEmitMs = 0;
  private renderBusy = false;
  private renderDirty = false;
  private disposed = false;
  private isExporting = false;

  constructor(
    container: HTMLElement,
    airspace: AirspaceDataset,
    radar: RadarDataset,
    initialSettings: SceneSettings,
    callbacks: SceneCallbacks,
  ) {
    this.container = container;
    this.airspaceDataset = airspace;
    this.radarDataset = radar;
    this.settings = { ...initialSettings };
    this.callbacks = callbacks;
    this.simTimeSec = radar.startTime + Math.min(180, (radar.endTime - radar.startTime) * 0.14);
    this.projector = new LocalENUProjector(airspace.center);
    this.airportEventIndex = buildAirportFlightEventIndex(
      radar.tracks,
      airspace.airportCode,
      airspace.center,
      airspace.airportElevationFt,
    );

    this.isSoftwareGl = detectSoftwareWebGL();

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    // Studio environment map on all devices for realistic metallic/specular aircraft reflection
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const initFov = focalLengthMmToFovDeg(this.settings.focalLengthMm || 30);
    this.camera = new THREE.PerspectiveCamera(initFov, width / height, 0.5, 2400);
    const initPreset = CAMERA_PRESETS['iso-south'];
    this.camera.position.set(...initPreset.position);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(...initPreset.target);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = Math.max(0.02, Math.min(0.25, this.settings.orbitDamping || 0.07));
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 680;
    this.controls.update();

    this.controls.addEventListener('start', () => {
      this.transitionGoal = null;
    });
    this.controls.addEventListener('change', () => {
      if (!this.isPlaying && !this.isExporting) {
        this.requestRender();
      }
    });

    // Warm/cool 3-point studio lighting rig
    const palette = SCENE_THEMES[this.settings.theme];
    this.keyLight = new THREE.DirectionalLight(palette.keyLightHex, palette.keyLightIntensity);
    this.keyLight.position.set(140, 220, 120);
    this.keyLight.castShadow = !this.isSoftwareGl;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.keyLight);

    this.hemiLight = new THREE.HemisphereLight(
      palette.hemiSkyHex,
      palette.hemiGroundHex,
      palette.hemiIntensity,
    );
    this.scene.add(this.hemiLight);

    this.rimLight = new THREE.DirectionalLight(0x93c5fd, 0.5);
    this.rimLight.position.set(-160, 90, -140);
    this.scene.add(this.rimLight);

    // Post-processing composer (GPU only; bypassed on software WebGL)
    if (!this.isSoftwareGl) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        this.settings.bloomStrength,
        0.52,
        0.66,
      );
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    }

    this.aircraftGroup = new THREE.Group();
    this.aircraftGroup.name = 'aircraft-layer';
    this.scene.add(this.aircraftGroup);

    this.trailsGroup = new THREE.Group();
    this.trailsGroup.name = 'trails-layer';
    this.scene.add(this.trailsGroup);

    // Subtle 3D Camera Path preview curve (visible only in editor when showCameraPath is ON; auto-hidden in CinemaHUD & Export)
    this.cameraPathGroup = new THREE.Group();
    this.cameraPathGroup.name = 'camera-path-preview';
    const pathLineGeo = new THREE.BufferGeometry();
    const pathLineMat = new THREE.LineDashedMaterial({
      color: 0xf59e0b,
      dashSize: 3.5,
      gapSize: 2.2,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.cameraPathLine = new THREE.Line(pathLineGeo, pathLineMat);
    this.cameraPathLine.frustumCulled = false;
    this.cameraPathLine.renderOrder = 32;
    this.cameraPathGroup.add(this.cameraPathLine);

    const pathNodesGeo = new THREE.BufferGeometry();
    const pathNodesMat = new THREE.PointsMaterial({
      color: 0xfbbf24,
      size: 4.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.cameraPathNodes = new THREE.Points(pathNodesGeo, pathNodesMat);
    this.cameraPathNodes.frustumCulled = false;
    this.cameraPathNodes.renderOrder = 33;
    this.cameraPathGroup.add(this.cameraPathNodes);
    this.cameraPathGroup.visible = false;
    this.scene.add(this.cameraPathGroup);

    this.labelManager = new WebGLLabelManager();
    this.scene.add(this.labelManager.root);

    this.applyThemeEnvironment();
    this.rebuildAirspace();
    this.rebuildAircraftActors();
    this.updateSimulationAt(this.simTimeSec, 0.016, true);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);

    this.requestRender();
  }

  private handleContextLost = (e: Event) => {
    e.preventDefault();
  };

  private handlePointerDown = (e: PointerEvent) => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private handlePointerUp = (e: PointerEvent) => {
    const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (dist > 6) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    _rayPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _rayPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(_rayPointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.hitProxies, false);
    if (hits.length > 0) {
      const callsign = hits[0].object.userData?.callsign as string | undefined;
      if (callsign) {
        this.callbacks.onSelectAircraft(callsign);
        return;
      }
    }
  };

  private applyThemeEnvironment(): void {
    const palette = SCENE_THEMES[this.settings.theme];
    this.scene.background = new THREE.Color(palette.backgroundHex);
    this.scene.fog = new THREE.FogExp2(palette.fogHex, palette.fogDensity);
    this.keyLight.color.setHex(palette.keyLightHex);
    this.keyLight.intensity = palette.keyLightIntensity;
    this.hemiLight.color.setHex(palette.hemiSkyHex);
    this.hemiLight.groundColor.setHex(palette.hemiGroundHex);
    this.hemiLight.intensity = palette.hemiIntensity;
    if (this.bloomPass) {
      this.bloomPass.strength = palette.useBloom ? this.settings.bloomStrength : 0;
    }
  }

  private rebuildAirspace(): void {
    if (this.airspaceHandles) {
      this.scene.remove(this.airspaceHandles.root);
      this.airspaceHandles.dispose();
    }
    const palette = SCENE_THEMES[this.settings.theme];
    this.airspaceHandles = buildAirspaceScene(
      this.airspaceDataset,
      this.projector,
      palette,
      this.settings.verticalExaggeration,
      this.settings.showSectorFill,
      this.settings.radarRangeKm,
      this.settings.showUrbanGlow,
      this.settings.showCityRoads,
    );
    this.airspaceHandles.baseMapGroup.visible = this.settings.showBaseMap;
    this.airspaceHandles.setUrbanGlowVisible(this.settings.showUrbanGlow);
    this.airspaceHandles.setCityRoadsVisible(this.settings.showCityRoads);
    this.airspaceHandles.volumesGroup.visible = this.settings.showVolumes;
    this.airspaceHandles.sectorFillGroup.visible = this.settings.showSectorFill;
    this.airspaceHandles.setProcedureVisibility(
      this.settings.procedureVisibility,
      this.settings.showAirways,
    );
    this.airspaceHandles.restrictedGroup.visible = this.settings.showRestricted;
    this.airspaceHandles.waypointsGroup.visible = this.settings.showWaypoints;
    this.lastWpFilterKey = '';
    this.scene.add(this.airspaceHandles.root);

    this.labelManager.rebuildStaticLabels(
      this.airspaceDataset.baseMap,
      this.airspaceHandles.sectorLabelAnchors,
      this.airspaceDataset.waypoints,
      this.projector,
      this.settings.theme,
      this.airspaceDataset.airportCode,
      this.airspaceDataset.center,
    );
  }

  private rebuildAircraftActors(): void {
    for (const actor of this.actors.values()) {
      this.aircraftGroup.remove(actor.root);
      disposeAircraftActor(actor);
    }
    this.actors.clear();
    this.aircraftColors.clear();

    for (const rig of this.trailRigs.values()) {
      this.trailsGroup.remove(rig.root);
      rig.dispose();
    }
    this.trailRigs.clear();
    this.hitProxies = [];

    const palette = SCENE_THEMES[this.settings.theme];
    for (const track of this.radarDataset.tracks) {
      const actor = createAircraftActor(track.callsign, palette);
      this.aircraftGroup.add(actor.root);
      this.actors.set(track.callsign, actor);
      this.aircraftColors.set(track.callsign, actor.currentColor);
      this.hitProxies.push(actor.hitProxy);

      const rig = createAircraftTrailRig(track.callsign, palette);
      applyThemeToTrailRig(rig, palette, track.callsign === this.selectedCallsign);
      this.trailsGroup.add(rig.root);
      this.trailRigs.set(track.callsign, rig);
    }
  }

  public setAirspaceDataset(airspace: AirspaceDataset): void {
    this.airspaceDataset = airspace;
    this.projector = new LocalENUProjector(airspace.center);
    this.controllerHysteresis.clear();
    this.labelManager.resetLayoutSmoothing();
    this.airportEventIndex = buildAirportFlightEventIndex(
      this.radarDataset.tracks,
      airspace.airportCode,
      airspace.center,
      airspace.airportElevationFt,
    );
    this.lastAirportStatsKey = '';
    this.rebuildAirspace();
    this.updateSimulationAt(this.simTimeSec, 0.016, true);
    this.requestRender();
  }

  public setRadarDataset(radar: RadarDataset): void {
    this.radarDataset = radar;
    this.simTimeSec = radar.startTime;
    this.controllerHysteresis.clear();
    this.labelManager.resetLayoutSmoothing();
    this.followPrevAircraftPos = null;
    this.followTrackCallsign = null;
    this.airportEventIndex = buildAirportFlightEventIndex(
      radar.tracks,
      this.airspaceDataset.airportCode,
      this.airspaceDataset.center,
      this.airspaceDataset.airportElevationFt,
    );
    this.lastAirportStatsKey = '';
    this.lastActiveKey = '';
    this.rebuildAircraftActors();
    this.updateSimulationAt(this.simTimeSec, 0.016, true);
    this.requestRender();
  }

  public updateSettings(next: SceneSettings): void {
    const themeChanged = next.theme !== this.settings.theme;
    const vexChanged = next.verticalExaggeration !== this.settings.verticalExaggeration;
    const tensionChanged = next.cameraTension !== this.settings.cameraTension;
    const focalChanged = next.focalLengthMm !== this.settings.focalLengthMm;
    this.settings = { ...next };

    if (!this.isSoftwareGl) {
      this.controls.dampingFactor = Math.max(0.02, Math.min(0.25, this.settings.orbitDamping || 0.07));
    }

    if (focalChanged && (!this.useKeyframes || this.keyframes.length < 2)) {
      this.camera.fov = focalLengthMmToFovDeg(this.settings.focalLengthMm || 30);
      this.camera.updateProjectionMatrix();
    }

    if (themeChanged) {
      this.applyThemeEnvironment();
      this.rebuildAirspace();
      const palette = SCENE_THEMES[this.settings.theme];
      for (const [cs, rig] of this.trailRigs.entries()) {
        applyThemeToTrailRig(rig, palette, cs === this.selectedCallsign);
      }
    } else if (this.bloomPass) {
      this.bloomPass.strength = SCENE_THEMES[this.settings.theme].useBloom
        ? this.settings.bloomStrength
        : 0;
    }

    if (this.airspaceHandles) {
      if (vexChanged) {
        this.airspaceHandles.setVerticalExaggeration(this.settings.verticalExaggeration);
      }
      this.airspaceHandles.setRadarRange(this.settings.radarRangeKm);
      this.airspaceHandles.baseMapGroup.visible = this.settings.showBaseMap;
      this.airspaceHandles.setUrbanGlowVisible(this.settings.showUrbanGlow);
      this.airspaceHandles.setCityRoadsVisible(this.settings.showCityRoads);
      this.airspaceHandles.volumesGroup.visible = this.settings.showVolumes;
      this.airspaceHandles.sectorFillGroup.visible = this.settings.showSectorFill;
      this.airspaceHandles.setProcedureVisibility(
        this.settings.procedureVisibility,
        this.settings.showAirways,
      );
      this.airspaceHandles.restrictedGroup.visible = this.settings.showRestricted;
      this.airspaceHandles.waypointsGroup.visible = this.settings.showWaypoints;
      this.lastWpFilterKey = '';
    }

    if (tensionChanged || themeChanged) {
      this.rebuildCameraPathPreview();
    } else {
      this.syncCameraPathPreviewVisibility();
    }

    this.updateSimulationAt(this.simTimeSec, 0.016, themeChanged);
    this.requestRender();
  }

  public setPlaybackState(playing: boolean, speedMultiplier: number): void {
    const wasPlaying = this.isPlaying;
    this.isPlaying = playing;
    this.speedMultiplier = speedMultiplier;
    if (playing && !wasPlaying) {
      this.lastWallMs = performance.now();
      this.scheduleNextPlayFrame();
    } else if (!playing && wasPlaying) {
      this.cancelPendingFrames();
      this.requestRender();
    }
  }

  public setSimTime(timeSec: number): void {
    this.simTimeSec = Math.max(
      this.radarDataset.startTime,
      Math.min(this.radarDataset.endTime, timeSec),
    );
    this.controllerHysteresis.clear();
    this.labelManager.resetLayoutSmoothing();
    this.followPrevAircraftPos = null;
    this.updateSimulationAt(this.simTimeSec, 0.016, true);
    this.requestRender();
  }

  public setSelectedAircraft(callsign: string | null, follow: boolean): void {
    const followChanged = follow !== this.followSelected || callsign !== this.selectedCallsign;
    this.selectedCallsign = callsign;
    this.followSelected = follow;
    if (followChanged) {
      this.followPrevAircraftPos = null;
      this.followTrackCallsign = null;
    }
    const palette = SCENE_THEMES[this.settings.theme];
    for (const [cs, rig] of this.trailRigs.entries()) {
      applyThemeToTrailRig(rig, palette, cs === callsign);
    }
    this.updateSimulationAt(this.simTimeSec, 0.016, false);
    this.requestRender();
  }

  public setCinemaMode(hidden: boolean): void {
    this.cinemaModeHidden = hidden;
    this.syncCameraPathPreviewVisibility();
    this.requestRender();
  }

  private syncCameraPathPreviewVisibility(): void {
    this.cameraPathGroup.visible =
      Boolean(this.settings.showCameraPath) &&
      this.keyframes.length >= 2 &&
      !this.cinemaModeHidden &&
      !this.isExporting;
  }

  private rebuildCameraPathPreview(): void {
    const sorted = [...this.keyframes].sort((a, b) => a.timeSec - b.timeSec);
    if (sorted.length < 2) {
      this.cameraPathGroup.visible = false;
      return;
    }
    const pts = sampleCameraPathPreview(sorted, this.settings.cameraTension ?? 0.5, 96);
    this.cameraPathLine.geometry.dispose();
    const nextLineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    this.cameraPathLine.geometry = nextLineGeo;
    this.cameraPathLine.computeLineDistances();

    const nodePts = sorted.map((k) => new THREE.Vector3(...k.position));
    this.cameraPathNodes.geometry.dispose();
    this.cameraPathNodes.geometry = new THREE.BufferGeometry().setFromPoints(nodePts);

    const lineMat = this.cameraPathLine.material as THREE.LineDashedMaterial;
    const nodeMat = this.cameraPathNodes.material as THREE.PointsMaterial;
    const isDark = this.settings.theme === 'cinematic-dark';
    lineMat.color.setHex(isDark ? 0xf59e0b : 0xb45309);
    lineMat.opacity = isDark ? 0.42 : 0.62;
    nodeMat.color.setHex(isDark ? 0xfbbf24 : 0xd97706);

    this.syncCameraPathPreviewVisibility();
  }

  public setKeyframes(keyframes: CameraKeyframe[], enabled: boolean): void {
    this.keyframes = keyframes;
    this.useKeyframes = enabled;
    this.rebuildCameraPathPreview();
    if (enabled && keyframes.length >= 2) {
      this.applyKeyframeCamera(this.simTimeSec);
    } else {
      const targetFov = focalLengthMmToFovDeg(this.settings.focalLengthMm || 30);
      if (Math.abs(this.camera.fov - targetFov) > 0.05) {
        this.camera.fov = targetFov;
        this.camera.updateProjectionMatrix();
      }
    }
    this.requestRender();
  }

  public captureCurrentCamera(): {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
  } {
    return {
      position: [
        Number(this.camera.position.x.toFixed(2)),
        Number(this.camera.position.y.toFixed(2)),
        Number(this.camera.position.z.toFixed(2)),
      ],
      target: [
        Number(this.controls.target.x.toFixed(2)),
        Number(this.controls.target.y.toFixed(2)),
        Number(this.controls.target.z.toFixed(2)),
      ],
      fov: Number(this.camera.fov.toFixed(2)),
    };
  }

  public jumpToCameraPreset(presetId: CameraPresetId): void {
    const p = CAMERA_PRESETS[presetId];
    if (!p) return;
    if (this.isSoftwareGl) {
      this.camera.position.set(...p.position);
      this.controls.target.set(...p.target);
      this.controls.update();
      this.requestRender();
    } else {
      this.transitionGoal = {
        pos: new THREE.Vector3(...p.position),
        target: new THREE.Vector3(...p.target),
      };
      this.requestRender();
    }
  }

  public resize(): void {
    if (this.disposed || this.isExporting) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    if (this.composer) {
      this.composer.setSize(width, height);
    }
    if (this.bloomPass) {
      this.bloomPass.resolution.set(width, height);
    }
    this.requestRender();
  }

  private applyKeyframeCamera(timeSec: number): void {
    const defaultFovDeg = focalLengthMmToFovDeg(this.settings.focalLengthMm || 30);
    const kf = evaluateCameraKeyframes(this.keyframes, timeSec, {
      easing: this.settings.cameraEasing,
      tension: this.settings.cameraTension,
      defaultFovDeg,
    });
    if (!kf) return;
    this.camera.position.set(kf.position[0], kf.position[1], kf.position[2]);
    this.controls.target.set(kf.target[0], kf.target[1], kf.target[2]);
    const nextFov = kf.fov ?? defaultFovDeg;
    if (Math.abs(this.camera.fov - nextFov) > 0.05) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateSimulationAt(timeSec: number, dtSec = 0.016, instantColors = false): void {
    const palette = SCENE_THEMES[this.settings.theme];
    const vex = this.settings.verticalExaggeration;
    const altSmoothSec = this.settings.altSmoothSec;
    // Smooth ~1.5s wall-clock sector handoff color transition (tau = 0.55s)
    const colorLerpFactor = instantColors ? 1 : 1 - Math.exp(-Math.min(0.25, dtSec) / 0.55);
    // Smooth Quaternion.slerp aircraft attitude damping (tau = 0.28s) to eliminate twitchy manual flights
    const attitudeSlerpFactor = instantColors ? 1 : 1 - Math.exp(-Math.min(0.15, dtSec) / 0.28);

    this.latestStates.clear();
    for (const track of this.radarDataset.tracks) {
      const actor = this.actors.get(track.callsign);
      const rig = this.trailRigs.get(track.callsign);
      if (!actor || !rig) continue;

      // 3D spline evaluation with zero-phase 3D Gaussian smoothing (X, Y, Z) & Vertical Exaggeration
      const state = evaluateAircraftAtTime(track, timeSec, this.projector, vex, altSmoothSec);
      if (!state) {
        actor.root.visible = false;
        actor.attitudeInitialized = false;
        rig.root.visible = false;
        continue;
      }

      // Ground traffic hiding + Radial Fog-of-War fade (80%..100% of Radar Range)
      const groundAlpha = computeAircraftVisibilityAlpha(
        track,
        timeSec,
        state.altFt,
        state.gsKt,
        this.airspaceDataset.airportElevationFt,
        this.settings.hideGroundTraffic,
      );
      const radialAlpha = computeRadialFadeAlpha(
        state.x,
        state.z,
        this.settings.radarRangeKm,
        0.8,
      );
      const visAlpha = groundAlpha * radialAlpha;
      if (visAlpha <= 0.01) {
        actor.root.visible = false;
        actor.attitudeInitialized = false;
        rig.root.visible = false;
        continue;
      }

      // Log-driven ATC controller resolution first; geometric 3D polygon + temporal hysteresis fallback only if absent
      const sector = resolveAircraftController(
        track.controllerEvents,
        timeSec,
        state.lat,
        state.lon,
        state.altFt,
        this.airspaceDataset.volumes,
        this.controllerHysteresis,
        track.callsign,
        4.5,
        this.airspaceDataset.airportElevationFt,
      );
      state.sectorCode = sector.sectorCode;
      state.sectorKind = sector.kind;
      state.sectorId = sector.sectorId;
      state.visibilityAlpha = visAlpha;

      const targetHex = getSectorControlColorHex(sector.kind, palette.isDark);
      _targetColor.setHex(targetHex);
      if (!actor.colorInitialized || instantColors) {
        actor.currentColor.copy(_targetColor);
        actor.colorInitialized = true;
      } else {
        actor.currentColor.lerp(_targetColor, colorLerpFactor);
      }

      const selected = track.callsign === this.selectedCallsign;
      this.latestStates.set(track.callsign, state);
      actor.root.visible = true;

      const yScene = state.y * vex;
      actor.root.position.set(state.x, yScene, state.z);

      // Smooth Quaternion.slerp 3D Aircraft Attitude with strictly clamped pitch/bank (graceful turns, zero twitching)
      const hdgRad = (state.headingDeg * Math.PI) / 180;
      const clampedPitch = Math.max(-0.48, Math.min(0.48, state.visualPitchRad));
      const clampedBank = Math.max(-0.52, Math.min(0.52, state.bankRad));
      _targetEuler.set(clampedPitch, -hdgRad, -clampedBank, 'YXZ');
      _targetQuat.setFromEuler(_targetEuler);
      if (!actor.attitudeInitialized || instantColors) {
        actor.attitudeQuat.copy(_targetQuat);
        actor.attitudeInitialized = true;
      } else {
        actor.attitudeQuat.slerp(_targetQuat, attitudeSlerpFactor);
      }
      actor.modelGroup.quaternion.copy(actor.attitudeQuat);

      // Compact 3D Velocity Vector Line pointing along 3D spline tangent (2x shorter with smooth tip fade)
      const vecLenKm = Math.max(1.8, Math.min(5.8, state.gsKt * 0.0115));
      const velAttr = actor.velocityLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      velAttr.setXYZ(0, 0, 0, 0);
      velAttr.setXYZ(
        1,
        state.tangent3D[0] * vecLenKm,
        state.tangent3D[1] * vecLenKm,
        state.tangent3D[2] * vecLenKm,
      );
      velAttr.needsUpdate = true;

      // Vertical drop stem to ground Y=0 (hidden by default unless user enables showDropStems)
      if (this.settings.showDropStems) {
        const stemAttr = actor.dropStem.geometry.getAttribute('position') as THREE.BufferAttribute;
        stemAttr.setXYZ(0, 0, 0, 0);
        stemAttr.setXYZ(1, 0, -yScene, 0);
        stemAttr.needsUpdate = true;
      }

      applyDynamicColorToAircraftActor(
        actor,
        actor.currentColor,
        palette,
        selected,
        visAlpha,
        this.settings.showDropStems,
      );

      updateAircraftTrailRig(
        rig,
        track,
        state,
        timeSec,
        this.settings.trailLengthSec,
        this.settings.trailStyle,
        vex,
        this.projector,
        this.airspaceDataset.volumes,
        palette,
        actor.currentColor,
        selected,
        visAlpha,
        altSmoothSec,
        this.airspaceDataset.airportElevationFt,
        this.settings.radarRangeKm,
      );
    }

    // Camera choreography:
    // 1) Keyframe path takes priority when enabled
    // 2) True Free-Orbit Follow Mode: translate BOTH controls.target and camera.position by aircraft displacement delta
    //    so user retains unrestricted 360° orbit & zoom around the tracked aircraft at all times.
    if (this.useKeyframes && this.keyframes.length >= 2) {
      this.followPrevAircraftPos = null;
      this.applyKeyframeCamera(timeSec);
    } else if (this.followSelected && this.selectedCallsign) {
      const targetState = this.latestStates.get(this.selectedCallsign);
      if (targetState) {
        const yScene = targetState.y * vex;
        _targetPos.set(targetState.x, yScene, targetState.z);
        if (!this.followPrevAircraftPos || this.followTrackCallsign !== this.selectedCallsign) {
          // Initial lock onto aircraft: move OrbitControls pivot onto aircraft while preserving current viewing angle/offset
          _followDelta.subVectors(_targetPos, this.controls.target);
          this.controls.target.copy(_targetPos);
          this.camera.position.add(_followDelta);
          this.followPrevAircraftPos = _targetPos.clone();
          this.followTrackCallsign = this.selectedCallsign;
        } else {
          // Subsequent frames: translate both pivot and camera strictly by aircraft movement delta
          _followDelta.subVectors(_targetPos, this.followPrevAircraftPos);
          if (_followDelta.lengthSq() > 1e-10) {
            this.controls.target.add(_followDelta);
            this.camera.position.add(_followDelta);
            this.followPrevAircraftPos.copy(_targetPos);
          }
        }
      }
    } else {
      this.followPrevAircraftPos = null;
      this.followTrackCallsign = null;
      if (this.transitionGoal) {
        const damp = 1 - Math.exp(-6.5 * Math.min(0.1, dtSec));
        this.camera.position.lerp(this.transitionGoal.pos, damp);
        this.controls.target.lerp(this.transitionGoal.target, damp);
        if (
          this.camera.position.distanceTo(this.transitionGoal.pos) < 0.2 &&
          this.controls.target.distanceTo(this.transitionGoal.target) < 0.2
        ) {
          this.camera.position.copy(this.transitionGoal.pos);
          this.controls.target.copy(this.transitionGoal.target);
          this.transitionGoal = null;
        }
      }
    }

    if (this.latestStates.size !== this.lastActiveCount) {
      this.lastActiveCount = this.latestStates.size;
      this.callbacks.onActiveCountChange(this.lastActiveCount);
    }

    if (this.callbacks.onActiveCallsignsChange) {
      const activeList = Array.from(this.latestStates.keys()).sort();
      const activeKey = activeList.join(',');
      if (activeKey !== this.lastActiveKey) {
        this.lastActiveKey = activeKey;
        this.callbacks.onActiveCallsignsChange(activeList);
      }
    }

    if (this.callbacks.onAirportStatsChange) {
      const stats = computeAirportTrafficCounters(this.airportEventIndex, timeSec);
      const statsKey = `${stats.airborne}:${stats.landed}`;
      if (statsKey !== this.lastAirportStatsKey) {
        this.lastAirportStatsKey = statsKey;
        this.callbacks.onAirportStatsChange(stats);
      }
    }
  }

  /**
   * Synchronize camera matrices, update all WebGL text labels & leader lines in the EXACT same tick,
   * and render the frame. Guarantees zero camera-drag jitter and native WebM video export baking.
   */
  private renderCurrentFrame(
    overrideWidth?: number,
    overrideHeight?: number,
    overrideShowLabels?: boolean,
    overrideDtSec?: number,
    overrideSnapLabels?: boolean,
  ): void {
    this.controls.update();
    this.camera.updateMatrixWorld();

    void overrideDtSec;
    void overrideSnapLabels;

    const width = overrideWidth ?? Math.max(1, this.container.clientWidth);
    const height = overrideHeight ?? Math.max(1, this.container.clientHeight);
    const cameraDistanceKm = this.camera.position.distanceTo(this.controls.target);

    // Sync 3D waypoint star markers whenever filter settings or Zoom LOD tier change
    if (this.airspaceHandles) {
      const lodHidden = cameraDistanceKm > APPROACH_FIX_LOD_MAX_CAMERA_DIST_KM;
      const wpKey = `${this.settings.showWaypoints}|${this.settings.showEnrouteFixes}|${this.settings.showApproachFixes}|${this.settings.secondaryAirportsMode}|${this.settings.radarRangeKm}|${lodHidden ? 1 : 0}`;
      if (wpKey !== this.lastWpFilterKey) {
        this.lastWpFilterKey = wpKey;
        const visibleIds = new Set<string>();
        const dimmedIds = new Set<string>();
        for (const wp of this.airspaceDataset.waypoints) {
          const vis = shouldShowWaypoint(wp, {
            showWaypoints: this.settings.showWaypoints,
            showEnrouteFixes: this.settings.showEnrouteFixes,
            showApproachFixes: this.settings.showApproachFixes,
            secondaryAirportsMode: this.settings.secondaryAirportsMode,
            waypointOverrides: this.settings.waypointOverrides,
            targetAirportCode: this.airspaceDataset.airportCode,
            airportCenter: this.airspaceDataset.center,
            cameraDistanceKm,
            radarRangeKm: this.settings.radarRangeKm,
          });
          if (vis.visible) {
            visibleIds.add(wp.id);
            if (vis.dimmed) dimmedIds.add(wp.id);
          }
        }
        this.airspaceHandles.updateWaypointMarkers(visibleIds, dimmedIds);
      }
    }

    this.labelManager.syncToCamera(
      this.camera,
      width,
      height,
      this.latestStates,
      this.aircraftColors,
      this.settings,
      this.selectedCallsign,
      overrideShowLabels,
      this.airspaceDataset.airportCode,
      this.airspaceDataset.center,
      cameraDistanceKm,
    );

    const palette = SCENE_THEMES[this.settings.theme];
    if (!this.isSoftwareGl && this.composer && palette.useBloom && this.settings.bloomStrength > 0.01) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private afterDraw(cb: () => void): void {
    if (this.disposed) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      let polls = 0;
      const poll = () => {
        if (this.disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        polls++;
        const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        if (state === gl.UNSIGNALED && polls < 40) {
          this.frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameId = window.setTimeout(cb, 80);
        }
      };
      this.frameId = window.setTimeout(poll, 5);
    } else {
      this.frameId = window.setTimeout(cb, 80);
    }
  }

  private cancelPendingFrames(): void {
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.renderBusy = false;
  }

  public requestRender(): void {
    if (this.disposed || this.isPlaying || this.isExporting) return;
    if (this.renderBusy) {
      this.renderDirty = true;
      return;
    }
    this.renderBusy = true;
    this.frameId = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.renderDirty = false;
      if (this.transitionGoal) {
        this.updateSimulationAt(this.simTimeSec, 0.016, false);
      }
      this.renderCurrentFrame();

      const done = () => {
        this.renderBusy = false;
        if (this.renderDirty || this.transitionGoal) {
          this.requestRender();
        }
      };
      if (this.isSoftwareGl) this.afterDraw(done);
      else done();
    });
  }

  private scheduleNextPlayFrame(): void {
    if (this.disposed || !this.isPlaying || this.isExporting) return;
    if (this.isSoftwareGl) {
      this.afterDraw(this.playTick);
    } else {
      this.frameId = requestAnimationFrame(this.playTick);
    }
  }

  private playTick = (): void => {
    if (this.disposed || !this.isPlaying || this.isExporting) return;
    const now = performance.now();
    const wallDt = Math.min(0.12, Math.max(0.001, (now - this.lastWallMs) / 1000));
    this.lastWallMs = now;

    this.simTimeSec += wallDt * this.speedMultiplier;
    if (this.simTimeSec > this.radarDataset.endTime) {
      this.simTimeSec = this.radarDataset.startTime;
    }

    this.updateSimulationAt(this.simTimeSec, wallDt, false);
    this.renderCurrentFrame(undefined, undefined, undefined, wallDt, false);

    if (now - this.lastTimeEmitMs >= 100) {
      this.lastTimeEmitMs = now;
      this.callbacks.onTimeAdvance(this.simTimeSec);
    }

    this.scheduleNextPlayFrame();
  };

  /**
   * Deterministic offline frame rendering for 60 FPS video export (decoupled from requestAnimationFrame).
   */
  public beginDeterministicExport(width: number, height: number): () => void {
    this.isExporting = true;
    this.syncCameraPathPreviewVisibility();
    this.cancelPendingFrames();
    this.labelManager.resetLayoutSmoothing();

    const prevWidth = Math.max(1, this.container.clientWidth);
    const prevHeight = Math.max(1, this.container.clientHeight);
    const prevPixelRatio = this.renderer.getPixelRatio();
    const prevCamPos = this.camera.position.clone();
    const prevTarget = this.controls.target.clone();
    const prevFov = this.camera.fov;
    const prevUseKeyframes = this.useKeyframes;

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setSize(width, height);
    }
    if (this.bloomPass) {
      this.bloomPass.resolution.set(width, height);
    }

    return () => {
      this.isExporting = false;
      this.useKeyframes = prevUseKeyframes;
      this.syncCameraPathPreviewVisibility();
      this.renderer.setPixelRatio(prevPixelRatio);
      this.renderer.setSize(prevWidth, prevHeight, true);
      this.camera.aspect = prevWidth / prevHeight;
      this.camera.fov = prevFov;
      this.camera.updateProjectionMatrix();
      if (this.composer) {
        this.composer.setSize(prevWidth, prevHeight);
      }
      if (this.bloomPass) {
        this.bloomPass.resolution.set(prevWidth, prevHeight);
      }
      this.camera.position.copy(prevCamPos);
      this.controls.target.copy(prevTarget);
      this.controls.update();
      this.labelManager.resetLayoutSmoothing();
      this.updateSimulationAt(this.simTimeSec, 0.016, true);
      if (this.isPlaying) {
        this.lastWallMs = performance.now();
        this.scheduleNextPlayFrame();
      } else {
        this.requestRender();
      }
    };
  }

  public renderDeterministicFrame(
    simTimeSec: number,
    width: number,
    height: number,
    useKeyframes: boolean,
    includeLabels: boolean,
  ): { activeCount: number; airportStats: AirportTrafficCounters } {
    this.useKeyframes = useKeyframes;
    this.updateSimulationAt(simTimeSec, 1 / 60, false);
    this.renderCurrentFrame(width, height, includeLabels, 1 / 60);
    return {
      activeCount: this.latestStates.size,
      airportStats: computeAirportTrafficCounters(this.airportEventIndex, simTimeSec),
    };
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelPendingFrames();
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);

    if (this.airspaceHandles) {
      this.airspaceHandles.dispose();
    }
    this.cameraPathLine.geometry.dispose();
    (this.cameraPathLine.material as THREE.Material).dispose();
    this.cameraPathNodes.geometry.dispose();
    (this.cameraPathNodes.material as THREE.Material).dispose();
    this.labelManager.dispose();
    for (const actor of this.actors.values()) {
      disposeAircraftActor(actor);
    }
    for (const rig of this.trailRigs.values()) {
      rig.dispose();
    }
    this.controls.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
