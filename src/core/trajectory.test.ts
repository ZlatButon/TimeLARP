import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAircraftAtTime,
  evaluateCameraKeyframes,
  lerpAngleDeg,
  shortestAngleDeltaDeg,
} from './trajectory';
import { LocalENUProjector } from './geo';
import type { AircraftTrack, CameraKeyframe } from '../types/radar';

test('shortestAngleDeltaDeg and lerpAngleDeg wrap cleanly across 360/0 degrees', () => {
  assert.equal(shortestAngleDeltaDeg(355, 5), 10);
  assert.equal(shortestAngleDeltaDeg(5, 355), -10);
  assert.equal(lerpAngleDeg(350, 10, 0.5), 0);
  assert.equal(lerpAngleDeg(10, 350, 0.5), 0);
});

test('evaluateAircraftAtTime smoothly interpolates position, 3D tangent pitch with Vertical Exaggeration, and respects gap dropouts', () => {
  const projector = new LocalENUProjector({ lat: 56.23, lon: 43.78417 });
  const track: AircraftTrack = {
    callsign: 'AUL510',
    squawk: '4215',
    samples: [],
    segments: [
      {
        startTime: 100,
        endTime: 108,
        samples: [
          { timeSec: 100, lat: 56.20, lon: 43.78, altFt: 4000, gsKt: 250, headingDeg: 0 },
          { timeSec: 104, lat: 56.22, lon: 43.78, altFt: 4800, gsKt: 255, headingDeg: 0 },
          { timeSec: 108, lat: 56.24, lon: 43.78, altFt: 5600, gsKt: 260, headingDeg: 0 },
        ],
      },
      {
        startTime: 200,
        endTime: 204,
        samples: [
          { timeSec: 200, lat: 56.30, lon: 43.78, altFt: 9000, gsKt: 300, headingDeg: 0 },
          { timeSec: 204, lat: 56.32, lon: 43.78, altFt: 9000, gsKt: 300, headingDeg: 0 },
        ],
      },
    ],
    firstSeen: 100,
    lastSeen: 204,
  };

  assert.equal(evaluateAircraftAtTime(track, 99, projector, 5), null);
  assert.equal(evaluateAircraftAtTime(track, 150, projector, 5), null); // Inside gap

  const mid1x = evaluateAircraftAtTime(track, 104, projector, 1);
  const mid6x = evaluateAircraftAtTime(track, 104, projector, 6);
  assert.ok(mid1x !== null && mid6x !== null);
  assert.ok(mid1x.visualPitchRad > 0);
  assert.ok(mid6x.visualPitchRad > mid1x.visualPitchRad * 2.5, 'Vertical exaggeration must steepen 3D visual pitch');
  assert.ok(mid6x.tangent3D[1] > mid1x.tangent3D[1], '3D tangent Y must reflect vertical exaggeration');

  // Level flight at t=202 has ~0 visual pitch
  const level = evaluateAircraftAtTime(track, 202, projector, 6);
  assert.ok(level !== null);
  assert.ok(Math.abs(level.visualPitchRad) < 1e-3);
});

test('evaluateCameraKeyframes smoothly interpolates camera position and lookAt target', () => {
  const kfs: CameraKeyframe[] = [
    { id: 'k1', timeSec: 0, position: [0, 100, 100], target: [0, 0, 0], label: 'Start' },
    { id: 'k2', timeSec: 100, position: [100, 50, 0], target: [20, 5, -10], label: 'End' },
  ];

  const start = evaluateCameraKeyframes(kfs, 0);
  assert.deepEqual(start?.position, [0, 100, 100]);

  const mid = evaluateCameraKeyframes(kfs, 50);
  assert.ok(mid !== null);
  assert.ok(Math.abs(mid.position[0] - 50) < 1e-4);
  assert.ok(Math.abs(mid.position[1] - 75) < 1e-4);
  assert.ok(Math.abs(mid.target[0] - 10) < 1e-4);
});
