import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEuroScopeAirspace, parseEuroScopeCoord } from './sectorParser';

test('parseEuroScopeCoord decodes DMS coordinates in all hemispheres', () => {
  const lat = parseEuroScopeCoord('N056.13.48.000');
  const lon = parseEuroScopeCoord('E043.47.03.000');
  assert.ok(lat !== null && Math.abs(lat - 56.23) < 1e-4, `Got ${lat}`);
  assert.ok(lon !== null && Math.abs(lon - 43.784167) < 1e-4, `Got ${lon}`);

  const south = parseEuroScopeCoord('S033.30.00.000');
  const west = parseEuroScopeCoord('W070.15.00.000');
  assert.equal(south, -33.5);
  assert.equal(west, -70.25);
});

test('parseEuroScopeAirspace parses .sct fixes, airways, regions and .ese sectors', () => {
  const sampleSct = `
[INFO]
UWGG Moscow FIR
UWGG
N056.13.48.000 E043.47.03.000

[FIXES]
USTOK N056.08.00.000 E043.10.00.000
LARNO N055.44.00.000 E043.05.00.000
GILAM N056.47.00.000 E045.00.00.000

[LOW AIRWAY]
A100 USTOK LARNO
B200 LARNO GILAM

[REGIONS]
URR101 N056.30.00.000 E044.30.00.000
N056.40.00.000 E044.45.00.000
N056.35.00.000 E044.55.00.000
`;

  const sampleEse = `
[AIRSPACE]
SECTOR:UWGG_CTR:0:5000
COORD:N056.10.00.000:E043.35.00.000
COORD:N056.25.00.000:E043.35.00.000
COORD:N056.25.00.000:E044.05.00.000
COORD:N056.10.00.000:E044.05.00.000
`;

  const airspace = parseEuroScopeAirspace(sampleSct, sampleEse);
  assert.equal(airspace.airportCode, 'UWGG');
  assert.equal(airspace.waypoints.length, 3);
  assert.equal(airspace.airways.length, 2);
  assert.equal(airspace.restrictedZones.length, 1);
  assert.equal(airspace.volumes.length, 1);
  assert.equal(airspace.volumes[0].ceilingFt, 5000);
});
