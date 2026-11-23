/**
 * Perceptual ITU-R BT.709 relative luminance for linear/sRGB [0..1] RGB components.
 */
export function computeRelativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Normalize an RGB color triplet `[0..1]` to a strictly constant perceptual luminance
 * so aircraft icons & halos maintain uniform brightness across every ATC sector color
 * (TWR / RADAR / APP / CTR) and every intermediate Color.lerp handoff frame.
 */
export function normalizeRgbToConstantLuminance(
  r: number,
  g: number,
  b: number,
  targetLuminance: number,
): [number, number, number] {
  const safeR = Math.max(0, r);
  const safeG = Math.max(0, g);
  const safeB = Math.max(0, b);
  const target = Math.max(0.01, Math.min(0.95, targetLuminance));

  const currentLuma = computeRelativeLuminance(safeR, safeG, safeB);
  if (currentLuma <= 1e-5) {
    return [target, target, target];
  }

  let nr = safeR * (target / currentLuma);
  let ng = safeG * (target / currentLuma);
  let nb = safeB * (target / currentLuma);

  // If scaling pushed any channel > 1.0, gently blend toward neutral grey at `target`
  // so hue stays vivid while exact perceptual luminance remains strictly equal to `target`.
  const maxChan = Math.max(nr, ng, nb);
  if (maxChan > 1.0) {
    const excess = maxChan - 1.0;
    const denom = Math.max(1e-5, maxChan - target);
    const blend = Math.min(1, excess / denom);
    nr = nr + (target - nr) * blend;
    ng = ng + (target - ng) * blend;
    nb = nb + (target - nb) * blend;
  }

  return [
    Math.max(0, Math.min(1, nr)),
    Math.max(0, Math.min(1, ng)),
    Math.max(0, Math.min(1, nb)),
  ];
}
