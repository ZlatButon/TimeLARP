import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLabelOverlaps } from './labelLayout';
import type { ProjectedLabel } from '../types/radar';

test('resolveLabelOverlaps allows datablocks to glide freely over top-left HUD while staying non-overlapping', () => {
  const input: ProjectedLabel[] = [
    {
      callsign: 'SVR441',
      anchorX: 120,
      anchorY: 45,
      boxX: 140,
      boxY: 20,
      width: 110,
      height: 36,
      altFt: 37000,
      gsKt: 477,
      verticalRateFpm: 0,
      aircraftType: 'A20N/M',
      destination: 'UWWW',
      selected: false,
    },
    {
      callsign: 'AFL007',
      anchorX: 124,
      anchorY: 48,
      boxX: 144,
      boxY: 23,
      width: 110,
      height: 36,
      altFt: 35000,
      gsKt: 490,
      verticalRateFpm: 0,
      aircraftType: 'B77W/H',
      destination: 'UHWW',
      selected: false,
    },
  ];

  const resolved = resolveLabelOverlaps(input, 1440, 900, 8);
  const [a, b] = resolved;
  // First label remains naturally inside top-left HUD region (no artificial deflection wall)
  assert.ok(a.boxX < 260 && a.boxY < 100, `Expected natural top-left placement, got (${a.boxX}, ${a.boxY})`);

  // Inter-label overlap must still be resolved cleanly
  const separatedX = a.boxX + a.width <= b.boxX || b.boxX + b.width <= a.boxX;
  const separatedY = a.boxY + a.height <= b.boxY || b.boxY + b.height <= a.boxY;
  assert.ok(separatedX || separatedY, 'Overlapping aircraft datablocks must still be separated');
});
