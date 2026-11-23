import * as THREE from 'three';
import { normalizeRgbToConstantLuminance } from '../core/colorLuminance';
import type { SceneThemePalette } from './themes';

export interface AircraftActor {
  callsign: string;
  root: THREE.Group;
  modelGroup: THREE.Group;
  hitProxy: THREE.Mesh;
  coreDot: THREE.Mesh;
  /** Soft radial glow sprite smoothly tinted by live sector color */
  glowSprite: THREE.Sprite;
  /** 3D velocity vector line oriented directly along the 3D spline tangent (with Vertical Exaggeration) */
  velocityLine: THREE.Line;
  dropStem: THREE.Line;
  bodyMat: THREE.MeshStandardMaterial;
  wingMat: THREE.MeshStandardMaterial;
  coreDotMat: THREE.MeshBasicMaterial;
  glowMat: THREE.SpriteMaterial;
  velocityMat: THREE.ShaderMaterial;
  dropStemMat: THREE.LineBasicMaterial;
  /** Live smoothly-lerped RGB color tracking active controlling ATC sector */
  currentColor: THREE.Color;
  colorInitialized: boolean;
  /** Smoothly slerped 3D attitude quaternion (eliminates twitchy manual-flight orientation) */
  attitudeQuat: THREE.Quaternion;
  attitudeInitialized: boolean;
}

interface SharedAircraftGeometries {
  fuselage: THREE.CylinderGeometry;
  nose: THREE.ConeGeometry;
  wing: THREE.ExtrudeGeometry;
  hStab: THREE.ExtrudeGeometry;
  vFin: THREE.ExtrudeGeometry;
  coreDot: THREE.SphereGeometry;
  hitSphere: THREE.SphereGeometry;
  glowTexture: THREE.CanvasTexture;
}

let sharedGeos: SharedAircraftGeometries | null = null;
const _white = new THREE.Color(0xffffff);
const _normColor = new THREE.Color();

function buildSoftGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size * 0.5;
  // Smooth circular Gaussian halo (no sharp center spike -> prevents cross/star Bloom flares)
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.72)');
  grad.addColorStop(0.22, 'rgba(255, 255, 255, 0.44)');
  grad.addColorStop(0.48, 'rgba(255, 255, 255, 0.16)');
  grad.addColorStop(0.76, 'rgba(255, 255, 255, 0.035)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function getSharedAircraftGeometries(): SharedAircraftGeometries {
  if (sharedGeos) return sharedGeos;

  const fuselage = new THREE.CylinderGeometry(0.14, 0.11, 1.55, 8);
  fuselage.rotateX(Math.PI / 2);

  const nose = new THREE.ConeGeometry(0.14, 0.38, 8);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 0, -0.96);

  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, -0.28);
  wingShape.lineTo(1.24, 0.3);
  wingShape.lineTo(1.24, 0.46);
  wingShape.lineTo(0, 0.16);
  wingShape.lineTo(-1.24, 0.46);
  wingShape.lineTo(-1.24, 0.3);
  wingShape.closePath();

  const wing = new THREE.ExtrudeGeometry(wingShape, {
    depth: 0.055,
    bevelEnabled: false,
  });
  wing.rotateX(Math.PI / 2);
  wing.translate(0, 0.025, 0.02);

  const stabShape = new THREE.Shape();
  stabShape.moveTo(0, -0.08);
  stabShape.lineTo(0.46, 0.18);
  stabShape.lineTo(0.46, 0.28);
  stabShape.lineTo(0, 0.11);
  stabShape.lineTo(-0.46, 0.28);
  stabShape.lineTo(-0.46, 0.18);
  stabShape.closePath();

  const hStab = new THREE.ExtrudeGeometry(stabShape, {
    depth: 0.04,
    bevelEnabled: false,
  });
  hStab.rotateX(Math.PI / 2);
  hStab.translate(0, 0.04, 0.62);

  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(0.28, 0);
  finShape.lineTo(0.38, 0.44);
  finShape.lineTo(0.2, 0.44);
  finShape.closePath();

  const vFin = new THREE.ExtrudeGeometry(finShape, {
    depth: 0.04,
    bevelEnabled: false,
  });
  vFin.rotateY(-Math.PI / 2);
  vFin.translate(0.02, 0.05, 0.54);

  const coreDot = new THREE.SphereGeometry(0.44, 10, 8);
  const hitSphere = new THREE.SphereGeometry(2.8, 10, 8);
  const glowTexture = buildSoftGlowTexture();

  sharedGeos = {
    fuselage,
    nose,
    wing,
    hStab,
    vFin,
    coreDot,
    hitSphere,
    glowTexture,
  };
  return sharedGeos;
}

/**
 * Create a compact, crisp 3D aircraft actor with soft sector-colored glow sprite,
 * 3D tangent velocity vector, and optional altitude drop stem (OFF by default).
 */
export function createAircraftActor(
  callsign: string,
  palette: SceneThemePalette,
): AircraftActor {
  const geos = getSharedAircraftGeometries();
  const root = new THREE.Group();
  root.name = `aircraft-${callsign}`;
  root.frustumCulled = false;

  const modelGroup = new THREE.Group();
  modelGroup.scale.setScalar(1.32);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: palette.aircraftWingHex,
    roughness: 0.34,
    metalness: 0.18,
    transparent: true,
    opacity: 1,
    emissive: new THREE.Color(palette.aircraftWingHex),
    emissiveIntensity: palette.isDark ? 0.56 : 0.12,
  });

  const wingMat = new THREE.MeshStandardMaterial({
    color: palette.aircraftWingHex,
    roughness: 0.4,
    metalness: 0.18,
    transparent: true,
    opacity: 1,
    emissive: new THREE.Color(palette.aircraftWingHex),
    emissiveIntensity: palette.isDark ? 0.46 : 0.08,
  });

  const fuselageMesh = new THREE.Mesh(geos.fuselage, bodyMat);
  const noseMesh = new THREE.Mesh(geos.nose, bodyMat);
  const wingMesh = new THREE.Mesh(geos.wing, wingMat);
  const stabMesh = new THREE.Mesh(geos.hStab, wingMat);
  const finMesh = new THREE.Mesh(geos.vFin, wingMat);

  // Explicit renderOrder strictly above base map (<=3), airspace sectors (4..7), and trails (15)
  // so transparent aircraft meshes never depth-flip with sector boundary lines.
  fuselageMesh.renderOrder = 22;
  noseMesh.renderOrder = 22;
  wingMesh.renderOrder = 22;
  stabMesh.renderOrder = 22;
  finMesh.renderOrder = 22;

  modelGroup.add(fuselageMesh, noseMesh, wingMesh, stabMesh, finMesh);
  root.add(modelGroup);

  // Subtle pinpoint core dot tinted by constant-luminance live lerped sector color
  const coreDotMat = new THREE.MeshBasicMaterial({
    color: palette.aircraftWingHex,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending,
  });
  const coreDot = new THREE.Mesh(geos.coreDot, coreDotMat);
  coreDot.scale.setScalar(0.46);
  coreDot.frustumCulled = false;
  coreDot.renderOrder = 23;
  root.add(coreDot);

  // Calm circular radial halo using strictly NormalBlending (never AdditiveBlending!)
  // so flying over sector boundary lines or airways NEVER adds background RGB into Bloom flashes.
  const glowMat = new THREE.SpriteMaterial({
    map: geos.glowTexture,
    color: palette.aircraftWingHex,
    transparent: true,
    opacity: palette.isDark ? 0.24 : 0.08,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  const glowSprite = new THREE.Sprite(glowMat);
  glowSprite.scale.set(3.1, 3.1, 1);
  glowSprite.frustumCulled = false;
  glowSprite.renderOrder = 20;
  root.add(glowSprite);

  // Compact 3D Velocity Vector Line fading smoothly to transparent at the tip
  const velPositions = new Float32Array([0, 0, 0, 0, 0, -3]);
  const velFade = new Float32Array([1.0, 0.0]);
  const velGeo = new THREE.BufferGeometry();
  velGeo.setAttribute('position', new THREE.BufferAttribute(velPositions, 3));
  velGeo.setAttribute('aFade', new THREE.BufferAttribute(velFade, 1));
  const velocityMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(palette.leaderVectorHex) },
      uOpacity: { value: palette.isDark ? 0.72 : 0.7 },
    },
    vertexShader: /* glsl */ `
      attribute float aFade;
      varying float vFade;
      void main() {
        vFade = aFade;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        float alpha = pow(clamp(vFade, 0.0, 1.0), 1.35) * uOpacity;
        if (alpha < 0.005) discard;
        gl_FragColor = vec4(uColor, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
  const velocityLine = new THREE.Line(velGeo, velocityMat);
  velocityLine.frustumCulled = false;
  velocityLine.renderOrder = 21;
  root.add(velocityLine);

  // Optional vertical altitude stem (hidden by default via settings.showDropStems = false)
  const stemPositions = new Float32Array([0, 0, 0, 0, -1, 0]);
  const stemGeo = new THREE.BufferGeometry();
  stemGeo.setAttribute('position', new THREE.BufferAttribute(stemPositions, 3));
  const dropStemMat = new THREE.LineBasicMaterial({
    color: palette.dropStemHex,
    transparent: true,
    opacity: palette.dropStemOpacity,
  });
  const dropStem = new THREE.Line(stemGeo, dropStemMat);
  dropStem.frustumCulled = false;
  dropStem.visible = false;
  root.add(dropStem);

  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitProxy = new THREE.Mesh(geos.hitSphere, hitMat);
  hitProxy.userData = { callsign };
  root.add(hitProxy);

  return {
    callsign,
    root,
    modelGroup,
    hitProxy,
    coreDot,
    glowSprite,
    velocityLine,
    dropStem,
    bodyMat,
    wingMat,
    coreDotMat,
    glowMat,
    velocityMat,
    dropStemMat,
    currentColor: new THREE.Color(palette.aircraftWingHex),
    colorInitialized: false,
    attitudeQuat: new THREE.Quaternion(),
    attitudeInitialized: false,
  };
}

/**
 * Apply smoothly-lerped sector ownership color consistently to the 3D aircraft mesh,
 * radial glow sprite, core dot, 3D velocity vector, and optional drop stem (zero harsh snapping!).
 */
export function applyDynamicColorToAircraftActor(
  actor: AircraftActor,
  color: THREE.Color,
  palette: SceneThemePalette,
  selected: boolean,
  visibilityAlpha = 1,
  showDropStems = false,
): void {
  actor.bodyMat.opacity = visibilityAlpha;
  actor.wingMat.opacity = visibilityAlpha;
  actor.coreDotMat.opacity = visibilityAlpha;
  actor.dropStem.visible = showDropStems && visibilityAlpha > 0.02;

  // Normalize live lerped RGB to strictly constant perceptual luminance so brightness NEVER spikes
  // across sector colors (TWR/RADAR/APP/CTR) or mid-handoff Color.lerp frames.
  const targetLuma = palette.isDark ? (selected ? 0.5 : 0.42) : selected ? 0.4 : 0.34;
  const [nr, ng, nb] = normalizeRgbToConstantLuminance(color.r, color.g, color.b, targetLuma);
  _normColor.setRGB(nr, ng, nb);

  const whiteMixBody = selected ? (palette.isDark ? 0.16 : 0.12) : palette.isDark ? 0.1 : 0.14;
  actor.bodyMat.color.copy(_normColor).lerp(_white, whiteMixBody);
  actor.bodyMat.emissive.copy(_normColor);
  actor.bodyMat.emissiveIntensity = palette.isDark ? (selected ? 0.56 : 0.4) : selected ? 0.24 : 0.1;

  actor.wingMat.color.copy(_normColor);
  actor.wingMat.emissive.copy(_normColor);
  actor.wingMat.emissiveIntensity = palette.isDark ? (selected ? 0.48 : 0.34) : selected ? 0.18 : 0.08;

  actor.coreDotMat.color.copy(_normColor).lerp(_white, palette.isDark ? 0.16 : 0.12);
  actor.coreDot.scale.setScalar(selected ? 0.56 : 0.46);

  // Strictly NormalBlending + constant scale halo: zero additive brightening over sector lines!
  actor.glowMat.color.copy(_normColor);
  actor.glowMat.blending = THREE.NormalBlending;
  actor.glowMat.opacity =
    (palette.isDark ? (selected ? 0.36 : 0.24) : selected ? 0.16 : 0.07) * visibilityAlpha;
  actor.glowSprite.scale.setScalar(selected ? 3.8 : 3.1);

  (actor.velocityMat.uniforms.uColor.value as THREE.Color)
    .copy(_normColor)
    .lerp(_white, palette.isDark ? 0.14 : 0.0);
  actor.velocityMat.uniforms.uOpacity.value =
    (palette.isDark ? (selected ? 0.8 : 0.62) : 0.65) * visibilityAlpha;

  if (actor.dropStem.visible) {
    actor.dropStemMat.color.copy(_normColor);
    actor.dropStemMat.opacity = (selected ? 0.38 : palette.dropStemOpacity) * visibilityAlpha;
  }
}

export function disposeAircraftActor(actor: AircraftActor): void {
  actor.velocityLine.geometry.dispose();
  actor.dropStem.geometry.dispose();
  actor.bodyMat.dispose();
  actor.wingMat.dispose();
  actor.coreDotMat.dispose();
  actor.glowMat.dispose();
  actor.velocityMat.dispose();
  actor.dropStemMat.dispose();
  (actor.hitProxy.material as THREE.Material).dispose();
}
