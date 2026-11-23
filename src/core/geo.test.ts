import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalENUProjector, formatFlightLevel, formatUtcTime } from './geo';

test('LocalENUProjector maps origin to (0, 0, 0)', () => {
  const proj = new LocalENUProjector({ lat: 56.23, lon: 43.78417 });
  const origin = proj.toENU(56.23, 43.78417, 0);
  assert.equal(origin.x, 0);
  assert.equal(origin.y, 0);
  assert.equal(origin.z, 0);
});

test('LocalENUProjector converts North (+lat -> -Z), East (+lon -> +X), Up (+alt -> +Y)', () => {
  const proj = new LocalENUProjector({ lat: 56.23, lon: 43.78417 });
  // +1 deg latitude is ~111.195 km North (-Z)
  const northPt = proj.toENU(57.23, 43.78417, 10000);
  assert.ok(Math.abs(northPt.z - -111.195) < 0.2, `Expected ~-111.2 km, got ${northPt.z}`);
  assert.ok(Math.abs(northPt.y - 3.048) < 0.001, `Expected 3.048 km, got ${northPt.y}`);

  // +1 deg longitude at 56.23N is ~61.8 km East (+X)
  const eastPt = proj.toENU(56.23, 44.78417, 0);
  assert.ok(Math.abs(eastPt.x - 61.8) < 0.5, `Expected ~61.8 km, got ${eastPt.x}`);

  // Round-trip inverse projection
  const geo = proj.toGeo(eastPt.x, northPt.z);
  assert.ok(Math.abs(geo.lat - 57.23) < 1e-4);
  assert.ok(Math.abs(geo.lon - 44.78417) < 1e-4);
});

test('headingFromDeltaXZ computes cardinal bearings accurately', () => {
  assert.ok(Math.abs(LocalENUProjector.headingFromDeltaXZ(0, -1) - 0) < 1e-6); // North
  assert.ok(Math.abs(LocalENUProjector.headingFromDeltaXZ(1, 0) - 90) < 1e-6); // East
  assert.ok(Math.abs(LocalENUProjector.headingFromDeltaXZ(0, 1) - 180) < 1e-6); // South
  assert.ok(Math.abs(LocalENUProjector.headingFromDeltaXZ(-1, 0) - 270) < 1e-6); // West
});

test('formatUtcTime and formatFlightLevel format aviation strings cleanly', () => {
  assert.equal(formatUtcTime(16 * 3600 + 40), '16:00:40');
  assert.equal(formatUtcTime(86400 + 65), '00:01:05');
  assert.equal(formatFlightLevel(6600), 'F066');
  assert.equal(formatFlightLevel(36000), 'F360');
  assert.equal(formatFlightLevel(2400), 'A024');
});
