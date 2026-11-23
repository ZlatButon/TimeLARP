import type {
  AircraftTrack,
  AirspaceDataset,
  BaseMapData,
  CameraKeyframe,
  GeoPoint,
  RadarDataset,
  RadarSample,
} from '../types/radar';
import { LocalENUProjector } from '../core/geo';
import { segmentSamples } from '../core/fsdParser';
import { parseControllerCallsign } from '../core/airspaceZones';

/**
 * UWGG — Nizhny Novgorod Strigino International Airport (Moscow FIR)
 * Reference coordinates extracted directly from user's attached FSD log:
 * `%UWGG_R_APP:99998:5:150:5:56.23000:43.78417:0`
 */
export const UWGG_CENTER: GeoPoint = { lat: 56.23, lon: 43.78417 };

const demoProjector = new LocalENUProjector(UWGG_CENTER);

function offsetGeo(eastKm: number, northKm: number): GeoPoint {
  return demoProjector.toGeo(eastKm, -northKm);
}

/**
 * Built-in dark geographic base map of Nizhny Novgorod / Volga–Oka confluence region:
 * - Gorky Reservoir (large dark water basin to the northwest)
 * - Broad Volga River channel winding NW -> E through Nizhny Novgorod
 * - Oka River joining from SW right beside UWGG Strigino
 * - Subtle geographic map labels lying flat on the surface
 */
export function buildUwggBaseMap(): BaseMapData {
  // Gorky Reservoir & Volga River wide water polygon
  const gorkyReservoir: GeoPoint[] = [
    offsetGeo(-120, 155),
    offsetGeo(-78, 130),
    offsetGeo(-44, 92),
    offsetGeo(-26, 62),
    offsetGeo(-14, 42),
    offsetGeo(4, 24),
    offsetGeo(14, 15),
    offsetGeo(38, 12),
    offsetGeo(74, 6),
    offsetGeo(118, -2),
    offsetGeo(165, -8),
    offsetGeo(220, -14),
    offsetGeo(220, -22),
    offsetGeo(164, -15),
    offsetGeo(115, -9),
    offsetGeo(70, -1),
    offsetGeo(35, 6),
    offsetGeo(10, 9),
    offsetGeo(-4, 21),
    offsetGeo(-24, 40),
    offsetGeo(-42, 66),
    offsetGeo(-64, 98),
    offsetGeo(-98, 135),
    offsetGeo(-135, 160),
  ];

  // Oka River basin sweeping from SW into Volga confluence
  const okaRiver: GeoPoint[] = [
    offsetGeo(-175, -95),
    offsetGeo(-122, -62),
    offsetGeo(-78, -32),
    offsetGeo(-46, -16),
    offsetGeo(-20, -4),
    offsetGeo(6, 5),
    offsetGeo(13, 12),
    offsetGeo(8, 14),
    offsetGeo(2, 8),
    offsetGeo(-24, -1),
    offsetGeo(-50, -12),
    offsetGeo(-82, -28),
    offsetGeo(-126, -57),
    offsetGeo(-180, -90),
  ];

  // Eastern Sura / Cheboksary reservoir widening
  const cheboksaryWater: GeoPoint[] = [
    offsetGeo(145, -14),
    offsetGeo(182, -10),
    offsetGeo(225, -4),
    offsetGeo(245, -24),
    offsetGeo(205, -34),
    offsetGeo(165, -22),
  ];

  // Authentic built-up urban districts around UWGG (Nizhny Novgorod upper/lower city + satellite towns)
  const nnAvtozavod: GeoPoint[] = [
    offsetGeo(-6.5, 5.5),
    offsetGeo(-1.5, 7.2),
    offsetGeo(4.2, 6.8),
    offsetGeo(7.5, 2.2),
    offsetGeo(6.4, -3.5),
    offsetGeo(1.0, -4.4),
    offsetGeo(-4.2, -3.2),
    offsetGeo(-7.4, 0.8),
  ];
  const nnLeninskyKanavino: GeoPoint[] = [
    offsetGeo(-4.5, 13.8),
    offsetGeo(1.5, 15.8),
    offsetGeo(7.5, 15.6),
    offsetGeo(11.4, 11.4),
    offsetGeo(9.4, 6.2),
    offsetGeo(4.2, 5.4),
    offsetGeo(-1.2, 6.8),
    offsetGeo(-5.2, 9.6),
  ];
  const nnSormovoMoskovsky: GeoPoint[] = [
    offsetGeo(-13.5, 22.8),
    offsetGeo(-7.0, 26.2),
    offsetGeo(0.5, 25.0),
    offsetGeo(7.6, 19.2),
    offsetGeo(5.2, 13.5),
    offsetGeo(-2.4, 12.2),
    offsetGeo(-9.5, 14.2),
    offsetGeo(-14.2, 17.5),
  ];
  const nnNagornayaCenter: GeoPoint[] = [
    offsetGeo(10.0, 14.5),
    offsetGeo(16.2, 14.6),
    offsetGeo(22.4, 12.6),
    offsetGeo(26.2, 7.6),
    offsetGeo(24.0, 1.5),
    offsetGeo(18.5, -1.8),
    offsetGeo(12.2, -1.2),
    offsetGeo(9.4, 4.2),
    offsetGeo(8.8, 9.5),
  ];
  const nnPriokskyShcherbinki: GeoPoint[] = [
    offsetGeo(10.2, 2.4),
    offsetGeo(17.4, 0.8),
    offsetGeo(19.6, -5.8),
    offsetGeo(15.2, -9.2),
    offsetGeo(10.4, -8.5),
    offsetGeo(7.4, -4.0),
  ];
  const borUrban: GeoPoint[] = [
    offsetGeo(12.5, 25.4),
    offsetGeo(19.8, 25.8),
    offsetGeo(24.4, 21.8),
    offsetGeo(23.8, 17.6),
    offsetGeo(16.0, 16.8),
    offsetGeo(11.0, 20.4),
  ];
  const dzrUrban: GeoPoint[] = [
    offsetGeo(-39.5, 10.2),
    offsetGeo(-31.0, 11.8),
    offsetGeo(-24.2, 9.6),
    offsetGeo(-20.8, 4.8),
    offsetGeo(-23.5, -1.8),
    offsetGeo(-31.5, -3.6),
    offsetGeo(-39.8, -1.5),
    offsetGeo(-42.5, 3.8),
  ];
  const kstovoUrban: GeoPoint[] = [
    offsetGeo(27.8, 1.4),
    offsetGeo(35.5, 1.2),
    offsetGeo(39.4, -2.5),
    offsetGeo(38.2, -6.8),
    offsetGeo(30.4, -7.2),
    offsetGeo(26.8, -3.2),
  ];
  const balakhnaUrban: GeoPoint[] = [
    offsetGeo(-23.2, 34.8),
    offsetGeo(-16.2, 36.2),
    offsetGeo(-11.4, 31.4),
    offsetGeo(-12.2, 26.8),
    offsetGeo(-18.6, 25.8),
    offsetGeo(-22.8, 29.5),
  ];
  const bogorodskUrban: GeoPoint[] = [
    offsetGeo(-26.5, -17.5),
    offsetGeo(-20.0, -16.8),
    offsetGeo(-18.2, -22.2),
    offsetGeo(-23.8, -24.2),
    offsetGeo(-28.0, -21.2),
  ];
  const zavolzhyeUrban: GeoPoint[] = [
    offsetGeo(-36.5, 51.0),
    offsetGeo(-29.0, 52.5),
    offsetGeo(-26.5, 46.5),
    offsetGeo(-33.5, 44.5),
  ];

  // Authentic Nizhny Novgorod multi-tier highway, boulevard, bridge & urban arterial skeleton
  const demoRoads: Array<{ id: string; kind: 'ROAD'; points: GeoPoint[]; weight: number }> = [
    // --- Motorways & Federal Trunks (weight 0.92..1.0) ---
    {
      id: 'road-m7-west-east',
      kind: 'ROAD',
      weight: 1.0,
      points: [
        offsetGeo(-122, 19),
        offsetGeo(-78, 14),
        offsetGeo(-48, 10),
        offsetGeo(-31, 7),
        offsetGeo(-18, 7),
        offsetGeo(-6, 9),
        offsetGeo(4, 12),
        offsetGeo(11, 13),
        offsetGeo(18, 9),
        offsetGeo(26, 3),
        offsetGeo(34, -2),
        offsetGeo(62, -10),
        offsetGeo(108, -19),
      ],
    },
    {
      id: 'road-southern-bypass',
      kind: 'ROAD',
      weight: 0.96,
      points: [
        offsetGeo(-34, 6),
        offsetGeo(-20, -2),
        offsetGeo(-8, -6),
        offsetGeo(2, -7),
        offsetGeo(13, -10),
        offsetGeo(24, -8),
        offsetGeo(35, -4),
        offsetGeo(46, -6),
      ],
    },
    {
      id: 'road-gagarina-arzamas',
      kind: 'ROAD',
      weight: 0.94,
      points: [
        offsetGeo(12, 13),
        offsetGeo(13, 8),
        offsetGeo(13.5, 2),
        offsetGeo(13.2, -4),
        offsetGeo(12.2, -10),
        offsetGeo(10.5, -22),
        offsetGeo(8.0, -52),
        offsetGeo(4.5, -94),
      ],
    },
    {
      id: 'road-volga-bor-kirov',
      kind: 'ROAD',
      weight: 0.94,
      points: [
        offsetGeo(8.5, 13.5),
        offsetGeo(13.5, 18.2),
        offsetGeo(18.0, 21.8),
        offsetGeo(23.5, 29.0),
        offsetGeo(34.0, 44.0),
        offsetGeo(58.0, 72.0),
      ],
    },
    {
      id: 'road-sormovo-balakhna',
      kind: 'ROAD',
      weight: 0.9,
      points: [
        offsetGeo(7.5, 12.8),
        offsetGeo(2.0, 16.0),
        offsetGeo(-4.5, 20.5),
        offsetGeo(-11.0, 26.2),
        offsetGeo(-17.5, 31.8),
        offsetGeo(-25.5, 42.0),
        offsetGeo(-32.0, 48.5),
        offsetGeo(-48.0, 68.0),
      ],
    },
    {
      id: 'road-oka-murom',
      kind: 'ROAD',
      weight: 0.86,
      points: [
        offsetGeo(2.5, 1.5),
        offsetGeo(-5.5, -5.5),
        offsetGeo(-15.5, -14.2),
        offsetGeo(-23.0, -20.0),
        offsetGeo(-36.0, -35.0),
        offsetGeo(-72.0, -60.0),
      ],
    },
    // --- Primary City Boulevards & River Bridges (weight 0.78..0.90) ---
    {
      id: 'road-prospekt-lenina-avto',
      kind: 'ROAD',
      weight: 0.9,
      points: [
        offsetGeo(-5.5, -2.5),
        offsetGeo(-1.5, 0.8),
        offsetGeo(2.2, 4.2),
        offsetGeo(5.8, 8.2),
        offsetGeo(8.6, 12.2),
        offsetGeo(11.4, 13.2),
      ],
    },
    {
      id: 'road-nagornaya-kazan-shosse',
      kind: 'ROAD',
      weight: 0.88,
      points: [
        offsetGeo(11.5, 13.0),
        offsetGeo(16.8, 12.5),
        offsetGeo(22.2, 9.2),
        offsetGeo(26.0, 5.2),
        offsetGeo(30.5, 0.2),
        offsetGeo(34.5, -3.2),
      ],
    },
    {
      id: 'road-myzinsky-bridge-cross',
      kind: 'ROAD',
      weight: 0.86,
      points: [
        offsetGeo(-6.2, 2.2),
        offsetGeo(0.2, 2.2),
        offsetGeo(6.8, 2.2),
        offsetGeo(13.5, 2.2),
        offsetGeo(19.5, 3.0),
        offsetGeo(24.5, 4.5),
      ],
    },
    {
      id: 'road-metro-bridge-center',
      kind: 'ROAD',
      weight: 0.88,
      points: [
        offsetGeo(-1.0, 12.2),
        offsetGeo(4.8, 10.6),
        offsetGeo(10.5, 9.5),
        offsetGeo(16.5, 8.8),
        offsetGeo(22.8, 8.2),
      ],
    },
    {
      id: 'road-molitovsky-bridge',
      kind: 'ROAD',
      weight: 0.82,
      points: [
        offsetGeo(-2.5, 6.2),
        offsetGeo(3.2, 6.0),
        offsetGeo(9.2, 5.8),
        offsetGeo(14.5, 5.6),
        offsetGeo(20.5, 6.4),
      ],
    },
    {
      id: 'road-kanavinsky-bridge-pokrovka',
      kind: 'ROAD',
      weight: 0.88,
      points: [
        offsetGeo(5.5, 14.2),
        offsetGeo(9.5, 13.2),
        offsetGeo(13.0, 11.8),
        offsetGeo(17.5, 10.4),
        offsetGeo(22.8, 10.8),
      ],
    },
    {
      id: 'road-avto-molodezhny-airport',
      kind: 'ROAD',
      weight: 0.82,
      points: [
        offsetGeo(-6.2, 0.4),
        offsetGeo(-2.2, 0.4),
        offsetGeo(1.2, 0.6),
        offsetGeo(4.8, 1.6),
        offsetGeo(6.5, 3.8),
      ],
    },
    {
      id: 'road-nagornaya-belinskogo-vaneeva',
      kind: 'ROAD',
      weight: 0.82,
      points: [
        offsetGeo(11.8, 12.4),
        offsetGeo(14.2, 9.8),
        offsetGeo(17.8, 6.5),
        offsetGeo(21.4, 2.2),
        offsetGeo(17.2, -1.6),
      ],
    },
    // --- Secondary Urban Avenues & Sub-District Arterials (weight 0.56..0.74) ---
    {
      id: 'road-sormovo-cross-ring',
      kind: 'ROAD',
      weight: 0.72,
      points: [
        offsetGeo(-12.5, 18.0),
        offsetGeo(-6.8, 16.5),
        offsetGeo(-1.0, 15.2),
        offsetGeo(4.5, 14.0),
        offsetGeo(8.2, 11.8),
      ],
    },
    {
      id: 'road-sormovo-north-arc',
      kind: 'ROAD',
      weight: 0.66,
      points: [
        offsetGeo(-11.8, 22.0),
        offsetGeo(-6.5, 23.6),
        offsetGeo(-0.5, 22.4),
        offsetGeo(5.2, 18.6),
      ],
    },
    {
      id: 'road-moskovsky-north-south',
      kind: 'ROAD',
      weight: 0.68,
      points: [
        offsetGeo(-4.2, 24.0),
        offsetGeo(-2.5, 18.0),
        offsetGeo(-1.0, 12.2),
        offsetGeo(0.4, 6.8),
        offsetGeo(1.8, 1.0),
      ],
    },
    {
      id: 'road-avto-west-loop',
      kind: 'ROAD',
      weight: 0.65,
      points: [
        offsetGeo(-5.5, 5.0),
        offsetGeo(-4.8, 1.5),
        offsetGeo(-3.2, -2.5),
        offsetGeo(2.0, -3.2),
        offsetGeo(5.8, -1.2),
      ],
    },
    {
      id: 'road-nagornaya-kuznetschikha',
      kind: 'ROAD',
      weight: 0.68,
      points: [
        offsetGeo(13.2, 6.5),
        offsetGeo(17.5, 4.4),
        offsetGeo(22.2, 5.2),
        offsetGeo(24.5, 8.8),
        offsetGeo(19.5, 12.2),
      ],
    },
    {
      id: 'road-prioksky-inner',
      kind: 'ROAD',
      weight: 0.62,
      points: [
        offsetGeo(9.2, -2.2),
        offsetGeo(13.2, -2.6),
        offsetGeo(17.5, -3.8),
        offsetGeo(15.6, -7.8),
        offsetGeo(11.4, -7.2),
      ],
    },
    {
      id: 'road-bor-main',
      kind: 'ROAD',
      weight: 0.72,
      points: [
        offsetGeo(12.2, 21.2),
        offsetGeo(16.8, 21.4),
        offsetGeo(22.4, 20.6),
        offsetGeo(21.2, 24.4),
        offsetGeo(15.0, 24.2),
      ],
    },
    {
      id: 'road-dzerzhinsk-boulevard',
      kind: 'ROAD',
      weight: 0.8,
      points: [
        offsetGeo(-41.0, 5.2),
        offsetGeo(-34.5, 4.4),
        offsetGeo(-28.0, 4.2),
        offsetGeo(-22.2, 5.6),
      ],
    },
    {
      id: 'road-dzerzhinsk-north-ave',
      kind: 'ROAD',
      weight: 0.66,
      points: [
        offsetGeo(-38.5, 8.8),
        offsetGeo(-32.0, 8.6),
        offsetGeo(-25.8, 7.6),
      ],
    },
    {
      id: 'road-dzerzhinsk-cross',
      kind: 'ROAD',
      weight: 0.74,
      points: [
        offsetGeo(-32.2, 10.6),
        offsetGeo(-31.2, 4.4),
        offsetGeo(-30.0, -2.4),
      ],
    },
    {
      id: 'road-dzerzhinsk-west-cross',
      kind: 'ROAD',
      weight: 0.6,
      points: [
        offsetGeo(-36.5, 9.2),
        offsetGeo(-35.8, 4.2),
        offsetGeo(-34.5, -1.8),
      ],
    },
    {
      id: 'road-kstovo-arterial',
      kind: 'ROAD',
      weight: 0.72,
      points: [
        offsetGeo(28.5, -1.0),
        offsetGeo(33.5, -2.5),
        offsetGeo(37.8, -4.6),
      ],
    },
    {
      id: 'road-kstovo-cross',
      kind: 'ROAD',
      weight: 0.6,
      points: [
        offsetGeo(31.8, 0.5),
        offsetGeo(33.2, -3.0),
        offsetGeo(34.2, -6.2),
      ],
    },
    {
      id: 'road-balakhna-inner',
      kind: 'ROAD',
      weight: 0.62,
      points: [
        offsetGeo(-21.5, 32.8),
        offsetGeo(-17.2, 31.4),
        offsetGeo(-13.2, 29.4),
      ],
    },
    {
      id: 'road-bogorodsk-inner',
      kind: 'ROAD',
      weight: 0.6,
      points: [
        offsetGeo(-26.2, -19.8),
        offsetGeo(-22.5, -20.2),
        offsetGeo(-19.2, -20.8),
      ],
    },
  ];

  return {
    name: 'Volga–Oka Basin · Nizhny Novgorod',
    waterBase: false,
    polygons: [
      { id: 'urban-nn-avto', kind: 'URBAN', points: nnAvtozavod },
      { id: 'urban-nn-kan', kind: 'URBAN', points: nnLeninskyKanavino },
      { id: 'urban-nn-sorm', kind: 'URBAN', points: nnSormovoMoskovsky },
      { id: 'urban-nn-nagor', kind: 'URBAN', points: nnNagornayaCenter },
      { id: 'urban-nn-priok', kind: 'URBAN', points: nnPriokskyShcherbinki },
      { id: 'urban-bor', kind: 'URBAN', points: borUrban },
      { id: 'urban-dzr', kind: 'URBAN', points: dzrUrban },
      { id: 'urban-kstovo', kind: 'URBAN', points: kstovoUrban },
      { id: 'urban-balakhna', kind: 'URBAN', points: balakhnaUrban },
      { id: 'urban-bogorodsk', kind: 'URBAN', points: bogorodskUrban },
      { id: 'urban-zavolzhye', kind: 'URBAN', points: zavolzhyeUrban },
      { id: 'volga-gorky', kind: 'WATER', points: gorkyReservoir },
      { id: 'oka-river', kind: 'WATER', points: okaRiver },
      { id: 'cheboksary', kind: 'WATER', points: cheboksaryWater },
    ],
    polylines: demoRoads,
    labels: [
      { id: 'lbl-nn', text: 'NIZHNY NOVGOROD', position: offsetGeo(15, 11), kind: 'CITY', placeTier: 'major', rank: 2 },
      { id: 'lbl-dzr', text: 'DZERZHINSK', position: offsetGeo(-31, 4.5), kind: 'CITY', placeTier: 'major', rank: 4 },
      { id: 'lbl-kstovo', text: 'KSTOVO', position: offsetGeo(33, -3), kind: 'CITY', placeTier: 'minor', rank: 8 },
      { id: 'lbl-bor', text: 'BOR', position: offsetGeo(18, 22), kind: 'CITY', placeTier: 'minor', rank: 8 },
      { id: 'lbl-balakhna', text: 'BALAKHNA', position: offsetGeo(-17, 31), kind: 'CITY', placeTier: 'minor', rank: 8 },
      { id: 'lbl-bogorodsk', text: 'BOGORODSK', position: offsetGeo(-23, -20), kind: 'CITY', placeTier: 'minor', rank: 8 },
      { id: 'lbl-gorky', text: 'GORKY RESERVOIR', position: offsetGeo(-58, 92), kind: 'WATER' },
      { id: 'lbl-volga', text: 'VOLGA RIVER', position: offsetGeo(98, 4), kind: 'WATER' },
      { id: 'lbl-oka', text: 'OKA RIVER', position: offsetGeo(-72, -34), kind: 'WATER' },
      { id: 'lbl-arz', text: 'ARZAMAS', position: offsetGeo(4.5, -94), kind: 'CITY', placeTier: 'minor', rank: 7 },
    ],
  };
}

/**
 * Authentic UWGG airspace geometry modeled on EuroScope Moscow FIR with real ATC sector
 * frequencies (`UWGG TWR • 118.300`, `UWGG APP • 119.300`, `UWGG RADAR • 120.300`, `UUWV CTR • 127.500`),
 * runways, extended approach axes, and built-in dark geographic map.
 */
export function buildUwggAirspaceDataset(): AirspaceDataset {
  const wpCoords: Record<string, GeoPoint> = {
    UWGG: UWGG_CENTER,
    GG039: offsetGeo(3, 28),
    GG015: offsetGeo(14, 34),
    GG014: offsetGeo(22, 12),
    USTOK: offsetGeo(-37, -14),
    LARNO: offsetGeo(-42, -55),
    OTKOL: offsetGeo(-2, -80),
    OKSUD: offsetGeo(70, -83),
    PESAB: offsetGeo(80, -30),
    GILAM: offsetGeo(74, 59),
    NAMER: offsetGeo(176, -24),
    IRGOS: offsetGeo(173, -55),
    KOSUL: offsetGeo(171, -90),
    EKSEP: offsetGeo(183, 44),
    BABOK: offsetGeo(186, 65),
    RUDIK: offsetGeo(-82, 68),
    BELAG: offsetGeo(-130, -48),
  };

  const waypoints = Object.entries(wpCoords).map(([id, pt]) => ({
    id,
    lat: pt.lat,
    lon: pt.lon,
    kind: (id === 'UWGG' ? 'AIRPORT' : 'FIX') as 'FIX' | 'VOR' | 'NDB' | 'AIRPORT',
  }));

  const ctrPoly: GeoPoint[] = [
    offsetGeo(-12, 22),
    offsetGeo(-5, 28),
    offsetGeo(14, 27),
    offsetGeo(25, 19),
    offsetGeo(29, 0),
    offsetGeo(26, -15),
    offsetGeo(8, -28),
    offsetGeo(-15, -20),
    offsetGeo(-10, -4),
    offsetGeo(-13, 12),
  ];

  const tmaPoly: GeoPoint[] = [
    offsetGeo(-31, 31),
    offsetGeo(-6, 55),
    offsetGeo(26, 54),
    offsetGeo(43, 35),
    offsetGeo(52, 8),
    offsetGeo(51, -18),
    offsetGeo(37, -41),
    offsetGeo(13, -54),
    offsetGeo(-16, -55),
    offsetGeo(-39, -39),
    offsetGeo(-36, -14),
    offsetGeo(-21, -5),
    offsetGeo(-31, 14),
  ];

  const appPoly: GeoPoint[] = [
    wpCoords.USTOK,
    offsetGeo(-32, 34),
    wpCoords.GILAM,
    wpCoords.PESAB,
    wpCoords.OKSUD,
    wpCoords.OTKOL,
    wpCoords.LARNO,
  ];

  const firWestPoly: GeoPoint[] = [
    offsetGeo(-175, 110),
    offsetGeo(-82, 68),
    offsetGeo(-32, 34),
    wpCoords.USTOK,
    wpCoords.LARNO,
    offsetGeo(-175, -55),
  ];

  const firEastPoly: GeoPoint[] = [
    wpCoords.GILAM,
    offsetGeo(180, 105),
    offsetGeo(185, -105),
    wpCoords.OKSUD,
    wpCoords.PESAB,
  ];

  const restrictedEast: GeoPoint[] = [
    offsetGeo(62, 46),
    offsetGeo(76, 54),
    offsetGeo(84, 52),
    offsetGeo(96, 30),
    offsetGeo(72, 23),
  ];

  const restrictedSouthWest: GeoPoint[] = [
    offsetGeo(-155, -72),
    offsetGeo(-94, -77),
    offsetGeo(-83, -40),
    offsetGeo(-60, -68),
    offsetGeo(-105, -118),
    offsetGeo(-155, -112),
  ];

  const restrictedSouth: GeoPoint[] = [
    offsetGeo(-94, -77),
    offsetGeo(28, -115),
    offsetGeo(16, -135),
    offsetGeo(-105, -118),
  ];

  const restrictedSmallWest: GeoPoint[] = [
    offsetGeo(-28, 10),
    offsetGeo(-22, 11),
    offsetGeo(-21, 7),
    offsetGeo(-29, 7),
  ];

  const restrictedCircles = [
    { id: 'URD-1', name: 'URD112', center: offsetGeo(-26, 61), radiusKm: 5.5, floorFt: 0, ceilingFt: 7000 },
    { id: 'URD-2', name: 'URR401', center: offsetGeo(23, -15), radiusKm: 4.5, floorFt: 0, ceilingFt: 4500 },
    { id: 'URD-3', name: 'URR402', center: offsetGeo(76, -6), radiusKm: 4.0, floorFt: 0, ceilingFt: 6000 },
    { id: 'URD-4', name: 'URR405', center: offsetGeo(149, 27), radiusKm: 2.3, floorFt: 0, ceilingFt: 5000 },
    { id: 'URD-5', name: 'URD118', center: offsetGeo(5, -67), radiusKm: 1.8, floorFt: 0, ceilingFt: 3500 },
    { id: 'URD-6', name: 'URD121', center: offsetGeo(133, -24), radiusKm: 1.7, floorFt: 0, ceilingFt: 4000 },
  ];

  const airwayPairs: [string, GeoPoint, GeoPoint][] = [
    ['A300', wpCoords.RUDIK, wpCoords.BABOK],
    ['G356', wpCoords.RUDIK, wpCoords.GILAM],
    ['R480', wpCoords.GILAM, wpCoords.EKSEP],
    ['T512', wpCoords.USTOK, wpCoords.NAMER],
    ['L165', wpCoords.USTOK, wpCoords.IRGOS],
    ['M864', wpCoords.LARNO, wpCoords.OKSUD],
    ['N743', wpCoords.OKSUD, wpCoords.KOSUL],
    ['B210', wpCoords.OTKOL, wpCoords.PESAB],
    ['W140', wpCoords.PESAB, wpCoords.EKSEP],
    ['P982', wpCoords.PESAB, wpCoords.NAMER],
    ['G476', wpCoords.OKSUD, wpCoords.PESAB],
    ['M987', wpCoords.LARNO, wpCoords.BELAG],
    ['A822', wpCoords.OTKOL, wpCoords.OKSUD],
    ['R369', wpCoords.RUDIK, wpCoords.USTOK],
    ['L742', wpCoords.BELAG, wpCoords.OTKOL],
    ['B902', wpCoords.PESAB, wpCoords.KOSUL],
    ['N866', wpCoords.GILAM, offsetGeo(166, 108)],
  ];

  const sidStarLines: {
    name: string;
    procedureType: 'SID' | 'STAR';
    runway: string;
    points: GeoPoint[];
  }[] = [
    {
      name: 'LARNO2U',
      procedureType: 'SID',
      runway: '18R',
      points: [UWGG_CENTER, wpCoords.GG039, wpCoords.USTOK, wpCoords.LARNO],
    },
    {
      name: 'GILAM2E',
      procedureType: 'SID',
      runway: '18R',
      points: [UWGG_CENTER, wpCoords.GG015, wpCoords.GILAM],
    },
    {
      name: 'PESAB2E',
      procedureType: 'SID',
      runway: '36L',
      points: [UWGG_CENTER, wpCoords.GG014, wpCoords.PESAB],
    },
    {
      name: 'OKSUD1A',
      procedureType: 'STAR',
      runway: '18R',
      points: [wpCoords.OKSUD, wpCoords.GG014, wpCoords.GG015, wpCoords.GG039, UWGG_CENTER],
    },
    {
      name: 'GILAM1A',
      procedureType: 'STAR',
      runway: '36L',
      points: [wpCoords.GILAM, wpCoords.GG014, wpCoords.USTOK, UWGG_CENTER],
    },
  ];

  // Parallel runways 18R/36L and 18L/36R + extended approach centerlines
  const runwayAndAxes: { name: string; kind: 'RUNWAY' | 'APPROACH_AXIS'; points: GeoPoint[] }[] = [
    { name: 'RWY 18R/36L', kind: 'RUNWAY', points: [offsetGeo(-0.6, 2.4), offsetGeo(0.2, -2.4)] },
    { name: 'RWY 18L/36R', kind: 'RUNWAY', points: [offsetGeo(0.6, 2.2), offsetGeo(1.3, -2.2)] },
    {
      name: 'ILS 18R',
      kind: 'APPROACH_AXIS',
      points: [offsetGeo(-0.6, 2.4), offsetGeo(-3.4, 24)],
    },
    {
      name: 'ILS 36L',
      kind: 'APPROACH_AXIS',
      points: [offsetGeo(0.2, -2.4), offsetGeo(3.0, -24)],
    },
  ];

  return {
    name: 'UWGG · NIZHNY NOVGOROD',
    regionSubtitle: 'Moscow FIR Terminal Airspace',
    center: UWGG_CENTER,
    airportCode: 'UWGG',
    airportElevationFt: 256,
    runwayProcedures: [
      { runway: '18R', hasSid: true, hasStar: true },
      { runway: '36L', hasSid: true, hasStar: true },
    ],
    volumes: [
      {
        id: 'uwgg-ctr',
        name: 'UWGG_TWR',
        shortCode: 'TWR',
        frequency: '118.300',
        kind: 'CTR',
        floorFt: 0,
        ceilingFt: 5000,
        polygon: ctrPoly,
      },
      {
        id: 'uwgg-radar',
        name: 'UWGG_R_APP',
        shortCode: 'RADAR',
        frequency: '119.300',
        kind: 'TMA',
        floorFt: 1500,
        ceilingFt: 11000,
        polygon: tmaPoly,
      },
      {
        id: 'uwgg-app',
        name: 'UWGG_APP',
        shortCode: 'APP',
        frequency: '120.300',
        kind: 'APP',
        floorFt: 5000,
        ceilingFt: 26500,
        polygon: appPoly,
      },
      {
        id: 'fir-west',
        name: 'UUWV_X_CTR',
        shortCode: 'CTR',
        frequency: '127.500',
        kind: 'FIR',
        floorFt: 11000,
        ceilingFt: 33000,
        polygon: firWestPoly,
      },
      {
        id: 'fir-east',
        name: 'UWWW_CTR',
        shortCode: 'CTR',
        frequency: '132.400',
        kind: 'FIR',
        floorFt: 11000,
        ceilingFt: 33000,
        polygon: firEastPoly,
      },
    ],
    waypoints,
    airways: [
      ...airwayPairs.map(([name, a, b], idx) => ({
        id: `aw-${idx}`,
        name,
        kind: 'AIRWAY' as const,
        points: [a, b],
      })),
      ...sidStarLines.map((proc, idx) => ({
        id: `proc-${idx}`,
        name: proc.name,
        kind: 'SID_STAR' as const,
        procedureType: proc.procedureType,
        runway: proc.runway,
        points: proc.points,
      })),
      ...runwayAndAxes.map((r, idx) => ({
        id: `rwy-${idx}`,
        name: r.name,
        kind: r.kind,
        points: r.points,
      })),
    ],
    restrictedZones: [
      {
        id: 'urr-east',
        name: 'URR-214',
        kind: 'RESTRICTED',
        floorFt: 0,
        ceilingFt: 12000,
        polygon: restrictedEast,
      },
      {
        id: 'urr-sw',
        name: 'URP-088',
        kind: 'RESTRICTED',
        floorFt: 0,
        ceilingFt: 18000,
        polygon: restrictedSouthWest,
      },
      {
        id: 'urr-south',
        name: 'URD-095',
        kind: 'RESTRICTED',
        floorFt: 0,
        ceilingFt: 9500,
        polygon: restrictedSouth,
      },
      {
        id: 'urr-west-small',
        name: 'URR-109',
        kind: 'RESTRICTED',
        floorFt: 0,
        ceilingFt: 4000,
        polygon: restrictedSmallWest,
      },
    ],
    restrictedCircles,
    baseMap: buildUwggBaseMap(),
  };
}

interface DemoRouteNode {
  timeOffsetSec: number;
  eastKm: number;
  northKm: number;
  altFt: number;
  gsKt: number;
}

function generateSamplesFromNodes(
  baseTimeSec: number,
  nodes: DemoRouteNode[],
  squawk: string,
  sweepIntervalSec = 3,
): RadarSample[] {
  const samples: RadarSample[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const segDur = b.timeOffsetSec - a.timeOffsetSec;
    const steps = Math.max(1, Math.round(segDur / sweepIntervalSec));
    for (let s = 0; s < steps; s++) {
      if (i > 0 && s === 0) continue;
      const u = s / steps;
      const east = a.eastKm + (b.eastKm - a.eastKm) * u;
      const north = a.northKm + (b.northKm - a.northKm) * u;
      const altFt = a.altFt + (b.altFt - a.altFt) * u;
      const gsKt = a.gsKt + (b.gsKt - a.gsKt) * u;
      const geo = offsetGeo(east, north);
      const hdg = LocalENUProjector.headingFromDeltaXZ(b.eastKm - a.eastKm, -(b.northKm - a.northKm));
      samples.push({
        timeSec: baseTimeSec + a.timeOffsetSec + segDur * u,
        lat: geo.lat,
        lon: geo.lon,
        altFt,
        gsKt,
        headingDeg: hdg,
        squawk,
        hasExplicitHeading: true,
      });
    }
  }
  const last = nodes[nodes.length - 1];
  const prev = nodes[nodes.length - 2];
  const lastGeo = offsetGeo(last.eastKm, last.northKm);
  samples.push({
    timeSec: baseTimeSec + last.timeOffsetSec,
    lat: lastGeo.lat,
    lon: lastGeo.lon,
    altFt: last.altFt,
    gsKt: last.gsKt,
    headingDeg: LocalENUProjector.headingFromDeltaXZ(
      last.eastKm - prev.eastKm,
      -(last.northKm - prev.northKm),
    ),
    squawk,
    hasExplicitHeading: true,
  });
  return samples;
}

export function buildUwggDemoRadarDataset(): RadarDataset {
  const baseTime = 16 * 3600 + 40; // 16:00:40 UTC matching user's FSD log

  const specs: {
    callsign: string;
    squawk: string;
    aircraftType: string;
    origin: string;
    destination: string;
    cruiseAltFt: number;
    clearedFl: number;
    sidOrStar: string;
    route: string;
    nodes: DemoRouteNode[];
  }[] = [
    {
      callsign: 'AUL510',
      squawk: '4215',
      aircraftType: 'B738/M',
      origin: 'UWGG',
      destination: 'ULLI',
      cruiseAltFt: 36000,
      clearedFl: 90,
      sidOrStar: 'LARNO2U',
      route: 'LARNO2U LARNO M864',
      nodes: [
        { timeOffsetSec: 0, eastKm: 3, northKm: 27, altFt: 2800, gsKt: 210 },
        { timeOffsetSec: 95, eastKm: 0, northKm: 12, altFt: 4800, gsKt: 265 },
        { timeOffsetSec: 180, eastKm: -1.5, northKm: -1, altFt: 6600, gsKt: 315 },
        { timeOffsetSec: 320, eastKm: -12, northKm: -22, altFt: 11200, gsKt: 365 },
        { timeOffsetSec: 500, eastKm: -37, northKm: -46, altFt: 19400, gsKt: 418 },
        { timeOffsetSec: 720, eastKm: -76, northKm: -62, altFt: 28600, gsKt: 437 },
        { timeOffsetSec: 1020, eastKm: -135, northKm: -74, altFt: 36000, gsKt: 448 },
      ],
    },
    {
      callsign: 'AFL1019',
      squawk: '3104',
      aircraftType: 'A320/M',
      origin: 'UUEE',
      destination: 'UWGG',
      cruiseAltFt: 29000,
      clearedFl: 50,
      sidOrStar: 'USTOK1A',
      route: 'USTOK GG014 GG039 UWGG',
      nodes: [
        { timeOffsetSec: 0, eastKm: -118, northKm: -24, altFt: 24000, gsKt: 415 },
        { timeOffsetSec: 260, eastKm: -68, northKm: -18, altFt: 16200, gsKt: 355 },
        { timeOffsetSec: 480, eastKm: -37, northKm: -14, altFt: 10800, gsKt: 290 },
        { timeOffsetSec: 720, eastKm: 18, northKm: 10, altFt: 6200, gsKt: 235 },
        { timeOffsetSec: 900, eastKm: 14, northKm: 32, altFt: 3600, gsKt: 195 },
        { timeOffsetSec: 1040, eastKm: 2, northKm: 26, altFt: 2400, gsKt: 170 },
        { timeOffsetSec: 1220, eastKm: -0.4, northKm: 1.5, altFt: 400, gsKt: 138 },
      ],
    },
    {
      callsign: 'SBI730',
      squawk: '5421',
      aircraftType: 'A321/M',
      origin: 'UNNT',
      destination: 'UWGG',
      cruiseAltFt: 34000,
      clearedFl: 70,
      sidOrStar: 'PESAB1A',
      route: 'PESAB GG014 GG015 UWGG',
      nodes: [
        { timeOffsetSec: 40, eastKm: 148, northKm: -28, altFt: 29500, gsKt: 430 },
        { timeOffsetSec: 340, eastKm: 80, northKm: -30, altFt: 18000, gsKt: 360 },
        { timeOffsetSec: 620, eastKm: 32, northKm: 6, altFt: 9400, gsKt: 275 },
        { timeOffsetSec: 840, eastKm: 22, northKm: 34, altFt: 5200, gsKt: 220 },
        { timeOffsetSec: 1040, eastKm: 3, northKm: 34, altFt: 3100, gsKt: 180 },
        { timeOffsetSec: 1260, eastKm: -0.2, northKm: 2, altFt: 450, gsKt: 142 },
      ],
    },
    {
      callsign: 'SDM6418',
      squawk: '2641',
      aircraftType: 'SU95/M',
      origin: 'UWGG',
      destination: 'USSS',
      cruiseAltFt: 33000,
      clearedFl: 110,
      sidOrStar: 'GILAM2E',
      route: 'GILAM2E GILAM R480 EKSEP',
      nodes: [
        { timeOffsetSec: 120, eastKm: 0.4, northKm: -2, altFt: 850, gsKt: 165 },
        { timeOffsetSec: 260, eastKm: 8, northKm: -12, altFt: 4900, gsKt: 255 },
        { timeOffsetSec: 430, eastKm: 24, northKm: 14, altFt: 11200, gsKt: 330 },
        { timeOffsetSec: 660, eastKm: 54, northKm: 42, altFt: 21500, gsKt: 395 },
        { timeOffsetSec: 880, eastKm: 88, northKm: 62, altFt: 30400, gsKt: 435 },
        { timeOffsetSec: 1200, eastKm: 168, northKm: 52, altFt: 33000, gsKt: 446 },
      ],
    },
    {
      callsign: 'AFL007',
      squawk: '6132',
      aircraftType: 'B77W/H',
      origin: 'UUEE',
      destination: 'UHWW',
      cruiseAltFt: 35000,
      clearedFl: 350,
      sidOrStar: 'G356',
      route: 'RUDIK G356 GILAM BABOK',
      nodes: [
        { timeOffsetSec: 0, eastKm: -125, northKm: 72, altFt: 35000, gsKt: 488 },
        { timeOffsetSec: 420, eastKm: -20, northKm: 66, altFt: 35000, gsKt: 492 },
        { timeOffsetSec: 840, eastKm: 74, northKm: 59, altFt: 35000, gsKt: 490 },
        { timeOffsetSec: 1280, eastKm: 184, northKm: 64, altFt: 35000, gsKt: 494 },
      ],
    },
    {
      callsign: 'PBD1911',
      squawk: '4408',
      aircraftType: 'B738/M',
      origin: 'UWGG',
      destination: 'URSS',
      cruiseAltFt: 36000,
      clearedFl: 150,
      sidOrStar: 'OKSUD2S',
      route: 'OKSUD2S OKSUD A822',
      nodes: [
        { timeOffsetSec: 320, eastKm: 0.2, northKm: -2, altFt: 900, gsKt: 170 },
        { timeOffsetSec: 460, eastKm: 6, northKm: -26, altFt: 7400, gsKt: 280 },
        { timeOffsetSec: 680, eastKm: 34, northKm: -58, altFt: 16800, gsKt: 372 },
        { timeOffsetSec: 940, eastKm: 72, northKm: -84, altFt: 28200, gsKt: 428 },
        { timeOffsetSec: 1260, eastKm: 132, northKm: -102, altFt: 36000, gsKt: 445 },
      ],
    },
    {
      callsign: 'AFL2182',
      squawk: '1754',
      aircraftType: 'A333/H',
      origin: 'UHHH',
      destination: 'UUEE',
      cruiseAltFt: 34000,
      clearedFl: 340,
      sidOrStar: 'T512',
      route: 'NAMER T512 PESAB USTOK',
      nodes: [
        { timeOffsetSec: 60, eastKm: 176, northKm: -24, altFt: 34000, gsKt: 462 },
        { timeOffsetSec: 460, eastKm: 80, northKm: -30, altFt: 34000, gsKt: 458 },
        { timeOffsetSec: 920, eastKm: -37, northKm: -14, altFt: 32000, gsKt: 442 },
        { timeOffsetSec: 1280, eastKm: -125, northKm: -36, altFt: 26500, gsKt: 410 },
      ],
    },
    {
      callsign: 'AFL7090',
      squawk: '3319',
      aircraftType: 'A320/M',
      origin: 'URMM',
      destination: 'UWGG',
      cruiseAltFt: 32000,
      clearedFl: 80,
      sidOrStar: 'OTKOL1A',
      route: 'OKSUD OTKOL GG014 UWGG',
      nodes: [
        { timeOffsetSec: 180, eastKm: 70, northKm: -88, altFt: 25500, gsKt: 420 },
        { timeOffsetSec: 440, eastKm: -2, northKm: -80, altFt: 16400, gsKt: 345 },
        { timeOffsetSec: 680, eastKm: -22, northKm: -35, altFt: 10200, gsKt: 280 },
        { timeOffsetSec: 880, eastKm: -22, northKm: 18, altFt: 5600, gsKt: 225 },
        { timeOffsetSec: 1080, eastKm: -3, northKm: 32, altFt: 3200, gsKt: 180 },
        { timeOffsetSec: 1280, eastKm: 0, northKm: 4, altFt: 1100, gsKt: 145 },
      ],
    },
    {
      callsign: 'SVR441',
      squawk: '5209',
      aircraftType: 'A20N/M',
      origin: 'ULLI',
      destination: 'UWWW',
      cruiseAltFt: 37000,
      clearedFl: 370,
      sidOrStar: 'N743',
      route: 'RUDIK OKSUD KOSUL',
      nodes: [
        { timeOffsetSec: 90, eastKm: -86, northKm: 74, altFt: 37000, gsKt: 476 },
        { timeOffsetSec: 520, eastKm: 12, northKm: -18, altFt: 37000, gsKt: 480 },
        { timeOffsetSec: 920, eastKm: 88, northKm: -85, altFt: 35000, gsKt: 468 },
        { timeOffsetSec: 1260, eastKm: 171, northKm: -90, altFt: 29500, gsKt: 440 },
      ],
    },
    {
      callsign: 'UTA512',
      squawk: '2147',
      aircraftType: 'AT76/M',
      origin: 'UWKD',
      destination: 'UWGG',
      cruiseAltFt: 18000,
      clearedFl: 60,
      sidOrStar: 'GILAM1A',
      route: 'EKSEP GILAM GG015 UWGG',
      nodes: [
        { timeOffsetSec: 0, eastKm: 146, northKm: 48, altFt: 18000, gsKt: 280 },
        { timeOffsetSec: 360, eastKm: 74, northKm: 59, altFt: 14000, gsKt: 265 },
        { timeOffsetSec: 660, eastKm: 28, northKm: 40, altFt: 8200, gsKt: 225 },
        { timeOffsetSec: 880, eastKm: 10, northKm: 32, altFt: 4200, gsKt: 185 },
        { timeOffsetSec: 1120, eastKm: 0.4, northKm: 2, altFt: 550, gsKt: 128 },
      ],
    },
  ];

  // Authentic Moscow FIR / Nizhny Novgorod handoff chain:
  // Departures: UWGG_TWR (Вышка) -> UWGG_R_APP (Нижний круг) -> UWGG_APP (Нижний подход) -> UUWV_X_CTR / UUWV_CTR (Москва контроль)
  // Arrivals:   UUWV_CTR / UWWW_CTR -> UWGG_APP -> UWGG_R_APP -> UWGG_TWR
  const demoHandoffs: Record<string, { timeOffsetSec: number; controller: string }[]> = {
    AUL510: [
      { timeOffsetSec: 0, controller: 'UWGG_TWR' },
      { timeOffsetSec: 120, controller: 'UWGG_R_APP' },
      { timeOffsetSec: 360, controller: 'UWGG_APP' },
      { timeOffsetSec: 640, controller: 'UUWV_X_CTR' },
    ],
    AFL1019: [
      { timeOffsetSec: 0, controller: 'UUWV_CTR' },
      { timeOffsetSec: 310, controller: 'UWGG_APP' },
      { timeOffsetSec: 690, controller: 'UWGG_R_APP' },
      { timeOffsetSec: 980, controller: 'UWGG_TWR' },
    ],
    SBI730: [
      { timeOffsetSec: 40, controller: 'UWWW_CTR' },
      { timeOffsetSec: 380, controller: 'UWGG_APP' },
      { timeOffsetSec: 720, controller: 'UWGG_R_APP' },
      { timeOffsetSec: 1020, controller: 'UWGG_TWR' },
    ],
    SDM6418: [
      { timeOffsetSec: 120, controller: 'UWGG_TWR' },
      { timeOffsetSec: 250, controller: 'UWGG_R_APP' },
      { timeOffsetSec: 460, controller: 'UWGG_APP' },
      { timeOffsetSec: 740, controller: 'UUWV_X_CTR' },
    ],
    AFL007: [{ timeOffsetSec: 0, controller: 'UUWV_CTR' }],
    PBD1911: [
      { timeOffsetSec: 320, controller: 'UWGG_TWR' },
      { timeOffsetSec: 470, controller: 'UWGG_R_APP' },
      { timeOffsetSec: 700, controller: 'UWGG_APP' },
      { timeOffsetSec: 940, controller: 'UWWW_CTR' },
    ],
    AFL2182: [
      { timeOffsetSec: 60, controller: 'UWWW_CTR' },
      { timeOffsetSec: 540, controller: 'UUWV_X_CTR' },
    ],
    AFL7090: [
      { timeOffsetSec: 180, controller: 'UWWW_CTR' },
      { timeOffsetSec: 480, controller: 'UWGG_APP' },
      { timeOffsetSec: 820, controller: 'UWGG_R_APP' },
      { timeOffsetSec: 1080, controller: 'UWGG_TWR' },
    ],
    SVR441: [
      { timeOffsetSec: 90, controller: 'UUWV_CTR' },
      { timeOffsetSec: 660, controller: 'UWWW_CTR' },
    ],
    UTA512: [
      { timeOffsetSec: 0, controller: 'UWWW_CTR' },
      { timeOffsetSec: 360, controller: 'UWGG_APP' },
      { timeOffsetSec: 700, controller: 'UWGG_R_APP' },
      { timeOffsetSec: 960, controller: 'UWGG_TWR' },
    ],
  };

  let controllerEventTotal = 0;
  const tracks: AircraftTrack[] = specs.map((spec) => {
    const samples = generateSamplesFromNodes(baseTime, spec.nodes, spec.squawk, 3);
    const segments = segmentSamples(samples);
    const evs = (demoHandoffs[spec.callsign] ?? []).map((h) => {
      const mapped = parseControllerCallsign(h.controller);
      return {
        timeSec: baseTime + h.timeOffsetSec,
        controllerCallsign: h.controller,
        sectorCode: mapped.sectorCode,
        kind: mapped.kind,
      };
    });
    controllerEventTotal += evs.length;
    return {
      callsign: spec.callsign,
      squawk: spec.squawk,
      flightPlan: {
        callsign: spec.callsign,
        aircraftType: spec.aircraftType,
        origin: spec.origin,
        destination: spec.destination,
        cruiseAltFt: spec.cruiseAltFt,
        route: spec.route,
        sidOrStar: spec.sidOrStar,
      },
      samples,
      segments,
      controllerEvents: evs,
      firstSeen: segments[0].startTime,
      lastSeen: segments[segments.length - 1].endTime,
      clearedFl: spec.clearedFl,
    };
  });

  return {
    sourceName: 'UWGG_R_APP · VATSIM Moscow FIR Session',
    sessionDateLabel: '22 NOV 2026',
    center: UWGG_CENTER,
    startTime: baseTime,
    endTime: baseTime + 1280,
    tracks,
    atcStations: [{ callsign: 'UWGG_R_APP', lat: UWGG_CENTER.lat, lon: UWGG_CENTER.lon }],
    diagnostics: {
      totalLines: 4320,
      pilotPackets: tracks.reduce((sum, t) => sum + t.samples.length, 0),
      flightPlans: tracks.length,
      controllerEvents: controllerEventTotal,
      warnings: [],
    },
  };
}

export function buildDefaultCameraKeyframes(startTime: number, endTime: number): CameraKeyframe[] {
  const span = Math.max(60, endTime - startTime);
  return [
    {
      id: 'kf-1',
      timeSec: startTime,
      position: [12, 138, 128],
      target: [12, 6, -4],
      label: 'TMA Overview',
    },
    {
      id: 'kf-2',
      timeSec: startTime + span * 0.35,
      position: [-68, 72, 92],
      target: [0, 12, -2],
      label: 'Departure Climb',
    },
    {
      id: 'kf-3',
      timeSec: startTime + span * 0.72,
      position: [98, 64, 78],
      target: [14, 14, -12],
      label: 'Approach Stream',
    },
    {
      id: 'kf-4',
      timeSec: endTime,
      position: [26, 152, 142],
      target: [10, 6, -6],
      label: 'High Pullback',
    },
  ];
}
