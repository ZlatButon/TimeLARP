import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAircraftSector,
  getSectorControlColorHex,
  parseGeoJsonBaseMap,
  pointInPolygon,
} from './airspaceZones';
import type { AirspaceVolume } from '../types/radar';

const squareCtr: AirspaceVolume = {
  id: 'ctr',
  name: 'UWGG CTR',
  shortCode: 'TWR',
  frequency: '118.300',
  kind: 'CTR',
  floorFt: 0,
  ceilingFt: 5000,
  polygon: [
    { lat: 56.1, lon: 43.6 },
    { lat: 56.1, lon: 44.0 },
    { lat: 56.4, lon: 44.0 },
    { lat: 56.4, lon: 43.6 },
  ],
};

const widerTma: AirspaceVolume = {
  id: 'tma',
  name: 'UWGG TMA',
  shortCode: 'APP',
  frequency: '119.300',
  kind: 'TMA',
  floorFt: 1500,
  ceilingFt: 11000,
  polygon: [
    { lat: 55.8, lon: 43.2 },
    { lat: 55.8, lon: 44.4 },
    { lat: 56.7, lon: 44.4 },
    { lat: 56.7, lon: 43.2 },
  ],
};

test('pointInPolygon detects interior and exterior geo points accurately', () => {
  assert.equal(pointInPolygon({ lat: 56.23, lon: 43.78 }, squareCtr.polygon), true);
  assert.equal(pointInPolygon({ lat: 56.9, lon: 43.78 }, squareCtr.polygon), false);
});

test('classifyAircraftSector prioritizes innermost 3D zone matching floor/ceiling', () => {
  const volumes = [widerTma, squareCtr];

  // Low inside CTR -> TWR (higher priority than TMA)
  const inCtr = classifyAircraftSector(56.23, 43.78, 3000, volumes);
  assert.equal(inCtr.sectorCode, 'TWR');
  assert.equal(inCtr.kind, 'CTR');

  // Above CTR ceiling (8000 ft) at same lat/lon -> falls into TMA (APP)
  const inTma = classifyAircraftSector(56.23, 43.78, 8000, volumes);
  assert.equal(inTma.sectorCode, 'APP');
  assert.equal(inTma.kind, 'TMA');

  // High overflight (35000 ft) above all terminal volumes -> ENROUTE (CTR)
  const enroute = classifyAircraftSector(56.23, 43.78, 35000, volumes);
  assert.equal(enroute.sectorCode, 'CTR');
  assert.equal(enroute.kind, 'ENROUTE');

  assert.notEqual(
    getSectorControlColorHex('TMA', true),
    getSectorControlColorHex('ENROUTE', true),
  );
});

test('parseGeoJsonBaseMap extracts land polygons and coastlines from GeoJSON', () => {
  const sample = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { natural: 'land' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [43.5, 56.0],
              [44.2, 56.0],
              [44.2, 56.5],
              [43.5, 56.5],
              [43.5, 56.0],
            ],
          ],
        },
      },
    ],
  });

  const map = parseGeoJsonBaseMap(sample, 'Test Map', { lat: 56.23, lon: 43.78417 });
  assert.equal(map.waterBase, true);
  assert.equal(map.polygons.length, 1);
  assert.equal(map.polylines.length, 1);
});
