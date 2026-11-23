import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import { computeAircraftVisibilityAlpha, isAircraftOnGround } from './groundFilter';
import {
  buildNominatimCityUrl,
  computeSlippyTileGrid,
  decodeOpenFreeMapTile,
  latLonToTile,
  parseNominatimCityGeoJson,
  parseOverpassResponse,
  tilePixelToLatLon,
} from './osmLandscape';
import {
  computeRelativeLuminance,
  normalizeRgbToConstantLuminance,
} from './colorLuminance';
import {
  enuToCanvasPixel,
  evaluateUrbanDensityCurve,
  isBuiltUpLanduseClass,
  sampleUrbanFabricRgba,
} from './urbanFabric';
import {
  buildUrbanHubs,
  computeUrbanCoreWeight,
  generateNightBridgeSegments,
  generateNightCityLightPoints,
  sampleNightLightColor,
} from './nightLights';
import { LocalENUProjector } from './geo';
import { cleanSectorTitle, inspectEuroScopeFiles, parseEuroScopeAirspace } from './sectorParser';
import { parseEuroScopeFsdLog } from './fsdParser';
import {
  getSectorControlColorHex,
  parseControllerCallsign,
  parseGeoJsonBaseMap,
  resolveAircraftController,
} from './airspaceZones';
import { resolveLabelOverlaps } from './labelLayout';
import { smoothSegment3D, smoothSegmentAltitudes } from './trajectory';
import {
  applyCameraEasing,
  evaluateCinematicCameraPath,
  focalLengthMmToFovDeg,
  generateAutoCameraPreset,
  sampleCameraPathPreview,
} from './cameraRig';
import { shouldShowGroundLabel } from './mapLabelFilter';
import {
  buildAirportFlightEventIndex,
  computeAirportTrafficCounters,
} from './airportTrafficStats';
import {
  computeExportPlan,
  computeSpeedForTargetDuration,
  formatDurationHms,
  PagedStreamBuffer,
} from './exportPlan';
import { formatUtcTimeHm } from './geo';
import { computeRadialFadeAlpha, shiftCityLabelAwayFromRunway } from './radialFog';
import {
  APPROACH_FIX_LOD_MAX_CAMERA_DIST_KM,
  classifyWaypoint,
  shouldShowWaypoint,
} from './waypointFilter';
import type {
  AircraftTrack,
  AirspaceVolume,
  CameraKeyframe,
  GeoMapLabel,
  ProjectedLabel,
  RadarDataset,
  RadarSample,
  Waypoint,
} from '../types/radar';

test('isAircraftOnGround and computeAircraftVisibilityAlpha hide parked/taxiing planes and fade smoothly', () => {
  assert.equal(isAircraftOnGround(280, 12, 256), true);
  assert.equal(isAircraftOnGround(3200, 180, 256), false);

  const track: AircraftTrack = {
    callsign: 'AFL1019',
    squawk: '3104',
    firstSeen: 0,
    lastSeen: 20,
    samples: [
      { timeSec: 0, lat: 56.23, lon: 43.78, altFt: 260, gsKt: 18, headingDeg: 180 },
      { timeSec: 5, lat: 56.23, lon: 43.78, altFt: 265, gsKt: 102, headingDeg: 180 },
      { timeSec: 10, lat: 56.22, lon: 43.78, altFt: 950, gsKt: 165, headingDeg: 180 },
      { timeSec: 15, lat: 56.21, lon: 43.78, altFt: 280, gsKt: 65, headingDeg: 180 },
      { timeSec: 20, lat: 56.21, lon: 43.78, altFt: 260, gsKt: 20, headingDeg: 180 },
    ],
    segments: [
      {
        startTime: 0,
        endTime: 20,
        samples: [
          { timeSec: 0, lat: 56.23, lon: 43.78, altFt: 260, gsKt: 18, headingDeg: 180 },
          { timeSec: 5, lat: 56.23, lon: 43.78, altFt: 265, gsKt: 102, headingDeg: 180 },
          { timeSec: 10, lat: 56.22, lon: 43.78, altFt: 950, gsKt: 165, headingDeg: 180 },
          { timeSec: 15, lat: 56.21, lon: 43.78, altFt: 280, gsKt: 65, headingDeg: 180 },
          { timeSec: 20, lat: 56.21, lon: 43.78, altFt: 260, gsKt: 20, headingDeg: 180 },
        ],
      },
    ],
  };

  // Taxiing at 18 kt -> hidden (0)
  assert.equal(computeAircraftVisibilityAlpha(track, 0, 260, 18, 256, true), 0);
  // Takeoff roll at 102 kt -> mid fade-in (between 0 and 1)
  const rollAlpha = computeAircraftVisibilityAlpha(track, 5, 265, 102, 256, true);
  assert.ok(rollAlpha > 0.2 && rollAlpha < 0.85, `Expected smooth fade-in, got ${rollAlpha}`);
  // Airborne -> 1
  assert.equal(computeAircraftVisibilityAlpha(track, 10, 950, 165, 256, true), 1);
  // 2s after airborne (touchdown rollout) -> still fading out (> 0)
  const rolloutAlpha = computeAircraftVisibilityAlpha(track, 12.5, 275, 55, 256, true);
  assert.ok(rolloutAlpha > 0.3 && rolloutAlpha < 1, `Expected post-landing fade-out, got ${rolloutAlpha}`);
  // Hide Ground Traffic disabled -> always 1
  assert.equal(computeAircraftVisibilityAlpha(track, 0, 260, 18, 256, false), 1);
});

test('parseOverpassResponse converts OSM water, rivers, and city nodes into BaseMapData', () => {
  const map = parseOverpassResponse(
    {
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 56.32,
          lon: 44.0,
          tags: { place: 'city', 'name:en': 'Nizhny Novgorod' },
        },
        {
          type: 'way',
          id: 2,
          tags: { waterway: 'river', 'name:en': 'Volga' },
          geometry: [
            { lat: 56.35, lon: 43.6 },
            { lat: 56.32, lon: 44.0 },
            { lat: 56.28, lon: 44.4 },
          ],
        },
        {
          type: 'way',
          id: 3,
          tags: { natural: 'water', name: 'Gorky Reservoir' },
          geometry: [
            { lat: 56.5, lon: 43.3 },
            { lat: 56.5, lon: 43.5 },
            { lat: 56.7, lon: 43.5 },
            { lat: 56.7, lon: 43.3 },
          ],
        },
      ],
    },
    { lat: 56.23, lon: 43.78417 },
  );

  assert.equal(map.polygons.length, 1);
  assert.ok(map.polylines.length >= 2);
  assert.ok(map.labels.some((l) => l.text === 'NIZHNY NOVGOROD'));
});

test('cleanSectorTitle removes duplicated FIR titles and inspectEuroScopeFiles deduplicates airports/SIDs', () => {
  const cleaned = cleanSectorTitle(
    'CUSTOM · VATSIM MOSCOW FIR V9.6.5 (AIRAC2607) VATSIM MOSCOW FIR',
    'UWGG',
  );
  assert.equal(cleaned, 'VATSIM MOSCOW FIR V9.6.5 (AIRAC2607)');

  const sct = `
[INFO]
VATSIM MOSCOW FIR V9.6.5 VATSIM MOSCOW FIR
UWGG
N056.13.48.000 E043.47.03.000

[AIRPORT]
UWGG 118.300 N056.13.48.000 E043.47.03.000
UWGG 118.300 N056.13.48.000 E043.47.03.000
UUBI 120.000 N056.56.24.000 E040.56.31.000

[SID]
UWGG 18R LARNO2U N056.13.48.000 E043.47.03.000 N056.00.00.000 E043.20.00.000
  N056.00.00.000 E043.20.00.000 N055.45.00.000 E043.00.00.000
`;
  const catalog = inspectEuroScopeFiles(sct, '');
  assert.equal(catalog.airports.length, 2);
  assert.equal(catalog.procedures.length, 1);
  assert.equal(catalog.procedures[0].runway, '18R');
  assert.equal(catalog.procedures[0].procedureType, 'SID');
  assert.equal(catalog.procedures[0].segments.length, 2);
});

test('FSD parser extracts log-driven controller events and resolveAircraftController prefers log over geometry', () => {
  const log = `
[16:00:00] @N:AUL510:4215:1:56.23000:43.78000:3000:210:0:0
[16:00:05] $CQUWGG_TWR:@94835:IT:AUL510
[16:00:30] @N:AUL510:4215:1:56.50000:44.50000:16000:380:0:0
[16:01:00] $HAUWGG_R_APP:UWGG_TWR:AUL510
[16:01:30] @N:AUL510:4215:1:56.70000:45.10000:22000:410:0:0
[16:02:00] $CQUWGG_R_APP:@94835:DR:AUL510
[16:02:05] $CRUUWV_CTR:UWGG_R_APP:WH:Y:AUL510
`;
  const parsed = parseEuroScopeFsdLog(log, 'handoff.txt', { lat: 56.23, lon: 43.78 });
  assert.equal(parsed.tracks.length, 1);
  const track = parsed.tracks[0];
  assert.ok((track.controllerEvents?.length ?? 0) >= 3);

  const volumes: AirspaceVolume[] = [
    {
      id: 'fir',
      name: 'UUWV_CTR',
      shortCode: 'CTR',
      kind: 'FIR',
      floorFt: 10000,
      ceilingFt: 35000,
      polygon: [
        { lat: 55.0, lon: 42.0 },
        { lat: 55.0, lon: 46.0 },
        { lat: 58.0, lon: 46.0 },
        { lat: 58.0, lon: 42.0 },
      ],
    },
  ];

  // At 16:00:30 aircraft is physically inside FIR (16000 ft), but log says UWGG_TWR still owns it
  const t30 = 16 * 3600 + 30;
  const r30 = resolveAircraftController(track.controllerEvents, t30, 56.5, 44.5, 16000, volumes);
  assert.equal(r30.kind, 'CTR');
  assert.equal(r30.sectorCode, 'TWR');

  // After $HA to UWGG_R_APP at 16:01:00 -> TMA / RADAR (Нижний круг)
  const t90 = 16 * 3600 + 90;
  const r90 = resolveAircraftController(track.controllerEvents, t90, 56.7, 45.1, 22000, volumes);
  assert.equal(r90.kind, 'TMA');
  assert.equal(r90.sectorCode, 'RADAR');

  // After $CR WH:Y from UUWV_CTR at 16:02:05 -> FIR / CTR (Москва контроль)
  const t130 = 16 * 3600 + 130;
  const r130 = resolveAircraftController(track.controllerEvents, t130, 56.7, 45.1, 22000, volumes);
  assert.equal(r130.kind, 'FIR');
  assert.equal(r130.sectorCode, 'CTR');
});

test('smoothSegmentAltitudes suppresses Mode-C 100ft step jitter while preserving climb slope', () => {
  // Steady 1000 ft/min climb (~16.67 ft/sec) with +/- 80 ft sawtooth jitter every 2 seconds
  const samples: RadarSample[] = [];
  for (let i = 0; i <= 30; i++) {
    const t = i * 2;
    const trueAlt = 5000 + t * 16.67;
    const jitter = i % 2 === 0 ? 80 : -80;
    samples.push({
      timeSec: t,
      lat: 56.23,
      lon: 43.78,
      altFt: trueAlt + jitter,
      gsKt: 260,
      headingDeg: 180,
    });
  }

  const smoothed = smoothSegmentAltitudes(samples, 10);
  // Measure residual error vs true climb in the middle (indices 8..22)
  let rawErrSum = 0;
  let smoothErrSum = 0;
  for (let i = 8; i <= 22; i++) {
    const trueAlt = 5000 + samples[i].timeSec * 16.67;
    rawErrSum += Math.abs(samples[i].altFt - trueAlt);
    smoothErrSum += Math.abs(smoothed[i] - trueAlt);
  }
  assert.ok(
    smoothErrSum < rawErrSum * 0.25,
    `Expected Gaussian smoothing to cut jitter >75%, raw=${rawErrSum}, smooth=${smoothErrSum}`,
  );
  // Endpoints still reflect real climb gain
  assert.ok(smoothed[25] - smoothed[5] > 550, 'Climb slope must be preserved');
});

test('parseGeoJsonBaseMap preserves polygon holes, MultiLineString rivers, and Point city labels', () => {
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { natural: 'water', name: 'Gorky Reservoir' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [43.4, 56.4],
              [43.9, 56.4],
              [43.9, 56.8],
              [43.4, 56.8],
              [43.4, 56.4],
            ],
            [
              [43.55, 56.55],
              [43.65, 56.55],
              [43.65, 56.65],
              [43.55, 56.65],
              [43.55, 56.55],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { waterway: 'river', name: 'Volga' },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [43.5, 56.35],
              [44.0, 56.32],
              [44.5, 56.25],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { place: 'city', name: 'Nizhny Novgorod' },
        geometry: {
          type: 'Point',
          coordinates: [44.0059, 56.3269],
        },
      },
    ],
  });

  const baseMap = parseGeoJsonBaseMap(geojson, 'volga.geojson', { lat: 56.23, lon: 43.78 });
  assert.equal(baseMap.polygons.length, 1);
  assert.equal(baseMap.polygons[0].kind, 'WATER');
  assert.equal(baseMap.polygons[0].holes?.length, 1);
  assert.ok(baseMap.polylines.some((l) => l.kind === 'RIVER'));
  assert.ok(baseMap.labels.some((l) => l.text === 'NIZHNY NOVGOROD'));
});

test('airportTrafficStats counts target-airport AIRBORNE and LANDED deterministically across scrubbing', () => {
  const mkTrack = (
    callsign: string,
    origin: string,
    destination: string,
    samples: RadarSample[],
  ): AircraftTrack => ({
    callsign,
    squawk: '2000',
    flightPlan: {
      callsign,
      aircraftType: 'B738/M',
      origin,
      destination,
      cruiseAltFt: 32000,
      route: '',
    },
    samples,
    segments: [{ startTime: samples[0].timeSec, endTime: samples[samples.length - 1].timeSec, samples }],
    firstSeen: samples[0].timeSec,
    lastSeen: samples[samples.length - 1].timeSec,
  });

  const dataset: RadarDataset = {
    sourceName: 'test',
    center: { lat: 56.23, lon: 43.784 },
    startTime: 0,
    endTime: 600,
    atcStations: [],
    diagnostics: { totalLines: 10, pilotPackets: 10, flightPlans: 3, warnings: [] },
    tracks: [
      // Departs UWGG at t=100
      mkTrack('DEP1', 'UWGG', 'ULLI', [
        { timeSec: 50, lat: 56.23, lon: 43.784, altFt: 260, gsKt: 20, headingDeg: 180 },
        { timeSec: 100, lat: 56.22, lon: 43.784, altFt: 950, gsKt: 160, headingDeg: 180 },
        { timeSec: 300, lat: 56.0, lon: 43.5, altFt: 14000, gsKt: 340, headingDeg: 210 },
      ]),
      // Lands at UWGG at t=400
      mkTrack('ARR1', 'UUEE', 'UWGG', [
        { timeSec: 100, lat: 56.4, lon: 43.2, altFt: 12000, gsKt: 300, headingDeg: 110 },
        { timeSec: 350, lat: 56.28, lon: 43.78, altFt: 1400, gsKt: 155, headingDeg: 180 },
        { timeSec: 400, lat: 56.23, lon: 43.784, altFt: 280, gsKt: 60, headingDeg: 180 },
      ]),
      // Pure overflight UUEE->USSS (must NOT count toward UWGG airborne or landed)
      mkTrack('OVR1', 'UUEE', 'USSS', [
        { timeSec: 0, lat: 56.5, lon: 43.0, altFt: 35000, gsKt: 470, headingDeg: 90 },
        { timeSec: 500, lat: 56.5, lon: 45.0, altFt: 35000, gsKt: 470, headingDeg: 90 },
      ]),
    ],
  };

  const index = buildAirportFlightEventIndex(dataset.tracks, 'UWGG', { lat: 56.23, lon: 43.784 }, 256);

  assert.deepEqual(computeAirportTrafficCounters(index, 60), { airborne: 0, landed: 0 });
  assert.deepEqual(computeAirportTrafficCounters(index, 120), { airborne: 1, landed: 0 });
  assert.deepEqual(computeAirportTrafficCounters(index, 450), { airborne: 1, landed: 1 });
  // Scrubbing backward returns exact deterministic state
  assert.deepEqual(computeAirportTrafficCounters(index, 120), { airborne: 1, landed: 0 });
});

test('Russian VATSIM ATC template maps UWGG_TWR, UWGG_R_APP, UWGG_APP, UUWV_CTR/UUWV_X_CTR with 4 distinct colors', () => {
  assert.deepEqual(parseControllerCallsign('UWGG_TWR'), { kind: 'CTR', sectorCode: 'TWR' });
  assert.deepEqual(parseControllerCallsign('UWGG_R_APP'), { kind: 'TMA', sectorCode: 'RADAR' });
  assert.deepEqual(parseControllerCallsign('UWGG_APP'), { kind: 'APP', sectorCode: 'APP' });
  assert.deepEqual(parseControllerCallsign('UUWV_CTR'), { kind: 'FIR', sectorCode: 'CTR' });
  assert.deepEqual(parseControllerCallsign('UUWV_X_CTR'), { kind: 'FIR', sectorCode: 'CTR' });

  const colors = new Set([
    getSectorControlColorHex('CTR', true),
    getSectorControlColorHex('TMA', true),
    getSectorControlColorHex('APP', true),
    getSectorControlColorHex('FIR', true),
  ]);
  assert.equal(colors.size, 4, 'All 4 ATC tiers must have distinct colors in dark mode');
});

test('APP to CTR handoff never gets stuck on APP (HT, HO+DR, climbing DR, and FL265 safety valve)', () => {
  const volumes: AirspaceVolume[] = [
    {
      id: 'uwgg-app',
      name: 'UWGG_APP',
      shortCode: 'APP',
      kind: 'APP',
      floorFt: 5000,
      ceilingFt: 26500,
      polygon: [
        { lat: 55.0, lon: 42.0 },
        { lat: 55.0, lon: 46.0 },
        { lat: 58.0, lon: 46.0 },
        { lat: 58.0, lon: 42.0 },
      ],
    },
    {
      id: 'uuwv-ctr',
      name: 'UUWV_X_CTR',
      shortCode: 'CTR',
      kind: 'FIR',
      floorFt: 11000,
      ceilingFt: 36000,
      polygon: [
        { lat: 54.0, lon: 41.0 },
        { lat: 54.0, lon: 47.0 },
        { lat: 59.0, lon: 47.0 },
        { lat: 59.0, lon: 41.0 },
      ],
    },
  ];

  // Case 1: $HO to UUWV_X_CTR followed by $CQ UWGG_APP DR (observer missed $HA)
  const log = `
[16:00:00] @N:AFL100:4101:1:56.23000:43.78000:12000:320:0:0
[16:00:02] $CQUWGG_APP:@94835:IT:AFL100
[16:00:30] $HOUWGG_APP:UUWV_X_CTR:AFL100
[16:00:40] $CQUWGG_APP:@94835:DR:AFL100
[16:01:00] @N:AFL100:4101:1:56.40000:44.10000:22000:410:0:0
[16:00:00] @N:SDM200:4102:1:56.23000:43.78000:14000:340:0:0
[16:00:02] $CQUWGG_APP:@94835:IT:SDM200
[16:00:50] $CQUWGG_APP:@94835:DR:SDM200
[16:01:10] @N:SDM200:4102:1:56.45000:44.15000:18000:380:0:0
[16:00:00] @N:PBD300:4103:1:56.23000:43.78000:15000:350:0:0
[16:00:02] $CQUWGG_APP:@94835:IT:PBD300
[16:01:30] @N:PBD300:4103:1:56.55000:44.45000:29000:430:0:0
`;
  const parsed = parseEuroScopeFsdLog(log, 'app_to_ctr.txt', { lat: 56.23, lon: 43.78 });
  const tBase = 16 * 3600;

  const afl = parsed.tracks.find((t) => t.callsign === 'AFL100')!;
  assert.equal(
    resolveAircraftController(afl.controllerEvents, tBase + 55, 56.4, 44.1, 22000, volumes).sectorCode,
    'CTR',
  );

  // Case 2: UWGG_APP drops climbing flight at 18000 ft without $HO -> excludes APP, picks CTR
  const sdm = parsed.tracks.find((t) => t.callsign === 'SDM200')!;
  assert.equal(
    resolveAircraftController(sdm.controllerEvents, tBase + 65, 56.45, 44.15, 18000, volumes)
      .sectorCode,
    'CTR',
  );

  // Case 3: No handoff packet logged at all, aircraft climbs to FL290 (> FL265 APP ceiling) -> CTR
  const pbd = parsed.tracks.find((t) => t.callsign === 'PBD300')!;
  assert.equal(
    resolveAircraftController(pbd.controllerEvents, tBase + 90, 56.55, 44.45, 29000, volumes)
      .sectorCode,
    'CTR',
  );
});

test('FSD parser suppresses mass disconnect DR bursts so aircraft tags do not flash to APP', () => {
  const log = `
[16:00:00] @N:FLT1:1001:1:56.23000:43.78000:28000:430:0:0
[16:00:00] @N:FLT2:1002:1:56.24000:43.79000:29000:430:0:0
[16:00:00] @N:FLT3:1003:1:56.25000:43.80000:30000:430:0:0
[16:00:02] $CQUUWV_CTR:@94835:IT:FLT1
[16:00:02] $CQUUWV_CTR:@94835:IT:FLT2
[16:00:02] $CQUUWV_CTR:@94835:IT:FLT3
[16:00:30] $CQUUWV_CTR:@94835:DR:FLT1
[16:00:31] $CQUUWV_CTR:@94835:DR:FLT2
[16:00:31] $CQUUWV_CTR:@94835:DR:FLT3
[16:01:00] @N:FLT1:1001:1:56.26000:43.81000:28000:430:0:0
[16:01:00] @N:FLT2:1002:1:56.27000:43.82000:29000:430:0:0
[16:01:00] @N:FLT3:1003:1:56.28000:43.83000:30000:430:0:0
`;
  const parsed = parseEuroScopeFsdLog(log, 'disconnect.txt', { lat: 56.23, lon: 43.78 });
  const t35 = 16 * 3600 + 35;
  for (const cs of ['FLT1', 'FLT2', 'FLT3']) {
    const tr = parsed.tracks.find((t) => t.callsign === cs)!;
    const res = resolveAircraftController(tr.controllerEvents, t35, 56.25, 43.8, 28000, []);
    assert.equal(res.sectorCode, 'CTR', `${cs} must remain CTR during mass disconnect burst`);
  }
});

test('EuroScope .ese parser reads OWNER lines and classifies UWGG_R_APP as RADAR and G1 as CTR', () => {
  const sct = `
[INFO]
VATSIM MOSCOW FIR
UWGG
N056.13.48.000 E043.47.03.000
[AIRPORT]
UWGG 118.300 N056.13.48.000 E043.47.03.000
`;
  const ese = `
[AIRSPACE]
SECTOR:UWGG_R_APP:1500:11000
OWNER:UWGG_R_APP
BORDER:B_R
SECTOR:G1:10000:66000
OWNER:UUWV_X_CTR:UUWV_CTR
BORDER:B_G1
SECTORLINE:B_R
COORD:N056.00.00.000:E043.00.00.000
COORD:N056.00.00.000:E044.00.00.000
COORD:N056.50.00.000:E044.00.00.000
COORD:N056.50.00.000:E043.00.00.000
SECTORLINE:B_G1
COORD:N055.00.00.000:E042.00.00.000
COORD:N055.00.00.000:E045.00.00.000
COORD:N057.00.00.000:E045.00.00.000
COORD:N057.00.00.000:E042.00.00.000
`;
  const airspace = parseEuroScopeAirspace(sct, ese, { lat: 56.23, lon: 43.78 });
  const radarVol = airspace.volumes.find((v) => v.name === 'UWGG_R_APP');
  const g1Vol = airspace.volumes.find((v) => v.name === 'G1');
  assert.ok(radarVol, 'Expected UWGG_R_APP volume');
  assert.equal(radarVol.kind, 'TMA');
  assert.equal(radarVol.shortCode, 'RADAR');
  assert.ok(g1Vol, 'Expected G1 volume');
  assert.equal(g1Vol.kind, 'FIR');
  assert.equal(g1Vol.shortCode, 'CTR');
});

test('resolveLabelOverlaps keeps existing aircraft label positions invariant when a new aircraft takes off', () => {
  const mkLabel = (callsign: string, x: number, y: number): ProjectedLabel => ({
    callsign,
    anchorX: x,
    anchorY: y,
    boxX: x + 16,
    boxY: y - 16,
    width: 72,
    height: 28,
    altFt: 12000,
    gsKt: 300,
    verticalRateFpm: 0,
    aircraftType: 'A320',
    destination: 'UWGG',
    selected: false,
  });

  const before = resolveLabelOverlaps(
    [mkLabel('AFL1019', 300, 300), mkLabel('SBI730', 700, 300), mkLabel('UTA512', 1100, 300)],
    1440,
    900,
  );
  // Insert a newly departing aircraft whose callsign sorts FIRST ('AAA001') far away from existing labels
  const after = resolveLabelOverlaps(
    [
      mkLabel('AAA001', 120, 720),
      mkLabel('AFL1019', 300, 300),
      mkLabel('SBI730', 700, 300),
      mkLabel('UTA512', 1100, 300),
    ],
    1440,
    900,
  );

  for (const prev of before) {
    const next = after.find((l) => l.callsign === prev.callsign)!;
    assert.equal(next.boxX, prev.boxX, `${prev.callsign} boxX must not jump on takeoff`);
    assert.equal(next.boxY, prev.boxY, `${prev.callsign} boxY must not jump on takeoff`);
  }
});

test('Anti-bounce suppresses ~1-2 min RADAR->APP->RADAR glitches and 90s DR reconnect gaps while keeping genuine handoffs', () => {
  const log = `
[16:00:00] @N:AFL501:4101:1:56.23000:43.78000:6000:260:0:0
[16:00:02] $CQUWGG_R_APP:@94835:IT:AFL501
[16:00:20] $CQUWGG_APP:@94835:TA:AFL501:12000
[16:01:00] $CQUWGG_APP:@94835:IT:AFL501
[16:02:15] $CQUWGG_R_APP:@94835:IT:AFL501
[16:05:00] $CQUWGG_APP:@94835:IT:AFL501
[16:07:30] $CQUUWV_CTR:@94835:IT:AFL501
[16:08:00] @N:AFL501:4101:1:56.60000:44.50000:22000:410:0:0
[16:00:00] @N:SDM502:4102:1:56.24000:43.79000:7000:270:0:0
[16:00:02] $CQUWGG_R_APP:@94835:IT:SDM502
[16:01:00] $CQUWGG_R_APP:@94835:DR:SDM502
[16:02:30] $CQUWGG_R_APP:@94835:IT:SDM502
[16:04:00] @N:SDM502:4102:1:56.30000:43.85000:9000:290:0:0
`;
  const parsed = parseEuroScopeFsdLog(log, 'antibounce.txt', { lat: 56.23, lon: 43.78 });
  const t0 = 16 * 3600;

  const afl = parsed.tracks.find((t) => t.callsign === 'AFL501')!;
  // During the 75-second erroneous APP excursion (16:01:00..16:02:15), AFL501 must stay RADAR
  assert.equal(
    resolveAircraftController(afl.controllerEvents, t0 + 90, 56.23, 43.78, 7000, []).sectorCode,
    'RADAR',
  );
  // Genuine later handoff to APP (16:05:00) and then CTR (16:07:30) must be preserved
  assert.equal(
    resolveAircraftController(afl.controllerEvents, t0 + 360, 56.4, 44.0, 15000, []).sectorCode,
    'APP',
  );
  assert.equal(
    resolveAircraftController(afl.controllerEvents, t0 + 460, 56.6, 44.5, 22000, []).sectorCode,
    'CTR',
  );

  // SDM502 had a 90s RADAR -> DR -> RADAR disconnect gap -> must remain RADAR without flashing to APP
  const sdm = parsed.tracks.find((t) => t.callsign === 'SDM502')!;
  assert.equal(
    resolveAircraftController(sdm.controllerEvents, t0 + 100, 56.25, 43.8, 7500, []).sectorCode,
    'RADAR',
  );
});

test('Mass synchronized disconnect wave (all tracks jumping to APP for ~2.5 min then reverting) is suppressed', () => {
  const log = `
[16:00:00] @N:AC1:1001:1:56.23000:43.78000:6000:250:0:0
[16:00:00] @N:AC2:1002:1:56.24000:43.79000:7000:260:0:0
[16:00:00] @N:AC3:1003:1:56.25000:43.80000:8000:270:0:0
[16:00:02] $CQUWGG_R_APP:@94835:IT:AC1
[16:00:02] $CQUWGG_R_APP:@94835:IT:AC2
[16:00:02] $CQUWGG_R_APP:@94835:IT:AC3
[16:01:00] $CQUWGG_APP:@94835:IT:AC1
[16:01:02] $CQUWGG_APP:@94835:IT:AC2
[16:01:04] $CQUWGG_APP:@94835:IT:AC3
[16:03:30] $CQUWGG_R_APP:@94835:IT:AC1
[16:03:32] $CQUWGG_R_APP:@94835:IT:AC2
[16:04:00] @N:AC1:1001:1:56.26000:43.81000:6500:250:0:0
[16:04:00] @N:AC2:1002:1:56.27000:43.82000:7500:260:0:0
[16:04:00] @N:AC3:1003:1:56.28000:43.83000:8500:270:0:0
`;
  const parsed = parseEuroScopeFsdLog(log, 'mass_wave.txt', { lat: 56.23, lon: 43.78 });
  const tMid = 16 * 3600 + 120;
  for (const cs of ['AC1', 'AC2', 'AC3']) {
    const tr = parsed.tracks.find((t) => t.callsign === cs)!;
    assert.equal(
      resolveAircraftController(tr.controllerEvents, tMid, 56.25, 43.8, 7000, []).sectorCode,
      'RADAR',
      `${cs} must not flash to APP during a synchronized disconnect wave`,
    );
  }
});

test('Airborne aircraft never display GND (neither from stale log nor from .ese UWGG_GND:0:0) and fall back to active airspace zone', () => {
  const sct = `
[INFO]
VATSIM MOSCOW FIR
UWGG
N056.13.48.000 E043.47.03.000
[AIRPORT]
UWGG 118.300 N056.13.48.000 E043.47.03.000
`;
  const ese = `
[AIRSPACE]
SECTOR:UWGG_GND:0:0
OWNER:UWGG_GND
COORD:N056.00.00.000:E043.00.00.000
COORD:N056.00.00.000:E044.50.00.000
COORD:N056.50.00.000:E044.50.00.000
COORD:N056.50.00.000:E043.00.00.000
SECTOR:UWGG_R_APP:1500:11000
OWNER:UWGG_R_APP
COORD:N056.00.00.000:E043.00.00.000
COORD:N056.00.00.000:E044.50.00.000
COORD:N056.50.00.000:E044.50.00.000
COORD:N056.50.00.000:E043.00.00.000
SECTOR:UWGG_APP:5000:26500
OWNER:UWGG_APP
COORD:N055.50.00.000:E042.50.00.000
COORD:N055.50.00.000:E045.00.00.000
COORD:N057.00.00.000:E045.00.00.000
COORD:N057.00.00.000:E042.50.00.000
`;
  const airspace = parseEuroScopeAirspace(sct, ese, { lat: 56.23, lon: 43.78 });
  const gndVol = airspace.volumes.find((v) => v.name === 'UWGG_GND')!;
  assert.ok(gndVol.ceilingFt <= 500, `UWGG_GND ceiling must be clamped <= 500ft, got ${gndVol.ceilingFt}`);

  // Case 1: Uncontrolled airborne aircraft at 6,000 ft -> must match UWGG_R_APP (RADAR), NOT GND!
  const unctrlRes = resolveAircraftController(
    undefined,
    100,
    56.23,
    43.78,
    6000,
    airspace.volumes,
    undefined,
    undefined,
    4.5,
    256,
  );
  assert.equal(unctrlRes.sectorCode, 'RADAR');

  // Case 2: Aircraft still assigned UWGG_GND in log while airborne at 14,000 ft -> must fall back to UWGG_APP (APP)!
  const staleGndEvents = [
    {
      timeSec: 10,
      controllerCallsign: 'UWGG_GND',
      sectorCode: 'GND',
      kind: 'CTR' as const,
    },
  ];
  const hyst = new Map();
  // On ground at 260 ft -> GND is allowed
  assert.equal(
    resolveAircraftController(staleGndEvents, 20, 56.23, 43.78, 260, airspace.volumes, hyst, 'TST1', 4.5, 256)
      .sectorCode,
    'GND',
  );
  // Airborne at 14,000 ft -> immediately snaps out of GND to APP (zone it is flying inside)
  assert.equal(
    resolveAircraftController(staleGndEvents, 21, 56.23, 43.78, 14000, airspace.volumes, hyst, 'TST1', 4.5, 256)
      .sectorCode,
    'APP',
  );
});

test('OpenFreeMap Slippy Map tile math & zoom grid selection cover UWGG cleanly', () => {
  const uwgg = { lat: 56.23, lon: 43.78417 };
  const tile8 = latLonToTile(uwgg.lat, uwgg.lon, 8);
  assert.equal(tile8.z, 8);
  assert.equal(tile8.x, 159);
  assert.equal(tile8.y, 79);

  // Tile center (2048, 2048) must round-trip back to the exact same tile
  const geoMid = tilePixelToLatLon(8, tile8.x, tile8.y, 2048, 2048, 4096);
  const roundTrip = latLonToTile(geoMid.lat, geoMid.lon, 8);
  assert.deepEqual(roundTrip, tile8);

  // 160 km radius -> z = 8, bounded <= 25 tiles; 230 km radius -> z = 7
  const grid160 = computeSlippyTileGrid(uwgg, 160);
  assert.equal(grid160.zoom, 8);
  assert.ok(grid160.tiles.length >= 9 && grid160.tiles.length <= 25);

  const grid230 = computeSlippyTileGrid(uwgg, 230);
  assert.equal(grid230.zoom, 7);
  assert.ok(grid230.tiles.length >= 4 && grid230.tiles.length <= 25);
});

test('decodeOpenFreeMapTile decodes binary MVT water (outer+hole), suppresses tile seams, extracts rivers, boundaries, and cities', () => {
  const zigzag = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0;
  const cmd = (id: number, count: number) => ((id & 0x7) | (count << 3)) >>> 0;

  const encodePolygonGeom = (rings: Array<Array<[number, number]>>): number[] => {
    const out: number[] = [];
    let cx = 0;
    let cy = 0;
    for (const ring of rings) {
      out.push(cmd(1, 1), zigzag(ring[0][0] - cx), zigzag(ring[0][1] - cy));
      cx = ring[0][0];
      cy = ring[0][1];
      out.push(cmd(2, ring.length - 1));
      for (let i = 1; i < ring.length; i++) {
        out.push(zigzag(ring[i][0] - cx), zigzag(ring[i][1] - cy));
        cx = ring[i][0];
        cy = ring[i][1];
      }
      out.push(cmd(7, 1));
    }
    return out;
  };

  const encodeLineGeom = (pts: Array<[number, number]>): number[] => {
    const out: number[] = [];
    out.push(cmd(1, 1), zigzag(pts[0][0]), zigzag(pts[0][1]));
    let cx = pts[0][0];
    let cy = pts[0][1];
    out.push(cmd(2, pts.length - 1));
    for (let i = 1; i < pts.length; i++) {
      out.push(zigzag(pts[i][0] - cx), zigzag(pts[i][1] - cy));
      cx = pts[i][0];
      cy = pts[i][1];
    }
    return out;
  };

  const encodePointGeom = (x: number, y: number): number[] => [cmd(1, 1), zigzag(x), zigzag(y)];

  interface LayerSpec {
    name: string;
    keys: string[];
    values: Array<string | number>;
    features: Array<{ id: number; type: number; tags: number[]; geom: number[] }>;
  }

  const writeLayer = (spec: LayerSpec, pbf: PbfWriter) => {
    pbf.writeVarintField(15, 2); // version = 2
    pbf.writeStringField(1, spec.name);
    for (const f of spec.features) {
      pbf.writeMessage(
        2,
        (feat, fp) => {
          fp.writeVarintField(1, feat.id);
          if (feat.tags.length > 0) fp.writePackedVarint(2, feat.tags);
          fp.writeVarintField(3, feat.type);
          fp.writePackedVarint(4, feat.geom);
        },
        f,
      );
    }
    for (const k of spec.keys) pbf.writeStringField(3, k);
    for (const v of spec.values) {
      pbf.writeMessage(
        4,
        (val, vp) => {
          if (typeof val === 'string') vp.writeStringField(1, val);
          else vp.writeVarintField(4, val);
        },
        v,
      );
    }
    pbf.writeVarintField(5, 4096); // extent
  };

  const pbf = new PbfWriter();
  // Water layer: CW outer ring touching tile border x=0 (must omit seam edge), plus CCW inner island hole
  const waterGeom = encodePolygonGeom([
    [
      [0, 1000],
      [1800, 1000],
      [1800, 2800],
      [0, 2800],
    ],
    [
      [600, 1500],
      [600, 2100],
      [1200, 2100],
      [1200, 1500],
    ],
  ]);
  pbf.writeMessage(3, writeLayer, {
    name: 'water',
    keys: ['class'],
    values: ['lake'],
    features: [{ id: 1, type: 3, tags: [0, 0], geom: waterGeom }],
  });

  // Waterway layer: Volga river LineString
  pbf.writeMessage(3, writeLayer, {
    name: 'waterway',
    keys: ['class'],
    values: ['river'],
    features: [
      {
        id: 2,
        type: 2,
        tags: [0, 0],
        geom: encodeLineGeom([
          [800, 800],
          [2000, 2000],
          [3200, 2600],
        ]),
      },
    ],
  });

  // Boundary layer: 1 land admin_level=4 border (kept) + 1 maritime=1 border (skipped)
  pbf.writeMessage(3, writeLayer, {
    name: 'boundary',
    keys: ['admin_level', 'maritime'],
    values: [4, 0, 1],
    features: [
      {
        id: 3,
        type: 2,
        tags: [0, 0, 1, 1],
        geom: encodeLineGeom([
          [400, 400],
          [3400, 400],
        ]),
      },
      {
        id: 4,
        type: 2,
        tags: [0, 0, 1, 2],
        geom: encodeLineGeom([
          [400, 3400],
          [3400, 3400],
        ]),
      },
    ],
  });

  // Place layer: Nizhny Novgorod city point
  pbf.writeMessage(3, writeLayer, {
    name: 'place',
    keys: ['class', 'name:en', 'rank'],
    values: ['city', 'Nizhny Novgorod', 2],
    features: [{ id: 5, type: 1, tags: [0, 0, 1, 1, 2, 2], geom: encodePointGeom(2048, 2048) }],
  });

  const bytes = pbf.finish();
  const center = tilePixelToLatLon(8, 159, 80, 2048, 2048, 4096);
  const decoded = decodeOpenFreeMapTile(bytes, 8, 159, 80, center, 160);

  assert.equal(decoded.polygons.length, 1);
  assert.equal(decoded.polygons[0].kind, 'WATER');
  assert.equal(decoded.polygons[0].holes?.length, 1, 'Inner island hole must be attached to outer water polygon');
  assert.equal(
    decoded.polylines.filter((l) => l.kind === 'COASTLINE').length,
    0,
    'Water polygons must render as pure stroke-free fills without bright COASTLINE outlines',
  );
  assert.equal(
    decoded.polylines.filter((l) => l.kind === 'RIVER').length,
    1,
    'Waterway river must be extracted',
  );
  assert.equal(
    decoded.polylines.filter((l) => l.kind === 'BOUNDARY').length,
    1,
    'Land boundary kept and maritime boundary skipped',
  );
  assert.equal(decoded.places.length, 1);
  assert.equal(decoded.places[0].text, 'NIZHNY NOVGOROD');
  assert.equal(decoded.places[0].placeTier, 'major');
});

test('computeExportPlan covers full 292-minute multi-hour log without 3600-frame truncation', () => {
  const start = 16 * 3600; // 16:00:00 UTC
  const duration292Min = 292 * 60; // 17,520 seconds (4h 52m)
  const end = start + duration292Min;

  // At 120x and 60 FPS -> 8,760 frames (2m 26s video), MUST NOT truncate at 3,600 frames (~120 min)!
  const plan120 = computeExportPlan({
    startTimeSec: start,
    endTimeSec: end,
    fps: 60,
    speedMultiplier: 120,
    width: 1280,
    height: 720,
  });
  assert.equal(plan120.totalFrames, 8760);
  assert.equal(plan120.outputVideoSec, 146);
  assert.equal(plan120.frameSimTime(0), start);
  assert.equal(plan120.frameSimTime(plan120.totalFrames - 1), end);
  assert.equal(formatDurationHms(duration292Min), '4h 52m');

  // Fit 292-minute log into a 90-second video -> speed ~194.67x, covers full endTimeSec
  const fitSpeed = computeSpeedForTargetDuration(duration292Min, 90);
  const planFit = computeExportPlan({
    startTimeSec: start,
    endTimeSec: end,
    fps: 60,
    speedMultiplier: fitSpeed,
  });
  assert.ok(Math.abs(planFit.outputVideoSec - 90) <= 0.25);
  assert.equal(planFit.frameSimTime(planFit.totalFrames - 1), end);
});

test('PagedStreamBuffer supports multi-page streaming writes and random-access WebM header patching', () => {
  // Small 1024-byte page size to exercise cross-page writes and finalize() header patching
  const buf = new PagedStreamBuffer(1024);

  const header = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
  buf.write(header, 0);

  // Write a 2500-byte payload spanning pages 0, 1, 2
  const payload = new Uint8Array(2500);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  buf.write(payload, 8);

  // Simulate webm-muxer finalize() patching duration bytes at offset 4
  buf.write(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 4);

  assert.equal(buf.byteLength, 2508);
  const chunks = buf.toChunks();
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].byteLength, 1024);
  assert.equal(chunks[1].byteLength, 1024);
  assert.equal(chunks[2].byteLength, 460);

  // Verify patched header & last byte
  assert.deepEqual(Array.from(chunks[0].subarray(0, 8)), [0x1a, 0x45, 0xdf, 0xa3, 0xde, 0xad, 0xbe, 0xef]);
  assert.equal(chunks[2][459], 2499 & 0xff);
});

test('computeRadialFadeAlpha smoothly dissolves terrain & traffic across 75-100% / 80-100% of Radar Range', () => {
  // Inside 80% of 150 km (= 120 km): fully opaque
  assert.equal(computeRadialFadeAlpha(0, 0, 150, 0.8), 1);
  assert.equal(computeRadialFadeAlpha(119, 0, 150, 0.8), 1);
  // Halfway across fade band (135 km): smooth ~0.5
  const mid = computeRadialFadeAlpha(135, 0, 150, 0.8);
  assert.ok(mid > 0.45 && mid < 0.55, `Expected ~0.5 at 135 km, got ${mid}`);
  // At & beyond Radar Range (150 km): strictly 0
  assert.equal(computeRadialFadeAlpha(150, 0, 150, 0.8), 0);
  assert.equal(computeRadialFadeAlpha(185, 40, 150, 0.8), 0);
});

test('shiftCityLabelAwayFromRunway moves overlapping city labels clear of central airport runway', () => {
  const close = shiftCityLabelAwayFromRunway(4, -3, 19);
  assert.equal(close.shifted, true);
  assert.ok(Math.hypot(close.x, close.z) >= 22, 'Shifted label must clear central runway footprint');

  const far = shiftCityLabelAwayFromRunway(-28, -3, 19);
  assert.equal(far.shifted, false);
  assert.equal(far.x, -28);
  assert.equal(far.z, -3);
});

test('resolveLabelOverlaps does NOT clamp off-screen aircraft datablocks to viewport borders', () => {
  const exiting: ProjectedLabel[] = [
    {
      callsign: 'AFL999',
      anchorX: 1520, // 80 px past right edge of 1440px viewport
      anchorY: 420,
      boxX: 1540,
      boxY: 396,
      width: 78,
      height: 29,
      altFt: 32000,
      gsKt: 460,
      verticalRateFpm: 0,
      aircraftType: 'A320',
      destination: 'UUEE',
      selected: false,
    },
    {
      callsign: 'PBD101',
      anchorX: -95, // 95 px past left edge
      anchorY: 500,
      boxX: -75,
      boxY: 476,
      width: 78,
      height: 29,
      altFt: 28000,
      gsKt: 430,
      verticalRateFpm: 0,
      aircraftType: 'B738',
      destination: 'UWGG',
      selected: false,
    },
  ];
  const resolved = resolveLabelOverlaps(exiting, 1440, 900, 6);
  const afl = resolved.find((l) => l.callsign === 'AFL999')!;
  const pbd = resolved.find((l) => l.callsign === 'PBD101')!;

  assert.ok(afl.boxX > 1500, `Exiting right-edge label must not clamp to viewport (got ${afl.boxX})`);
  assert.ok(pbd.boxX < -40, `Exiting left-edge label must not clamp to viewport (got ${pbd.boxX})`);
});

test('decodeOpenFreeMapTile extracts built-up residential/industrial landuse (>= 0.08 km2) and major arterial roads', () => {
  const zigzag = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0;
  const cmd = (id: number, count: number) => ((id & 0x7) | (count << 3)) >>> 0;
  const encodeSquare = (x0: number, y0: number, x1: number, y1: number): number[] => {
    const pts: Array<[number, number]> = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const out: number[] = [];
    let cx = 0;
    let cy = 0;
    out.push(cmd(1, 1), zigzag(pts[0][0] - cx), zigzag(pts[0][1] - cy));
    cx = pts[0][0];
    cy = pts[0][1];
    out.push(cmd(2, pts.length - 1));
    for (let i = 1; i < pts.length; i++) {
      out.push(zigzag(pts[i][0] - cx), zigzag(pts[i][1] - cy));
      cx = pts[i][0];
      cy = pts[i][1];
    }
    out.push(cmd(7, 1));
    return out;
  };
  const encodeLine = (pts: Array<[number, number]>): number[] => {
    const out: number[] = [];
    let cx = 0;
    let cy = 0;
    out.push(cmd(1, 1), zigzag(pts[0][0] - cx), zigzag(pts[0][1] - cy));
    cx = pts[0][0];
    cy = pts[0][1];
    out.push(cmd(2, pts.length - 1));
    for (let i = 1; i < pts.length; i++) {
      out.push(zigzag(pts[i][0] - cx), zigzag(pts[i][1] - cy));
      cx = pts[i][0];
      cy = pts[i][1];
    }
    return out;
  };

  const pbf = new PbfWriter();
  // Layer 1: landuse (KEEP residential/industrial built-up blocks >= 0.08 km2; DROP farmland/forest)
  pbf.writeMessage(
    3,
    (_spec, lp) => {
      lp.writeVarintField(15, 2);
      lp.writeStringField(1, 'landuse');
      lp.writeMessage(
        2,
        (_f, fp) => {
          fp.writeVarintField(1, 1);
          fp.writePackedVarint(2, [0, 0]);
          fp.writeVarintField(3, 3);
          fp.writePackedVarint(4, encodeSquare(1000, 1000, 1800, 1800));
        },
        null,
      );
      lp.writeMessage(
        2,
        (_f, fp) => {
          fp.writeVarintField(1, 2);
          fp.writePackedVarint(2, [0, 1]);
          fp.writeVarintField(3, 3);
          fp.writePackedVarint(4, encodeSquare(2200, 2200, 3000, 3000));
        },
        null,
      );
      lp.writeStringField(3, 'class');
      lp.writeMessage(4, (_v, vp) => vp.writeStringField(1, 'residential'), null);
      lp.writeMessage(4, (_v, vp) => vp.writeStringField(1, 'farmland'), null);
      lp.writeVarintField(5, 4096);
    },
    null,
  );
  // Layer 2: transportation (MUST keep motorway/trunk/primary/secondary, drop service/residential)
  pbf.writeMessage(
    3,
    (_spec, lp) => {
      lp.writeVarintField(15, 2);
      lp.writeStringField(1, 'transportation');
      lp.writeMessage(
        2,
        (_f, fp) => {
          fp.writeVarintField(1, 10);
          fp.writePackedVarint(2, [0, 0]);
          fp.writeVarintField(3, 2);
          fp.writePackedVarint(4, encodeLine([[1600, 1800], [2100, 2000], [2500, 2200]]));
        },
        null,
      );
      lp.writeMessage(
        2,
        (_f, fp) => {
          fp.writeVarintField(1, 11);
          fp.writePackedVarint(2, [0, 1]);
          fp.writeVarintField(3, 2);
          fp.writePackedVarint(4, encodeLine([[1800, 1600], [2000, 2400]]));
        },
        null,
      );
      lp.writeMessage(
        2,
        (_f, fp) => {
          fp.writeVarintField(1, 12);
          fp.writePackedVarint(2, [0, 2]);
          fp.writeVarintField(3, 2);
          fp.writePackedVarint(4, encodeLine([[1950, 1950], [2050, 2050]]));
        },
        null,
      );
      lp.writeStringField(3, 'class');
      lp.writeMessage(4, (_v, vp) => vp.writeStringField(1, 'trunk'), null);
      lp.writeMessage(4, (_v, vp) => vp.writeStringField(1, 'secondary'), null);
      lp.writeMessage(4, (_v, vp) => vp.writeStringField(1, 'residential'), null);
      lp.writeVarintField(5, 4096);
    },
    null,
  );

  const bytes = pbf.finish();
  const center = tilePixelToLatLon(8, 159, 79, 2048, 2048, 4096);
  const decoded = decodeOpenFreeMapTile(bytes, 8, 159, 79, center, 150);

  const urbanPolys = decoded.polygons.filter((p) => p.kind === 'URBAN');
  const roadLines = decoded.polylines.filter((l) => l.kind === 'ROAD');
  assert.equal(urbanPolys.length, 1, 'Built-up residential landuse should be extracted while farmland is dropped');
  assert.equal(roadLines.length, 2, 'Only major arterial road classes (motorway/trunk/primary/secondary) should be extracted');
});

test('urbanFabric suppresses isolated low-mass villages and keeps nocturnal city core strictly below Bloom threshold', () => {
  assert.equal(isBuiltUpLanduseClass('residential'), true);
  assert.equal(isBuiltUpLanduseClass('industrial'), true);
  assert.equal(isBuiltUpLanduseClass('farmland'), false);
  assert.equal(isBuiltUpLanduseClass('wood'), false);

  // Isolated tiny village diluted by Gaussian blur (< 0.10) must dissolve cleanly to 0
  assert.equal(evaluateUrbanDensityCurve(0.05), 0);
  assert.equal(evaluateUrbanDensityCurve(0.1), 0);
  // Real city quarter rises smoothly
  const mid = evaluateUrbanDensityCurve(0.45);
  const core = evaluateUrbanDensityCurve(0.85);
  assert.ok(mid > 0.4 && mid < 0.75, `Expected smooth mid-city density, got ${mid}`);
  assert.equal(core, 1);

  // Dark nocturnal urban core RGB channels must stay strictly below Bloom threshold (0.66 * 255 = 168)
  const [r, g, b, a] = sampleUrbanFabricRgba(1.0, true, 1.0);
  assert.ok(r <= 100 && g <= 120 && b <= 150, `Urban core RGB (${r},${g},${b}) must stay sleek slate-steel below Bloom`);
  assert.ok(a > 130 && a <= 185, `Expected calm non-intrusive alpha, got ${a}`);

  // Coordinate mapping centers airport (0, 0) cleanly at exact canvas midpoint
  const [cx, cy] = enuToCanvasPixel(0, 0, 270, 1024);
  assert.equal(cx, 512);
  assert.equal(cy, 512);
});

test('nightLights generates deterministic geographically grounded street/block lights with warm sodium/gold/white palette and strict water exclusion', () => {
  // 1. Kelvin palette: warm amber/gold predominates; restrained cool white appears only at top fraction
  const [ar, ag, ab] = sampleNightLightColor(0.15, false);
  assert.ok(ar > ag && ag > ab, `Sodium amber must have R > G > B (got ${ar},${ag},${ab})`);
  const [wr, wg, wb] = sampleNightLightColor(0.82, false);
  assert.ok(wr > 0.9 && wg > 0.8 && wb > 0.5, 'Warm white should be soft warm tungsten');
  const [cr, cg, cb] = sampleNightLightColor(0.96, true);
  assert.ok(cb > cr && cr > 0.72, 'Cool white LED accent should be restrained neutral-cool, never neon blue');

  // 2. Geographic grounding + strict determinism + water exclusion
  const center = { lat: 56.23, lon: 43.78 };
  const proj = new LocalENUProjector(center);
  const offset = (eKm: number, nKm: number) => ({
    lat: center.lat + nKm / 111.32,
    lon: center.lon + eKm / (111.32 * Math.cos((center.lat * Math.PI) / 180)),
  });

  const testMap = {
    name: 'Test Night Map',
    waterBase: false,
    polygons: [
      {
        id: 'city-block',
        kind: 'URBAN' as const,
        points: [offset(0, 0), offset(12, 0), offset(12, 12), offset(0, 12)],
      },
      {
        id: 'river-cutout',
        kind: 'WATER' as const,
        points: [offset(4, -2), offset(8, -2), offset(8, 14), offset(4, 14)],
      },
    ],
    polylines: [
      {
        id: 'arterial-ave',
        kind: 'ROAD' as const,
        weight: 0.95,
        points: [offset(-10, 6), offset(2, 6), offset(14, 6)],
      },
    ],
    labels: [
      {
        id: 'city-ctr',
        text: 'CENTER',
        position: offset(2, 6),
        kind: 'CITY' as const,
        placeTier: 'major' as const,
        rank: 2,
      },
    ],
  };

  const hubs = buildUrbanHubs(testMap, proj);
  assert.ok(hubs.length >= 1);
  assert.ok(
    computeUrbanCoreWeight(2, -6, hubs) > computeUrbanCoreWeight(25, -25, hubs),
    'Downtown hub must have higher illumination centrality weight than distant suburbs',
  );

  const runA = generateNightCityLightPoints(testMap, proj, 150, 2000);
  const runB = generateNightCityLightPoints(testMap, proj, 150, 2000);
  assert.ok(runA.length > 80, `Expected structured road + block lights, got ${runA.length}`);
  assert.deepEqual(runA, runB, 'Night light coordinates & colors must be 100% deterministic (zero flicker/jumping)');

  // Non-bridge urban points inside water corridor (x in [4.2..7.8], away from road z=-6) must be strictly zero
  const nonBridgeWaterLights = runA.filter(
    (p) => p.x > 4.2 && p.x < 7.8 && Math.abs(p.z - -6) > 0.6,
  );
  assert.equal(
    nonBridgeWaterLights.length,
    0,
    'Residential/urban light points must never be placed inside water polygons',
  );

  // Quarters must be the primary light source (more quarter micro-lights than road/bridge lights)
  const quarterPts = runA.filter((p) => p.category === 'quarter');
  const roadAndBridgePts = runA.filter((p) => p.category === 'road' || p.category === 'bridge');
  assert.ok(
    quarterPts.length > roadAndBridgePts.length,
    `Urban quarters should dominate light distribution (quarters=${quarterPts.length}, roads+bridges=${roadAndBridgePts.length})`,
  );

  // Bridge extraction must detect the exact span crossing the water channel [x ~ 4..8] at z ~ -6
  const bridgeSegs = generateNightBridgeSegments(testMap, proj, 150);
  assert.ok(bridgeSegs.length >= 1, 'Expected at least 1 river bridge span crossing water polygon');
  for (const seg of bridgeSegs) {
    assert.ok(seg.x0 >= 3.7 && seg.x1 <= 8.3, `Bridge span must stay confined to water corridor (got ${seg.x0}..${seg.x1})`);
    assert.ok(Math.abs(seg.z0 - -6) < 0.2 && Math.abs(seg.z1 - -6) < 0.2);
  }

  // Open rural highway far outside town (x in [-9.5 .. -3.5]) must stay mostly dark
  const farRuralHighwayPts = runA.filter((p) => p.x < -3.5 && p.x > -9.5);
  assert.ok(
    farRuralHighwayPts.length <= 2,
    `Rural highway far outside city should stay mostly dark (got ${farRuralHighwayPts.length} lights)`,
  );
});

test('buildNominatimCityUrl and parseNominatimCityGeoJson query bounded viewbox and parse real city MultiPolygon with holes', () => {
  const center = { lat: 56.23, lon: 43.78 };
  const url = buildNominatimCityUrl('Nizhny Novgorod', center, 160);
  assert.ok(url.includes('format=geojson'));
  assert.ok(url.includes('polygon_geojson=1'));
  assert.ok(url.includes('polygon_threshold=0.002'));
  assert.ok(url.includes('limit=1'));
  assert.ok(url.includes('viewbox='));
  assert.ok(url.includes('bounded=1'));

  const mockGeoJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { display_name: 'Nizhny Novgorod' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            // Main city footprint (~220 km2) with an inner river/park hole (~4 km2)
            [
              [
                [43.75, 56.20],
                [44.10, 56.20],
                [44.10, 56.38],
                [43.75, 56.38],
                [43.75, 56.20],
              ],
              [
                [43.90, 56.28],
                [43.94, 56.28],
                [43.94, 56.30],
                [43.90, 56.30],
                [43.90, 56.28],
              ],
            ],
            // Tiny < 0.8 km2 administrative exclave (MUST be skipped)
            [
              [
                [43.60, 56.10],
                [43.605, 56.10],
                [43.605, 56.104],
                [43.60, 56.104],
                [43.60, 56.10],
              ],
            ],
          ],
        },
      },
    ],
  };

  const polys = parseNominatimCityGeoJson(mockGeoJson, 'nizhny-novgorod', center, 160);
  assert.equal(polys.length, 1, 'Should keep main city polygon and skip tiny <0.8 km2 exclave');
  assert.equal(polys[0].kind, 'URBAN');
  assert.equal(polys[0].holes?.length, 1, 'Should preserve valid inner polygon holes');
});

test('normalizeRgbToConstantLuminance prevents brightness spikes across all 4 sector colors and mid-handoff Color.lerp transitions', () => {
  const hexToRgb = (hex: number): [number, number, number] => [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
  const palette = [
    getSectorControlColorHex('CTR', true),     // TWR
    getSectorControlColorHex('TMA', true),     // RADAR
    getSectorControlColorHex('APP', true),     // APP
    getSectorControlColorHex('ENROUTE', true), // CTR
  ];
  const targetLum = 0.56;

  // Check each pure sector color
  for (const hex of palette) {
    const [r, g, b] = hexToRgb(hex);
    const [nr, ng, nb] = normalizeRgbToConstantLuminance(r, g, b, targetLum);
    const lum = computeRelativeLuminance(nr, ng, nb);
    assert.ok(
      Math.abs(lum - targetLum) < 0.015,
      `Expected constant luminance ${targetLum} for #${hex.toString(16)}, got ${lum.toFixed(4)}`,
    );
  }

  // Check linear RGB handoff transitions between every pair of sectors (e.g. TWR -> RADAR -> APP -> CTR)
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const a = hexToRgb(palette[i]);
      const b = hexToRgb(palette[j]);
      for (const t of [0.25, 0.5, 0.75]) {
        const mr = a[0] + (b[0] - a[0]) * t;
        const mg = a[1] + (b[1] - a[1]) * t;
        const mb = a[2] + (b[2] - a[2]) * t;
        const [nr, ng, nb] = normalizeRgbToConstantLuminance(mr, mg, mb, targetLum);
        const lum = computeRelativeLuminance(nr, ng, nb);
        assert.ok(
          Math.abs(lum - targetLum) < 0.015,
          `Expected constant handoff luminance ${targetLum} at t=${t}, got ${lum.toFixed(4)}`,
        );
      }
    }
  }
});

test('waypointFilter classifies .sct points, enforces Zoom LOD on approach fixes, and respects secondary airports & manual overrides', () => {
  const center = { lat: 56.23, lon: 43.78417 };
  const wpPrimary: Waypoint = { id: 'UWGG', lat: 56.23, lon: 43.78417, kind: 'AIRPORT' };
  const wpSecondary: Waypoint = { id: 'XUDK', lat: 56.18, lon: 43.62, kind: 'AIRPORT' };
  const wpApproach: Waypoint = { id: 'FN18L', lat: 56.31, lon: 43.79, kind: 'FIX' };
  const wpEnroute: Waypoint = { id: 'USTOK', lat: 56.1, lon: 43.18, kind: 'FIX' };

  assert.equal(classifyWaypoint(wpPrimary, 'UWGG', center), 'primary_airport');
  assert.equal(classifyWaypoint(wpSecondary, 'UWGG', center), 'secondary_airport');
  assert.equal(classifyWaypoint(wpApproach, 'UWGG', center), 'approach_fix');
  assert.equal(classifyWaypoint(wpEnroute, 'UWGG', center), 'enroute_fix');

  const baseOpts = {
    showWaypoints: true,
    showEnrouteFixes: true,
    showApproachFixes: true,
    secondaryAirportsMode: 'dimmed' as const,
    waypointOverrides: {},
    targetAirportCode: 'UWGG',
    airportCenter: center,
    cameraDistanceKm: APPROACH_FIX_LOD_MAX_CAMERA_DIST_KM + 40,
    radarRangeKm: 150,
  };

  // Zoomed out -> technical approach fix auto-hidden via Zoom LOD
  assert.equal(shouldShowWaypoint(wpApproach, baseOpts).visible, false);
  // Zoomed in -> technical approach fix becomes visible
  assert.equal(shouldShowWaypoint(wpApproach, { ...baseOpts, cameraDistanceKm: 80 }).visible, true);
  // Secondary airport dimmed vs hidden
  assert.deepEqual(shouldShowWaypoint(wpSecondary, baseOpts), {
    visible: true,
    category: 'secondary_airport',
    dimmed: true,
  });
  assert.equal(
    shouldShowWaypoint(wpSecondary, { ...baseOpts, secondaryAirportsMode: 'hidden' }).visible,
    false,
  );
  // Manual override explicitly hides USTOK
  assert.equal(
    shouldShowWaypoint(wpEnroute, { ...baseOpts, waypointOverrides: { USTOK: false } }).visible,
    false,
  );
});

test('formatUtcTimeHm formats HH:MM without flickering seconds', () => {
  assert.equal(formatUtcTimeHm(17 * 3600 + 3 * 60 + 49), '17:03');
  assert.equal(formatUtcTimeHm(86400 + 7 * 60 + 55), '00:07');
});

test('shouldShowGroundLabel filters city labels by All/Major/Off and manual per-city overrides', () => {
  const majorCity: GeoMapLabel = {
    id: 'city-nn',
    text: 'NIZHNY NOVGOROD',
    position: { lat: 56.32, lon: 44.0 },
    kind: 'CITY',
    placeTier: 'major',
  };
  const minorTown: GeoMapLabel = {
    id: 'city-bor',
    text: 'BOR',
    position: { lat: 56.36, lon: 44.06 },
    kind: 'CITY',
    placeTier: 'minor',
  };

  assert.equal(shouldShowGroundLabel(majorCity, 'major', {}), true);
  assert.equal(shouldShowGroundLabel(minorTown, 'major', {}), false);
  assert.equal(shouldShowGroundLabel(minorTown, 'all', {}), true);
  assert.equal(shouldShowGroundLabel(majorCity, 'off', {}), false);
  // Explicit manual overrides always win
  assert.equal(shouldShowGroundLabel(minorTown, 'major', { 'city-bor': true }), true);
  assert.equal(shouldShowGroundLabel(majorCity, 'major', { 'city-nn': false }), false);
});

test('cinematic cameraRig evaluates centripetal arc-length CatmullRom splines, easing, lens FOV, and 1-click presets', () => {
  // Full-frame 35mm focal length to vertical FOV conversion
  assert.ok(Math.abs(focalLengthMmToFovDeg(24) - 53.13) < 0.2);
  assert.ok(Math.abs(focalLengthMmToFovDeg(50) - 26.99) < 0.2);
  assert.ok(Math.abs(focalLengthMmToFovDeg(85) - 16.07) < 0.2);

  // Easing profiles monotonic & bounded in [0, 1]
  for (const mode of ['linear', 'smooth-s', 'ease-in', 'ease-out'] as const) {
    assert.equal(applyCameraEasing(0, mode), 0);
    assert.equal(applyCameraEasing(1, mode), 1);
    assert.ok(applyCameraEasing(0.25, mode) < applyCameraEasing(0.75, mode));
  }
  assert.ok(applyCameraEasing(0.2, 'ease-in') < 0.2);
  assert.ok(applyCameraEasing(0.2, 'ease-out') > 0.2);

  // Uniform arc-length speed under linear easing across uneven keyframe spacing
  const kfs: CameraKeyframe[] = [
    { id: 'k1', timeSec: 0, position: [0, 50, 0], target: [0, 0, 0], fov: 44, label: 'K1' },
    { id: 'k2', timeSec: 50, position: [10, 50, 0], target: [5, 0, 0], fov: 35, label: 'K2' },
    { id: 'k3', timeSec: 100, position: [100, 50, 0], target: [50, 0, 0], fov: 26, label: 'K3' },
  ];
  const p25 = evaluateCinematicCameraPath(kfs, 25, { easing: 'linear', tension: 0.5 })!;
  const p50 = evaluateCinematicCameraPath(kfs, 50, { easing: 'linear', tension: 0.5 })!;
  const p75 = evaluateCinematicCameraPath(kfs, 75, { easing: 'linear', tension: 0.5 })!;
  // Uniform arc-length parameterization puts t=50 near x=50 (halfway in space), not stuck at x=10!
  assert.ok(p50.position[0] > 42 && p50.position[0] < 58, `Expected uniform midpoint ~50, got ${p50.position[0]}`);
  assert.ok(p25.position[0] < p50.position[0] && p50.position[0] < p75.position[0]);
  assert.ok(typeof p50.fov === 'number' && p50.fov > 30 && p50.fov < 40);

  // 3D preview & auto presets
  for (const preset of ['slow-orbit', 'runway-glide', 'high-drift'] as const) {
    const generated = generateAutoCameraPreset(preset, 1000, 4600);
    assert.ok(generated.length >= 4, `Auto preset ${preset} should generate >= 4 keyframes`);
    const preview = sampleCameraPathPreview(generated, 0.5, 48);
    assert.equal(preview.length, 49);
  }
});

test('smoothSegment3D suppresses noisy manual X/Y/Z zigzags with zero temporal phase shift', () => {
  const samples: RadarSample[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i * 2; // 0..80s
    // Symmetric altitude/lateral pulse peaked cleanly at i=20 (t=40s) + high-frequency zigzag jitter
    const bell = Math.exp(-0.5 * Math.pow((i - 20) / 5, 2));
    const jitter = i === 0 || i === 40 ? 0 : (i % 2 === 0 ? 1 : -1);
    samples.push({
      timeSec: t,
      lat: 56.2 + i * 0.005 + jitter * 0.004,
      lon: 43.7 + bell * 0.04 + jitter * 0.004,
      altFt: 4000 + bell * 1200 + jitter * 180,
      gsKt: 160,
      headingDeg: 45,
    });
  }

  const smoothed = smoothSegment3D(samples, 12);
  assert.equal(smoothed.alts.length, samples.length);
  // Endpoints pinned
  assert.equal(smoothed.lats[0], samples[0].lat);
  assert.equal(smoothed.alts[40], samples[40].altFt);

  // Zero-phase check: peak of symmetric pulse remains at exact index 20 (no forward/backward lag!)
  let peakIdx = 0;
  for (let i = 1; i < smoothed.alts.length; i++) {
    if (smoothed.alts[i] > smoothed.alts[peakIdx]) peakIdx = i;
  }
  assert.equal(peakIdx, 20, `Zero-phase smoother shifted symmetric peak to index ${peakIdx}`);

  // High-frequency zigzag variance in both lateral (lat) and vertical (altFt) must drop dramatically
  const measureRoughness = (arr: ArrayLike<number>) => {
    let sum = 0;
    for (let i = 1; i < arr.length - 1; i++) {
      sum += Math.abs(arr[i] - 0.5 * (arr[i - 1] + arr[i + 1]));
    }
    return sum;
  };
  const rawAltRough = measureRoughness(samples.map((s) => s.altFt));
  const smoothAltRough = measureRoughness(smoothed.alts);
  const rawLatRough = measureRoughness(samples.map((s) => s.lat));
  const smoothLatRough = measureRoughness(smoothed.lats);

  assert.ok(smoothAltRough < rawAltRough * 0.2, `Expected >=80% altitude zigzag reduction (${smoothAltRough} vs ${rawAltRough})`);
  assert.ok(smoothLatRough < rawLatRough * 0.25, `Expected >=75% lateral zigzag reduction (${smoothLatRough} vs ${rawLatRough})`);
});




