import type { ProjectedLabel } from '../types/radar';

function hashCallsign(cs: string): number {
  let h = 2166136261;
  for (let i = 0; i < cs.length; i++) {
    h ^= cs.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Iterative screen-space collision avoidance for ATC aircraft datablocks.
 * - Uses a deterministic per-callsign initial offset (never array index) so aircraft
 *   spawning on takeoff or landing never cause unrelated labels to jump.
 * - NEVER clamps boxes to viewport borders and NEVER diverts labels around the HUD zone,
 *   so aircraft datablocks move completely freely and naturally across the entire frame.
 */
export function resolveLabelOverlaps(
  labels: ProjectedLabel[],
  _viewportWidth: number,
  _viewportHeight: number,
  iterations = 6,
): ProjectedLabel[] {
  const padding = 6;
  const result = labels
    .map((l) => {
      // Stable EuroScope-style upper-right / right offset keyed strictly by callsign
      const slot = hashCallsign(l.callsign) % 4;
      const angle = slot * 0.42 - 0.35;
      const offsetX = 22 * Math.cos(angle);
      const offsetY = -26 + 16 * Math.sin(angle);
      return {
        ...l,
        boxX: l.anchorX + offsetX,
        boxY: l.anchorY + offsetY,
      };
    })
    .sort((a, b) => a.callsign.localeCompare(b.callsign));

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < result.length; i++) {
      const a = result[i];
      for (let j = i + 1; j < result.length; j++) {
        const b = result[j];
        const overlapX =
          Math.min(a.boxX + a.width + padding, b.boxX + b.width + padding) -
          Math.max(a.boxX, b.boxX);
        const overlapY =
          Math.min(a.boxY + a.height + padding, b.boxY + b.height + padding) -
          Math.max(a.boxY, b.boxY);

        if (overlapX > 0 && overlapY > 0) {
          if (overlapY <= overlapX) {
            const push = overlapY * 0.55;
            if (a.boxY <= b.boxY) {
              a.boxY -= push;
              b.boxY += push;
            } else {
              a.boxY += push;
              b.boxY -= push;
            }
          } else {
            const push = overlapX * 0.55;
            if (a.boxX <= b.boxX) {
              a.boxX -= push;
              b.boxX += push;
            } else {
              a.boxX += push;
              b.boxX -= push;
            }
          }
        }
      }

      // Gently pull back toward natural anchor offset without clamping or HUD deflection
      const idealX = a.anchorX + 22;
      const idealY = a.anchorY - 24;
      a.boxX += (idealX - a.boxX) * 0.08;
      a.boxY += (idealY - a.boxY) * 0.08;
    }
  }

  return result;
}
