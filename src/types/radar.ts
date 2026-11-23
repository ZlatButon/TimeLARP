export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ENUPoint {
  /** East in kilometers (Three.js +X) */
  x: number;
  /** Up in kilometers (Three.js +Y, un-exaggerated) */
  y: number;
  /** South in kilometers (Three.js +Z, so North is -Z) */
  z: number;
}

export interface FlightPlanInfo {
  callsign: string;
  aircraftType: string;
  origin: string;
  destination: string;
  cruiseAltFt: number;
  route: string;
  sidOrStar?: string;
}

export interface ControllerEvent {
  timeSec: number;
  /** Raw ATC callsign from log (e.g. UWGG_R_APP, UWGG_APP, UUWV_X_CTR), or null if dropped */
  controllerCallsign: string | null;
  /** Normalized short label (TWR, RADAR, APP, CTR) */
  sectorCode: string;
  /** Mapped airspace kind for palette color */
  kind: AirspaceKind | 'ENROUTE';
  /** When controllerCallsign is null (DR packet), remembers which controller dropped the track */
  droppedBy?: string;
}

export interface RadarSample {
  /** Simulation time in seconds from start of day (supports >86400 for midnight rollover) */
  timeSec: number;
  lat: number;
  lon: number;
  /** Pressure/MSL altitude in feet */
  altFt: number;
  /** Ground speed in knots */
  gsKt: number;
  /** True heading in degrees [0, 360) */
  headingDeg: number;
  /** Optional squawk code */
  squawk?: string;
  /** True if heading came directly from PBH bitfield */
  hasExplicitHeading?: boolean;
  /** Optional explicit controlling ATC callsign from log sample (e.g. CSV column or FSD tracking) */
  controllerCallsign?: string;
}

export interface TrackSegment {
  samples: RadarSample[];
  startTime: number;
  endTime: number;
}

export interface AircraftTrack {
  callsign: string;
  squawk: string;
  flightPlan?: FlightPlanInfo;
  samples: RadarSample[];
  /** Continuous segments split whenever radar gap exceeds threshold */
  segments: TrackSegment[];
  firstSeen: number;
  lastSeen: number;
  /** Assigned flight level clearance or target FL */
  clearedFl?: number;
  /** Chronological ATC controller ownership timeline parsed directly from radar log */
  controllerEvents?: ControllerEvent[];
}

export type AirspaceKind = 'CTR' | 'TMA' | 'APP' | 'FIR' | 'RESTRICTED';

export interface InterpolatedAircraftState {
  callsign: string;
  active: boolean;
  lat: number;
  lon: number;
  /** Un-exaggerated ENU coordinates (km) */
  x: number;
  y: number;
  z: number;
  altFt: number;
  gsKt: number;
  headingDeg: number;
  /** Physical pitch in radians (un-exaggerated) */
  pitchRad: number;
  /** Visual 3D spline-tangent pitch in radians accounting for Vertical Exaggeration */
  visualPitchRad: number;
  /** Normalized 3D velocity tangent in scene space (with Vertical Exaggeration applied to Y) */
  tangent3D: [number, number, number];
  /** Bank/roll in radians (positive = right wing down) */
  bankRad: number;
  /** Vertical speed in feet per minute */
  verticalRateFpm: number;
  squawk: string;
  aircraftType: string;
  origin: string;
  destination: string;
  clearedFl?: number;
  sidOrStar?: string;
  /** Active controlling sector ID */
  sectorId?: string;
  /** Active controlling sector short code (e.g. TWR, APP, RADAR, CTR) */
  sectorCode?: string;
  /** Active controlling airspace kind */
  sectorKind?: AirspaceKind | 'ENROUTE';
  /** Smooth visibility alpha [0..1] driven by Hide Ground Traffic fade-in / fade-out */
  visibilityAlpha?: number;
}

export interface AirspaceVolume {
  id: string;
  name: string;
  /** Compact control code shown on aircraft datablocks (e.g. TWR, APP, RADAR, CTR) */
  shortCode?: string;
  /** Radio frequency shown along sector boundaries (e.g. 119.300) */
  frequency?: string;
  kind: AirspaceKind;
  floorFt: number;
  ceilingFt: number;
  polygon: GeoPoint[];
}

export interface Waypoint {
  id: string;
  lat: number;
  lon: number;
  kind: 'FIX' | 'VOR' | 'NDB' | 'AIRPORT';
}

export interface AirwaySegment {
  id: string;
  name: string;
  kind: 'AIRWAY' | 'SID_STAR' | 'RUNWAY' | 'APPROACH_AXIS';
  /** For SID_STAR segments: distinguishes departures vs arrivals */
  procedureType?: 'SID' | 'STAR';
  /** Runway designator associated with SID/STAR (e.g. "18R", "36L", "ALL") */
  runway?: string;
  points: GeoPoint[];
}

export interface RestrictedCircle {
  id: string;
  name: string;
  center: GeoPoint;
  radiusKm: number;
  floorFt: number;
  ceilingFt: number;
}

export interface GeoMapPolygon {
  id: string;
  kind: 'LAND' | 'WATER' | 'URBAN';
  points: GeoPoint[];
  /** Optional inner cutout rings (e.g. islands inside lakes or inland water) */
  holes?: GeoPoint[][];
}

export interface GeoMapPolyline {
  id: string;
  kind: 'COASTLINE' | 'RIVER' | 'BOUNDARY' | 'URBAN_EDGE' | 'ROAD';
  points: GeoPoint[];
  /** Optional relative importance weight (0.3..1.0), used for arterial road illumination hierarchy */
  weight?: number;
}

export interface GeoMapLabel {
  id: string;
  text: string;
  position: GeoPoint;
  kind: 'CITY' | 'WATER' | 'REGION';
  /** Major city/capital vs smaller town (used by City Labels filter) */
  placeTier?: 'major' | 'minor';
  /** Optional OpenMapTiles rank for sorting major cities first */
  rank?: number;
}

export interface BaseMapData {
  name: string;
  /** If true, base plane is ocean/water and LAND polygons sit on top; if false, base is land and WATER polygons cut into it */
  waterBase: boolean;
  polygons: GeoMapPolygon[];
  polylines: GeoMapPolyline[];
  labels: GeoMapLabel[];
}

export interface RunwayProcedureSummary {
  runway: string;
  hasSid: boolean;
  hasStar: boolean;
}

export interface AirspaceDataset {
  name: string;
  regionSubtitle?: string;
  center: GeoPoint;
  airportCode: string;
  airportElevationFt: number;
  volumes: AirspaceVolume[];
  waypoints: Waypoint[];
  airways: AirwaySegment[];
  restrictedZones: AirspaceVolume[];
  restrictedCircles: RestrictedCircle[];
  /** Available runway SID/STAR groupings for per-runway layer toggles */
  runwayProcedures?: RunwayProcedureSummary[];
  baseMap?: BaseMapData;
}

export interface RadarDataset {
  sourceName: string;
  sessionDateLabel?: string;
  center: GeoPoint;
  startTime: number;
  endTime: number;
  tracks: AircraftTrack[];
  atcStations: { callsign: string; lat: number; lon: number }[];
  diagnostics: {
    totalLines: number;
    pilotPackets: number;
    flightPlans: number;
    controllerEvents?: number;
    warnings: string[];
  };
}

export interface AirportTrafficCounters {
  /** Cumulative departures that took off from the target airport up to currentTime */
  airborne: number;
  /** Cumulative arrivals that landed at the target airport up to currentTime */
  landed: number;
}

export type ThemePreset = 'tactical-light' | 'cinematic-dark';
export type TrailStyle = 'radar-ticks' | 'cinematic-ribbon';
export type DatablockMode = 'minimal' | 'detailed';
export type CameraPresetId = 'tactical-top' | 'iso-south' | 'approach-low' | 'orbit-wide';
export type CameraEasingMode = 'linear' | 'smooth-s' | 'ease-in' | 'ease-out';
export type CameraAutoPresetId = 'slow-orbit' | 'runway-glide' | 'high-drift';
export type CityLabelsMode = 'all' | 'major' | 'off';

export interface CameraKeyframe {
  id: string;
  timeSec: number;
  position: [number, number, number];
  target: [number, number, number];
  label: string;
  /** Optional vertical FOV override (degrees) captured from Focal Length at keyframe time */
  fov?: number;
}

export type SecondaryAirportsMode = 'hidden' | 'dimmed' | 'bright';

export interface SceneSettings {
  theme: ThemePreset;
  trailStyle: TrailStyle;
  datablockMode: DatablockMode;
  verticalExaggeration: number;
  trailLengthSec: number;
  /** Configurable radial Radar Range / Fog-of-War radius in kilometers (default 150 km) */
  radarRangeKm: number;
  showLabels: boolean;
  showWaypoints: boolean;
  /** Show major 5-letter enroute/STAR/SID navigation fixes and VOR/NDB stations */
  showEnrouteFixes: boolean;
  /** Show technical runway/localizer/approach fixes (auto-hidden when zoomed out via Zoom LOD) */
  showApproachFixes: boolean;
  /** Visibility mode for neighboring non-target airports (hidden, subtle dimmed, or bright) */
  secondaryAirportsMode: SecondaryAirportsMode;
  /** Manual per-waypoint visibility overrides keyed by waypoint ID */
  waypointOverrides: Record<string, boolean>;
  /** Filter for base-map city labels (All / Major Cities Only / Off) */
  cityLabelsMode: CityLabelsMode;
  /** Manual per-city label overrides keyed by label ID */
  cityLabelOverrides: Record<string, boolean>;
  showAirways: boolean;
  showVolumes: boolean;
  /** Optional solid translucent fill for 3D sector walls/caps (OFF by default for airy wireframe) */
  showSectorFill: boolean;
  showRestricted: boolean;
  showBaseMap: boolean;
  /** Toggle soft nocturnal urban density glow / built-up fabric layer */
  showUrbanGlow: boolean;
  /** Toggle dim major arterial city road network (`transportation` layer) */
  showCityRoads: boolean;
  /** Hide parked & taxiing ground traffic with smooth takeoff fade-in and landing fade-out */
  hideGroundTraffic: boolean;
  /** Show vertical altitude drop lines beneath aircraft (OFF by default) */
  showDropStems: boolean;
  /** Zero-phase two-pass 3D track smoothing window in seconds (smooths X, Y, Z & manual GA jitter) */
  altSmoothSec: number;
  /** Per-runway SID/STAR toggle overrides keyed as "18R:SID", "18R:STAR", etc. (undefined => enabled) */
  procedureVisibility: Record<string, boolean>;
  bloomStrength: number;
  labelScale: number;
  /** Cinematic camera path velocity easing profile */
  cameraEasing: CameraEasingMode;
  /** Spline tension (0 = sweeping, 0.5 = pure centripetal, 1 = taut) */
  cameraTension: number;
  /** OrbitControls damping / inertia factor (0.02..0.20) */
  orbitDamping: number;
  /** Virtual full-frame camera lens focal length in mm (24mm wide .. 85mm telephoto) */
  focalLengthMm: number;
  /** Show thin 3D camera path preview curve in editor mode (auto-hidden in CinemaHUD & export) */
  showCameraPath: boolean;
}

export interface ExportConfig {
  width: number;
  height: number;
  fps: 30 | 60;
  speedMultiplier: number;
  startTimeSec: number;
  endTimeSec: number;
  includeLabels: boolean;
  useKeyframes: boolean;
}

export interface ProjectedLabel {
  callsign: string;
  anchorX: number;
  anchorY: number;
  boxX: number;
  boxY: number;
  width: number;
  height: number;
  altFt: number;
  gsKt: number;
  verticalRateFpm: number;
  aircraftType: string;
  destination: string;
  clearedFl?: number;
  sidOrStar?: string;
  sectorCode?: string;
  selected: boolean;
}

export interface ProjectedWaypoint {
  id: string;
  x: number;
  y: number;
  kind: Waypoint['kind'];
}
