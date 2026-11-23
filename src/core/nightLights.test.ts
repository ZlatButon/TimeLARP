import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalENUProjector } from './geo';
import {
  buildNightCityLightingData,
  generateNightBridgeSegments,
  generateNightCityLightPoints,
  generateNightRoadRibbons,
  sampleNightLightColor,
} from './nightLights';
import { buildUwggAirspaceDataset } from '../data/uwggDemoDataset';
import type { BaseMapData } from '../types/radar';

describe('Night City Lights — Realistic Aerial Architecture', () => {
  const dataset = buildUwggAirspaceDataset();
  const baseMap = dataset.baseMap!;
  const projector = new LocalENUProjector(dataset.center);

  it('produces 100% deterministic ribbons, points, and hubs across repeated runs', () => {
    const run1 = buildNightCityLightingData(baseMap, projector, 250, 12000);
    const run2 = buildNightCityLightingData(baseMap, projector, 250, 12000);

    assert.equal(run1.ribbons.length, run2.ribbons.length);
    assert.equal(run1.points.length, run2.points.length);
    assert.equal(run1.hubs.length, run2.hubs.length);
    assert.ok(run1.ribbons.length > 200, `Expected continuous road ribbons, got ${run1.ribbons.length}`);
    assert.ok(run1.points.length > 4000, `Expected rich structured points, got ${run1.points.length}`);

    for (let i = 0; i < Math.min(200, run1.points.length); i++) {
      assert.deepEqual(run1.points[i], run2.points[i]);
    }
    for (let i = 0; i < Math.min(200, run1.ribbons.length); i++) {
      assert.deepEqual(run1.ribbons[i], run2.ribbons[i]);
    }
  });

  it('eliminates regular Cartesian lattice / grid patterns in urban quarters', () => {
    const { points } = buildNightCityLightingData(baseMap, projector, 250, 18000);
    const quarterPts = points.filter((p) => p.category === 'quarter');
    assert.ok(quarterPts.length > 2000, `Expected dense quarter points, got ${quarterPts.length}`);

    // Verify no quantization onto 0.5km, 0.75km, or 1.0km Cartesian rows/columns
    for (const gridStep of [0.5, 0.75, 1.0]) {
      const binsX = new Array(10).fill(0);
      const binsZ = new Array(10).fill(0);
      for (const p of quarterPts) {
        const fx = (((p.x / gridStep) % 1) + 1) % 1;
        const fz = (((p.z / gridStep) % 1) + 1) % 1;
        binsX[Math.min(9, Math.floor(fx * 10))]++;
        binsZ[Math.min(9, Math.floor(fz * 10))]++;
      }
      const expected = quarterPts.length / 10;
      const maxXRatio = Math.max(...binsX) / expected;
      const maxZRatio = Math.max(...binsZ) / expected;
      assert.ok(
        maxXRatio < 1.35 && maxZRatio < 1.35,
        `Detected Cartesian grid bias at step ${gridStep}km (maxXRatio=${maxXRatio.toFixed(2)}, maxZRatio=${maxZRatio.toFixed(2)})`,
      );
    }
  });

  it('builds continuous hierarchical road ribbons with valid miter normals and narrow river bridges', () => {
    const ribbons = generateNightRoadRibbons(baseMap, projector, 250);
    assert.ok(ribbons.length > 250, `Expected >250 road ribbon segments, got ${ribbons.length}`);

    const bridges = ribbons.filter((r) => r.isBridge);
    const urbanMotorways = ribbons.filter(
      (r) => !r.isBridge && r.roadWeight >= 0.9 && (r.intensity0 + r.intensity1) * 0.5 > 0.25,
    );
    const urbanSecondary = ribbons.filter(
      (r) => !r.isBridge && r.roadWeight >= 0.52 && r.roadWeight < 0.72 && (r.intensity0 + r.intensity1) * 0.5 > 0.15,
    );

    assert.ok(bridges.length >= 6, `Expected river bridge ribbons across Volga/Oka, got ${bridges.length}`);
    assert.ok(urbanMotorways.length > 20, `Expected urban motorway ribbons, got ${urbanMotorways.length}`);
    assert.ok(urbanSecondary.length > 20, `Expected urban secondary street ribbons, got ${urbanSecondary.length}`);

    const avgMotorwayWidth =
      urbanMotorways.reduce((s, r) => s + r.halfWidthKm, 0) / urbanMotorways.length;
    const avgSecondaryWidth =
      urbanSecondary.reduce((s, r) => s + r.halfWidthKm, 0) / urbanSecondary.length;
    const avgMotorwayInt =
      urbanMotorways.reduce((s, r) => s + (r.intensity0 + r.intensity1) * 0.5, 0) / urbanMotorways.length;
    const avgSecondaryInt =
      urbanSecondary.reduce((s, r) => s + (r.intensity0 + r.intensity1) * 0.5, 0) / urbanSecondary.length;

    assert.ok(
      avgMotorwayWidth > avgSecondaryWidth * 1.25,
      `Motorways (${avgMotorwayWidth.toFixed(3)}km) should be wider than secondary streets (${avgSecondaryWidth.toFixed(3)}km)`,
    );
    assert.ok(
      avgMotorwayInt > avgSecondaryInt * 1.15,
      `Motorways (${avgMotorwayInt.toFixed(3)}) should be brighter than secondary streets (${avgSecondaryInt.toFixed(3)})`,
    );

    for (const r of ribbons) {
      const n0 = Math.hypot(r.nx0, r.nz0);
      const n1 = Math.hypot(r.nx1, r.nz1);
      assert.ok(
        Number.isFinite(n0) && n0 >= 0.95 && n0 <= 2.3,
        `Invalid start miter normal length ${n0}`,
      );
      assert.ok(
        Number.isFinite(n1) && n1 >= 0.95 && n1 <= 2.3,
        `Invalid end miter normal length ${n1}`,
      );
      if (r.isBridge) {
        assert.ok(
          r.halfWidthKm <= 0.13,
          `Bridge ribbon should stay narrow and crisp, got ${r.halfWidthKm}km`,
        );
      }
    }

    // Legacy bridge segment helper also continues to detect bridges cleanly
    const bridgeSegs = generateNightBridgeSegments(baseMap, projector, 250);
    assert.ok(bridgeSegs.length >= 4, `Expected legacy bridge helper to return segments, got ${bridgeSegs.length}`);
  });

  it('produces zero random single stray dots in dark open countryside', () => {
    // Synthetic map with one city polygon + one rural secondary road + empty countryside
    const syntheticMap: BaseMapData = {
      polygons: [
        {
          id: 'city-1',
          kind: 'URBAN',
          points: [
            { lat: 56.25, lon: 43.88 },
            { lat: 56.25, lon: 44.04 },
            { lat: 56.35, lon: 44.04 },
            { lat: 56.35, lon: 43.88 },
          ],
        },
      ],
      polylines: [
        {
          id: 'rural-secondary',
          kind: 'ROAD',
          weight: 0.55,
          points: [
            { lat: 56.90, lon: 45.20 },
            { lat: 57.10, lon: 45.60 },
          ],
        },
      ],
      labels: [],
    };

    const { points, ribbons } = buildNightCityLightingData(syntheticMap, projector, 200, 6000);
    assert.ok(points.length > 200, 'City should produce lights');

    // Every single light must lie within reasonable proximity of the urban polygon (no stray rural specks)
    const cityCenter = projector.toENU(56.30, 43.96, 0);
    const strayCount = points.filter((p) => Math.hypot(p.x - cityCenter.x, p.z - cityCenter.z) > 15).length;
    assert.equal(strayCount, 0, `Expected 0 stray countryside lights, found ${strayCount}`);

    // Deep rural secondary road must emit 0 ribbon segments
    assert.equal(ribbons.length, 0, `Deep rural secondary road should not glow, got ${ribbons.length} ribbons`);
  });

  it('strictly excludes non-bridge lights from water bodies', () => {
    const syntheticWaterMap: BaseMapData = {
      polygons: [
        {
          id: 'urban-block',
          kind: 'URBAN',
          points: [
            { lat: 56.20, lon: 43.80 },
            { lat: 56.20, lon: 44.10 },
            { lat: 56.40, lon: 44.10 },
            { lat: 56.40, lon: 43.80 },
          ],
        },
        {
          id: 'central-lake',
          kind: 'WATER',
          points: [
            { lat: 56.27, lon: 43.91 },
            { lat: 56.27, lon: 43.99 },
            { lat: 56.33, lon: 43.99 },
            { lat: 56.33, lon: 43.91 },
          ],
        },
      ],
      polylines: [],
      labels: [],
    };

    const pts = generateNightCityLightPoints(syntheticWaterMap, projector, 200, 5000);
    assert.ok(pts.length > 200);

    const sw = projector.toENU(56.27, 43.91, 0);
    const ne = projector.toENU(56.33, 43.99, 0);
    const minX = Math.min(sw.x, ne.x) + 0.1;
    const maxX = Math.max(sw.x, ne.x) - 0.1;
    const minZ = Math.min(sw.z, ne.z) + 0.1;
    const maxZ = Math.max(sw.z, ne.z) - 0.1;

    const insideLake = pts.filter(
      (p) => p.category !== 'bridge' && p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ,
    );
    assert.equal(insideLake.length, 0, `Expected 0 lights inside lake, found ${insideLake.length}`);
  });

  it('maintains warm sodium-vapor photographic color discipline with restrained cool-white accents', () => {
    const { points } = buildNightCityLightingData(baseMap, projector, 250, 15000);
    let warmCount = 0;
    let coolCount = 0;

    for (const p of points) {
      if (p.r >= p.g && p.g > p.b * 1.15) warmCount++;
      if (p.b > p.r * 0.96) coolCount++;
    }

    const warmFrac = warmCount / points.length;
    const coolFrac = coolCount / points.length;

    assert.ok(warmFrac >= 0.72, `Expected warm amber/gold/tungsten foundation >=72%, got ${(warmFrac * 100).toFixed(1)}%`);
    assert.ok(coolFrac <= 0.12, `Expected restrained cool-white accents <=12%, got ${(coolFrac * 100).toFixed(1)}%`);

    // Sanity check color sampler endpoints
    const deepSodium = sampleNightLightColor(0.05, false);
    const coolLed = sampleNightLightColor(0.99, true);
    assert.ok(deepSodium[0] > 0.9 && deepSodium[2] < 0.2);
    assert.ok(coolLed[2] > coolLed[0]);
  });

  it('creates clear brightness & density contrast between downtown cores and suburban outskirts', () => {
    const { points } = buildNightCityLightingData(baseMap, projector, 250, 18000);
    // Downtown Nizhny Novgorod around Oka-Volga confluence (56.326, 44.005)
    const downtown = projector.toENU(56.326, 44.005, 0);

    const corePts = points.filter((p) => Math.hypot(p.x - downtown.x, p.z - downtown.z) <= 5.5);
    const outerPts = points.filter((p) => {
      const d = Math.hypot(p.x - downtown.x, p.z - downtown.z);
      return d >= 10 && d <= 20;
    });

    assert.ok(corePts.length > 150, `Expected dense downtown core lights, got ${corePts.length}`);
    assert.ok(outerPts.length > 100, `Expected suburban lights, got ${outerPts.length}`);

    const coreArea = Math.PI * 5.5 * 5.5;
    const outerArea = Math.PI * (20 * 20 - 10 * 10);
    const coreDensity = corePts.length / coreArea;
    const outerDensity = outerPts.length / outerArea;
    const avgCoreInt = corePts.reduce((s, p) => s + p.intensity, 0) / corePts.length;
    const avgOuterInt = outerPts.reduce((s, p) => s + p.intensity, 0) / outerPts.length;

    assert.ok(
      coreDensity > outerDensity * 2.5,
      `Downtown density (${coreDensity.toFixed(1)}/km²) should far exceed suburbs (${outerDensity.toFixed(1)}/km²)`,
    );
    assert.ok(
      avgCoreInt > avgOuterInt * 1.12,
      `Downtown mean intensity (${avgCoreInt.toFixed(3)}) should exceed suburbs (${avgOuterInt.toFixed(3)})`,
    );
  });
});
