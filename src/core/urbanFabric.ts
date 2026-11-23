/**
 * Pure, DOM-free math for transforming raw built-up urban footprints (`landuse` residential,
 * commercial, industrial, retail blocks) into a soft nocturnal "city lights / urban fabric"
 * density visualization without harsh administrative borders or jagged vector islands.
 */

export const BUILT_UP_LANDUSE_CLASSES = new Set([
  'residential',
  'commercial',
  'industrial',
  'retail',
  'suburb',
  'neighbourhood',
  'quarter',
  'hospital',
  'university',
  'school',
  'stadium',
  'railway',
]);

export function isBuiltUpLanduseClass(cls: string): boolean {
  return BUILT_UP_LANDUSE_CLASSES.has(cls.trim().toLowerCase());
}

/**
 * Map a local ENU ground coordinate `(xKm, zKm)` into `[0..sizePx]` canvas pixel space
 * centered on the airport (`0, 0`).
 */
export function enuToCanvasPixel(
  xKm: number,
  zKm: number,
  extentKm: number,
  sizePx: number,
): [number, number] {
  const half = sizePx * 0.5;
  const scale = half / Math.max(1, extentKm);
  return [half + xKm * scale, half + zKm * scale];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Noise-suppressing smooth density transfer curve applied after multi-pass Gaussian fusion:
 * - Isolated tiny rural villages / single-block dachas (whose blurred mass stays < 0.10)
 *   smoothly dissolve to 0.0 instead of cluttering the dark radar scope.
 * - Cohesive built-up urban districts (0.10 .. 0.80) rise cleanly through an organic S-curve
 *   into soft metropolitan aura (low) -> residential quarters (mid) -> dense city core (high).
 */
export function evaluateUrbanDensityCurve(rawDensity: number): number {
  if (!Number.isFinite(rawDensity) || rawDensity <= 0.1) return 0;
  const base = smoothstep(0.1, 0.78, rawDensity);
  // Gentle gamma lift so medium residential sprawl reads clearly around the core
  return Math.pow(base, 0.88);
}

/**
 * Fast deterministic 2D pixel hash in [0..1] for subtle nocturnal street-block micro-grain.
 */
export function deterministicUrbanGrain(px: number, py: number): number {
  let n = Math.imul(px, 374761393) + Math.imul(py, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/**
 * Grade a curved urban density `d ∈ [0..1]` into an RGBA 8-bit tuple `[r, g, b, a]`.
 *
 * Dark theme ("Nocturnal Cockpit View"):
 * - Outer metropolitan aura: deep slate-indigo haze (#17253a)
 * - Residential built-up fabric: dusk steel-slate with a whisper of warm city ambience (#2d3c52)
 * - Dense city center / blocks: calm warm muted amber-slate glow (#66564a, strictly below
 *   UnrealBloomPass threshold 0.66 so aircraft & ribbons always stay the brightest heroes)
 *
 * Light theme ("Tactical Cartographic"):
 * - Clean matte warm-slate built-up footprint without glare.
 */
export function sampleUrbanFabricRgba(
  density: number,
  isDark: boolean,
  microGrain01 = 0.5,
): [number, number, number, number] {
  const d = Math.max(0, Math.min(1, density));
  if (d <= 0.002) return [0, 0, 0, 0];

  // Subtle architectural street-block shimmer inside built-up cores (never noisy on soft outer edges)
  const grainAmp = smoothstep(0.28, 0.78, d) * 0.16;
  const grainFactor = 1 + (microGrain01 - 0.5) * 2 * grainAmp;

  if (isDark) {
    // 3-stop nocturnal cartographic slate-steel gradient (Apple Maps Dark / Aviation Night style):
    // Deep slate aura -> residential steel-blue -> crisp luminous-matte urban core (zero muddy brown!)
    let r: number;
    let g: number;
    let b: number;
    if (d < 0.5) {
      const t = d / 0.5;
      r = 18 + (30 - 18) * t;
      g = 30 + (48 - 30) * t;
      b = 48 + (74 - 48) * t;
    } else {
      const t = (d - 0.5) / 0.5;
      r = 30 + (52 - 30) * t;
      g = 48 + (74 - 48) * t;
      b = 74 + (104 - 74) * t;
    }

    const alpha = Math.min(0.68, 0.08 + Math.pow(d, 0.92) * 0.6);
    return [
      Math.max(0, Math.min(82, Math.round(r * grainFactor))),
      Math.max(0, Math.min(104, Math.round(g * grainFactor))),
      Math.max(0, Math.min(136, Math.round(b * grainFactor))),
      Math.round(alpha * 255),
    ];
  }

  // Tactical Light theme: calm matte cartographic built-up shading
  const r = 148 + (168 - 148) * d;
  const g = 155 + (173 - 155) * d;
  const b = 165 + (180 - 165) * d;
  const alpha = Math.min(0.62, 0.12 + d * 0.48);
  return [
    Math.max(0, Math.min(220, Math.round(r * (1 + (microGrain01 - 0.5) * 0.06)))),
    Math.max(0, Math.min(220, Math.round(g * (1 + (microGrain01 - 0.5) * 0.06)))),
    Math.max(0, Math.min(225, Math.round(b * (1 + (microGrain01 - 0.5) * 0.06)))),
    Math.round(alpha * 255),
  ];
}
