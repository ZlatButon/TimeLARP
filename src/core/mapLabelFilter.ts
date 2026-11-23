import type { CityLabelsMode, GeoMapLabel } from '../types/radar';

/**
 * Determine whether a geographic base-map label (city/town/water/region) should be rendered
 * according to the active city label filter mode (`all` | `major` | `off`) and any manual
 * per-city checkbox overrides.
 */
export function shouldShowGroundLabel(
  label: GeoMapLabel,
  mode: CityLabelsMode,
  overrides: Record<string, boolean>,
): boolean {
  // Explicit per-label user checkbox override always takes precedence
  if (overrides[label.id] !== undefined) {
    return overrides[label.id];
  }
  const byName = overrides[label.text.toUpperCase()];
  if (byName !== undefined) {
    return byName;
  }

  // Water & region typography follows non-off modes cleanly
  if (label.kind !== 'CITY') {
    return mode !== 'off';
  }

  if (mode === 'off') return false;
  if (mode === 'all') return true;

  // `major`: keep capitals & major cities, hide smaller towns (`placeTier === 'minor'`)
  return label.placeTier !== 'minor';
}
