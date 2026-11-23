import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AirspaceDataset,
  AirportTrafficCounters,
  BaseMapData,
  CameraAutoPresetId,
  CameraKeyframe,
  CameraPresetId,
  GeoPoint,
  RadarDataset,
  SceneSettings,
} from './types/radar';
import { formatUtcTimeHm } from './core/geo';
import { cleanSectorTitle } from './core/sectorParser';
import { fetchOsmBaseMap } from './core/osmLandscape';
import { generateAutoCameraPreset } from './core/cameraRig';
import {
  buildDefaultCameraKeyframes,
  buildUwggAirspaceDataset,
  buildUwggDemoRadarDataset,
} from './data/uwggDemoDataset';
import type { RadarSceneEngine } from './scene/RadarSceneEngine';
import { RadarViewport } from './components/RadarViewport';
import { BottomControlDock } from './components/BottomControlDock';
import { ImportModal } from './components/ImportModal';
import { ExportModal } from './components/ExportModal';

const INITIAL_SETTINGS: SceneSettings = {
  theme: 'cinematic-dark',
  trailStyle: 'cinematic-ribbon',
  datablockMode: 'minimal',
  verticalExaggeration: 4.5,
  trailLengthSec: 150,
  radarRangeKm: 150,
  showLabels: true,
  showWaypoints: true,
  showEnrouteFixes: true,
  showApproachFixes: false,
  secondaryAirportsMode: 'dimmed',
  waypointOverrides: {},
  showAirways: true,
  showVolumes: true,
  showSectorFill: false,
  showRestricted: true,
  showBaseMap: true,
  showUrbanGlow: true,
  showCityRoads: true,
  cityLabelsMode: 'major',
  cityLabelOverrides: {},
  showDropStems: false,
  hideGroundTraffic: true,
  altSmoothSec: 10,
  cameraEasing: 'smooth-s',
  cameraTension: 0.5,
  orbitDamping: 0.07,
  focalLengthMm: 30,
  showCameraPath: true,
  procedureVisibility: {},
  bloomStrength: 0.42,
  labelScale: 1,
};

const SECTOR_LEGEND = [
  { label: 'TWR', darkColor: '#fde68a', lightColor: '#d97706' },
  { label: 'RADAR', darkColor: '#f59e0b', lightColor: '#ea580c' },
  { label: 'APP', darkColor: '#38bdf8', lightColor: '#0284c7' },
  { label: 'CTR', darkColor: '#818cf8', lightColor: '#4338ca' },
] as const;

export default function App() {
  const initialAirspace = useMemo(() => buildUwggAirspaceDataset(), []);
  const initialRadar = useMemo(() => buildUwggDemoRadarDataset(), []);

  const [airspace, setAirspace] = useState<AirspaceDataset>(initialAirspace);
  const [radar, setRadar] = useState<RadarDataset>(initialRadar);
  const [settings, setSettings] = useState<SceneSettings>(INITIAL_SETTINGS);
  const [customTitle, setCustomTitle] = useState<string>('');
  const [osmStatus, setOsmStatus] = useState<
    'idle' | 'loading' | 'indexeddb' | 'openfreemap' | 'overpass' | 'error'
  >('idle');
  const [osmDetail, setOsmDetail] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(15);
  const [simTimeSec, setSimTimeSec] = useState(
    initialRadar.startTime + Math.min(180, (initialRadar.endTime - initialRadar.startTime) * 0.14),
  );
  const [seekNonce, setSeekNonce] = useState(0);
  const [, setActiveCount] = useState(0);
  const [activeCallsigns, setActiveCallsigns] = useState<string[]>([]);
  const [airportStats, setAirportStats] = useState<AirportTrafficCounters>({
    airborne: 0,
    landed: 0,
  });

  const [selectedCallsign, setSelectedCallsign] = useState<string | null>('AUL510');
  const [followSelected, setFollowSelected] = useState(false);

  const [keyframes, setKeyframes] = useState<CameraKeyframe[]>(() =>
    buildDefaultCameraKeyframes(initialRadar.startTime, initialRadar.endTime),
  );
  const [useKeyframes, setUseKeyframes] = useState(false);

  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const engineRef = useRef<RadarSceneEngine | null>(null);
  const osmReqSeqRef = useRef(0);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'cinematic-dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [settings.theme]);

  const handleSettingsChange = useCallback((patch: Partial<SceneSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSeek = useCallback((timeSec: number) => {
    setSimTimeSec(timeSec);
    setSeekNonce((n) => n + 1);
  }, []);

  const handleAddKeyframe = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const cam = engine.captureCurrentCamera();
    const id = `kf-${Date.now()}`;
    setKeyframes((prev) => {
      const filtered = prev.filter((k) => Math.abs(k.timeSec - simTimeSec) > 2);
      return [
        ...filtered,
        {
          id,
          timeSec: simTimeSec,
          position: cam.position,
          target: cam.target,
          fov: cam.fov,
          label: `Cam ${filtered.length + 1}`,
        },
      ].sort((a, b) => a.timeSec - b.timeSec);
    });
  }, [simTimeSec]);

  const handleDeleteKeyframe = useCallback((id: string) => {
    setKeyframes((prev) => {
      const next = prev.filter((k) => k.id !== id);
      if (next.length < 2) setUseKeyframes(false);
      return next;
    });
  }, []);

  const handleJumpToKeyframe = useCallback((kf: CameraKeyframe) => {
    setSimTimeSec(kf.timeSec);
    setSeekNonce((n) => n + 1);
    const engine = engineRef.current;
    if (engine) {
      engine.camera.position.set(...kf.position);
      engine.controls.target.set(...kf.target);
      if (typeof kf.fov === 'number' && Math.abs(engine.camera.fov - kf.fov) > 0.05) {
        engine.camera.fov = kf.fov;
        engine.camera.updateProjectionMatrix();
      }
      engine.controls.update();
      engine.requestRender();
    }
  }, []);

  const handleJumpCameraPreset = useCallback((preset: CameraPresetId) => {
    setUseKeyframes(false);
    setFollowSelected(false);
    engineRef.current?.jumpToCameraPreset(preset);
  }, []);

  const handleApplyAutoCameraPreset = useCallback(
    (preset: CameraAutoPresetId) => {
      const generated = generateAutoCameraPreset(preset, radar.startTime, radar.endTime);
      setKeyframes(generated);
      setFollowSelected(false);
      setUseKeyframes(true);
      setSettings((prev) => ({ ...prev, showCameraPath: true }));
      setSeekNonce((n) => n + 1);
    },
    [radar.startTime, radar.endTime],
  );

  const handleLoadRadar = useCallback((nextRadar: RadarDataset) => {
    setIsPlaying(false);
    setRadar(nextRadar);
    setSimTimeSec(nextRadar.startTime);
    setSeekNonce((n) => n + 1);
    setSelectedCallsign(nextRadar.tracks[0]?.callsign ?? null);
    setFollowSelected(false);
    setKeyframes(buildDefaultCameraKeyframes(nextRadar.startTime, nextRadar.endTime));
  }, []);

  const handleLoadBaseMap = useCallback((baseMap: BaseMapData) => {
    setAirspace((prev) => ({ ...prev, baseMap }));
    setSettings((prev) => ({ ...prev, showBaseMap: true }));
    setOsmStatus('idle');
    setOsmDetail(null);
  }, []);

  const handleUpdateVolumeBounds = useCallback(
    (volumeId: string, floorFt: number, ceilingFt: number) => {
      setAirspace((prev) => ({
        ...prev,
        volumes: prev.volumes.map((v) =>
          v.id === volumeId ? { ...v, floorFt, ceilingFt } : v,
        ),
      }));
    },
    [],
  );

  const handleUpdateTargetAirportCode = useCallback((code: string) => {
    setAirspace((prev) => ({
      ...prev,
      airportCode: code || prev.airportCode,
    }));
  }, []);

  const handleReloadOsmTerrain = useCallback(
    (center: GeoPoint, radiusKm: number, airportCode: string) => {
      const seq = ++osmReqSeqRef.current;
      setOsmStatus('loading');
      setOsmDetail(null);
      void fetchOsmBaseMap(center, radiusKm, airportCode).then((result) => {
        if (seq !== osmReqSeqRef.current) return;
        setOsmStatus(result.source);
        if (result.baseMap) {
          setAirspace((prev) => ({ ...prev, baseMap: result.baseMap! }));
          setSettings((prev) => ({ ...prev, showBaseMap: true }));
          const mirrorLabel = result.stats.mirror ? ` via ${result.stats.mirror}` : '';
          const tileInfo =
            result.stats.tilesLoaded && result.stats.zoom
              ? ` · ${result.stats.tilesLoaded} tiles @ z${result.stats.zoom}`
              : '';
          const urbanNote =
            result.stats.urban > 0 ? `, ${result.stats.urban} built-up zones` : '';
          const roadNote =
            result.stats.roads > 0 ? `, ${result.stats.roads} arterial roads` : '';
          setOsmDetail(
            `Loaded ${result.stats.polygons} water polygons${urbanNote}${roadNote}, ${result.stats.rivers} rivers, ${result.stats.boundaries} borders, ${result.stats.cities} cities (${result.source}${mirrorLabel}${tileInfo}).`,
          );
        } else {
          // Never overwrite an existing valid map with a blank fallback on error
          setOsmDetail(
            result.errorMessage ??
              'OpenFreeMap vector tiles unavailable. Existing map preserved.',
          );
        }
      });
    },
    [],
  );

  const handleLoadAirspace = useCallback(
    (nextAirspace: AirspaceDataset, radiusKm = 160) => {
      setAirspace(nextAirspace);
      setSettings((prev) => ({
        ...prev,
        procedureVisibility: {},
        waypointOverrides: {},
        cityLabelOverrides: {},
      }));
      if (!nextAirspace.baseMap) {
        handleReloadOsmTerrain(
          nextAirspace.center,
          Math.min(250, Math.max(150, radiusKm)),
          nextAirspace.airportCode,
        );
      }
    },
    [handleReloadOsmTerrain],
  );

  const handleResetDemo = useCallback(() => {
    osmReqSeqRef.current += 1;
    setOsmStatus('idle');
    setOsmDetail(null);
    setCustomTitle('');
    const demoAir = buildUwggAirspaceDataset();
    const demoRadar = buildUwggDemoRadarDataset();
    setAirspace(demoAir);
    setSettings((prev) => ({
      ...prev,
      procedureVisibility: {},
      waypointOverrides: {},
      cityLabelOverrides: {},
    }));
    handleLoadRadar(demoRadar);
    setSimTimeSec(demoRadar.startTime + 180);
    setSeekNonce((n) => n + 1);
    setSelectedCallsign('AUL510');
  }, [handleLoadRadar]);

  // Global keyboard shortcuts (Space: Play/Pause, H: Hide/Show HUD, K: Add Keyframe)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        importOpen ||
        exportOpen ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key === 'h' || e.key === 'H') {
        setDockCollapsed((c) => !c);
      } else if (e.key === 'k' || e.key === 'K') {
        handleAddKeyframe();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [importOpen, exportOpen, handleAddKeyframe]);

  const isDark = settings.theme === 'cinematic-dark';
  const defaultTitle = useMemo(() => {
    const cleaned = cleanSectorTitle(airspace.name, airspace.airportCode);
    const withoutCode = cleaned
      .replace(new RegExp(`^${airspace.airportCode}[\\s·-]+`, 'i'), '')
      .trim();
    return withoutCode
      ? `${airspace.airportCode} · ${withoutCode.toUpperCase()}`
      : airspace.airportCode.toUpperCase();
  }, [airspace.name, airspace.airportCode]);

  const hudTitle = customTitle.trim() ? customTitle.trim().toUpperCase() : defaultTitle;
  const hudSubtitle = airspace.regionSubtitle ?? 'AEROSCOPE 3D · RADAR TIMELAPSE';
  const hudDateLabel = radar.sessionDateLabel ?? '22 NOV 2026';

  return (
    <main
      className={`relative w-screen h-screen overflow-hidden ${
        isDark ? 'bg-[#050912] text-slate-100' : 'bg-[#9aa0a7] text-slate-900'
      }`}
      data-playing={isPlaying ? 'true' : 'false'}
    >
      {/* Full-viewport 3D WebGL Radar Scene */}
      <RadarViewport
        airspace={airspace}
        radar={radar}
        settings={settings}
        isPlaying={isPlaying}
        speedMultiplier={speedMultiplier}
        simTimeSec={simTimeSec}
        seekNonce={seekNonce}
        selectedCallsign={selectedCallsign}
        followSelected={followSelected}
        keyframes={keyframes}
        useKeyframes={useKeyframes}
        cinemaMode={dockCollapsed}
        onSelectAircraft={(cs) => {
          setSelectedCallsign(cs);
          if (!cs) setFollowSelected(false);
        }}
        onTimeAdvance={(t) => setSimTimeSec(t)}
        onActiveCountChange={setActiveCount}
        onActiveCallsignsChange={setActiveCallsigns}
        onAirportStatsChange={setAirportStats}
        onEngineReady={(engine) => {
          engineRef.current = engine;
        }}
      />

      {/* Soft Dark Radial Vignette Backdrop Behind Top-Left Telemetry HUD (zero backdrop-blur) */}
      {isDark && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed top-0 left-0 z-10 w-[520px] h-[210px]"
          style={{
            background:
              'radial-gradient(ellipse at 18% 22%, rgba(4, 8, 16, 0.62) 0%, rgba(4, 8, 16, 0.28) 46%, rgba(4, 8, 16, 0) 76%)',
          }}
        />
      )}

      {/* Unified Asymmetric Telemetry Cinema HUD (Top-Left Monolith, 1:1 with Video Export) */}
      <header
        className="pointer-events-none fixed top-5 left-6 z-20 flex items-stretch gap-3 max-w-[min(92vw,760px)]"
        data-testid="cinema-hud-telemetry"
      >
        {/* Vertical Gold-Amber-Cyan-Indigo Telemetry Accent Stripe */}
        <div
          className={`w-[3px] shrink-0 rounded-full ${
            isDark
              ? 'bg-gradient-to-b from-amber-200 via-sky-400 to-indigo-400'
              : 'bg-gradient-to-b from-amber-600 via-sky-600 to-indigo-700'
          }`}
          aria-hidden="true"
        />

        <div className="flex flex-col min-w-0">
          {/* Row 1: Region Title + Generous Gap + Calm HH:MM UTC Clock */}
          <div className="flex items-baseline flex-wrap gap-x-6 gap-y-0.5">
            <h1
              className={`text-sm sm:text-base font-bold tracking-[0.12em] uppercase leading-tight truncate ${
                isDark ? 'text-slate-100/95' : 'text-slate-950/95'
              }`}
              style={{
                textShadow: isDark
                  ? '0 2px 10px rgba(2, 6, 23, 0.94)'
                  : '0 1px 4px rgba(255, 255, 255, 0.45)',
              }}
            >
              {hudTitle}
            </h1>
            <div
              className={`font-mono-tabular text-sm sm:text-base font-bold tracking-[0.08em] whitespace-nowrap ${
                isDark ? 'text-sky-200/95' : 'text-slate-950/95'
              }`}
              data-testid="cinema-hud-clock"
              style={{
                textShadow: isDark
                  ? '0 2px 10px rgba(2, 6, 23, 0.94)'
                  : '0 1px 4px rgba(255, 255, 255, 0.45)',
              }}
            >
              {formatUtcTimeHm(simTimeSec)}
              <span className="text-[11px] font-semibold opacity-70 ml-1.5">UTC</span>
            </div>
          </div>

          {/* Row 2: Session Date · Selected Callsign */}
          <div
            className={`mt-1 flex items-center flex-wrap gap-x-2 text-[11px] font-mono-tabular tracking-[0.12em] uppercase ${
              isDark ? 'text-slate-400/90' : 'text-slate-800/90'
            }`}
          >
            <span>{hudDateLabel}</span>
            {selectedCallsign && (
              <>
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                <span className={isDark ? 'text-amber-300 font-semibold' : 'text-sky-800 font-semibold'}>
                  {selectedCallsign}
                </span>
              </>
            )}
          </div>

          {/* Row 3: Deterministic Target-Airport Cumulative Counters (XX AIRBORNE · XX LANDED) */}
          <div
            className={`mt-1 flex items-center flex-wrap gap-x-2 text-[11px] font-mono-tabular tracking-[0.12em] uppercase ${
              isDark ? 'text-slate-300/90' : 'text-slate-900/90'
            }`}
            data-testid="cinema-hud-airport-stats"
          >
            <span className={isDark ? 'text-slate-400 font-semibold' : 'text-slate-700 font-semibold'}>
              {airspace.airportCode.toUpperCase()}
            </span>
            <span className={isDark ? 'text-sky-300 font-semibold' : 'text-sky-900 font-semibold'}>
              {String(airportStats.airborne).padStart(2, '0')} AIRBORNE
            </span>
            <span aria-hidden="true" className="opacity-50">
              ·
            </span>
            <span className={isDark ? 'text-emerald-300 font-semibold' : 'text-emerald-900 font-semibold'}>
              {String(airportStats.landed).padStart(2, '0')} LANDED
            </span>
          </div>

          {/* Row 4: Miniature Active Sector Color Legend */}
          <div
            className={`mt-1.5 flex items-center flex-wrap gap-x-3.5 gap-y-1 text-[10px] font-mono-tabular font-semibold tracking-[0.1em] ${
              isDark ? 'text-slate-300/85' : 'text-slate-900/85'
            }`}
            data-testid="cinema-hud-legend"
          >
            {SECTOR_LEGEND.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: isDark ? item.darkColor : item.lightColor }}
                />
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* Collapsible Unified Bottom Control Dock */}
      <BottomControlDock
        collapsed={dockCollapsed}
        onToggleCollapse={() => setDockCollapsed((c) => !c)}
        isPlaying={isPlaying}
        onTogglePlay={() => setIsPlaying((p) => !p)}
        speedMultiplier={speedMultiplier}
        onSpeedChange={setSpeedMultiplier}
        simTimeSec={simTimeSec}
        startTimeSec={radar.startTime}
        endTimeSec={radar.endTime}
        onSeek={handleSeek}
        settings={settings}
        onSettingsChange={handleSettingsChange}
        tracks={radar.tracks}
        activeCallsigns={activeCallsigns}
        volumes={airspace.volumes}
        onUpdateVolumeBounds={handleUpdateVolumeBounds}
        selectedCallsign={selectedCallsign}
        followSelected={followSelected}
        onSelectAircraft={(cs) => {
          setSelectedCallsign(cs);
          if (!cs) setFollowSelected(false);
        }}
        onToggleFollow={() => {
          setUseKeyframes(false);
          setFollowSelected((f) => !f);
        }}
        keyframes={keyframes}
        useKeyframes={useKeyframes}
        onToggleUseKeyframes={() => {
          setFollowSelected(false);
          setUseKeyframes((u) => !u);
        }}
        onAddKeyframe={handleAddKeyframe}
        onDeleteKeyframe={handleDeleteKeyframe}
        onJumpToKeyframe={handleJumpToKeyframe}
        onJumpCameraPreset={handleJumpCameraPreset}
        onApplyAutoCameraPreset={handleApplyAutoCameraPreset}
        onOpenImport={() => setImportOpen(true)}
        onOpenExport={() => {
          setIsPlaying(false);
          setExportOpen(true);
        }}
        runwayProcedures={airspace.runwayProcedures}
        waypoints={airspace.waypoints}
        baseMapLabels={airspace.baseMap?.labels ?? []}
        airportCode={airspace.airportCode}
        airportCenter={airspace.center}
      />

      {/* File Import Modal (.txt FSD + Interactive .sct/.ese Filter + OSM Dark Terrain) */}
      <ImportModal
        open={importOpen}
        theme={settings.theme}
        currentRadar={radar}
        currentAirspace={airspace}
        customTitle={customTitle}
        osmStatus={osmStatus}
        osmDetail={osmDetail}
        onClose={() => setImportOpen(false)}
        onUpdateCustomTitle={setCustomTitle}
        onUpdateTargetAirportCode={handleUpdateTargetAirportCode}
        onLoadRadar={handleLoadRadar}
        onLoadAirspace={handleLoadAirspace}
        onLoadBaseMap={handleLoadBaseMap}
        onReloadOsmTerrain={handleReloadOsmTerrain}
        onResetDemo={handleResetDemo}
      />

      {/* Deterministic Offline Render Export Modal */}
      <ExportModal
        open={exportOpen}
        theme={settings.theme}
        engine={engineRef.current}
        startTimeSec={radar.startTime}
        endTimeSec={radar.endTime}
        hasKeyframes={keyframes.length >= 2}
        hudMeta={{
          title: hudTitle,
          subtitle: hudSubtitle,
          dateLabel: hudDateLabel,
          airportCode: airspace.airportCode,
        }}
        onClose={() => setExportOpen(false)}
      />
    </main>
  );
}
