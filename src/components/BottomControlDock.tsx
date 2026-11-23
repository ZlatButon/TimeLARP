import React, { useState } from 'react';
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Film,
  Layers,
  Pause,
  Play,
  Plus,
  Plane,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AircraftTrack,
  AirspaceVolume,
  CameraAutoPresetId,
  CameraEasingMode,
  CameraKeyframe,
  CameraPresetId,
  CityLabelsMode,
  GeoMapLabel,
  GeoPoint,
  RunwayProcedureSummary,
  SceneSettings,
  SecondaryAirportsMode,
  ThemePreset,
  TrailStyle,
  Waypoint,
} from '../types/radar';
import { formatUtcTime } from '../core/geo';
import { classifyWaypoint } from '../core/waypointFilter';
import { focalLengthMmToFovDeg } from '../core/cameraRig';
import { shouldShowGroundLabel } from '../core/mapLabelFilter';

type DockTab = 'visual' | 'camera' | 'traffic' | 'layers';

const SPEED_OPTIONS = [1, 5, 15, 30, 60, 120];

interface BottomControlDockProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  speedMultiplier: number;
  onSpeedChange: (speed: number) => void;
  simTimeSec: number;
  startTimeSec: number;
  endTimeSec: number;
  onSeek: (timeSec: number) => void;
  settings: SceneSettings;
  onSettingsChange: (patch: Partial<SceneSettings>) => void;
  tracks: AircraftTrack[];
  activeCallsigns: string[];
  volumes: AirspaceVolume[];
  onUpdateVolumeBounds: (volumeId: string, floorFt: number, ceilingFt: number) => void;
  selectedCallsign: string | null;
  followSelected: boolean;
  onSelectAircraft: (callsign: string | null) => void;
  onToggleFollow: () => void;
  keyframes: CameraKeyframe[];
  useKeyframes: boolean;
  onToggleUseKeyframes: () => void;
  onAddKeyframe: () => void;
  onDeleteKeyframe: (id: string) => void;
  onJumpToKeyframe: (kf: CameraKeyframe) => void;
  onJumpCameraPreset: (preset: CameraPresetId) => void;
  onApplyAutoCameraPreset: (preset: CameraAutoPresetId) => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
  runwayProcedures?: RunwayProcedureSummary[];
  waypoints: Waypoint[];
  baseMapLabels: GeoMapLabel[];
  airportCode: string;
  airportCenter: GeoPoint;
}

export const BottomControlDock: React.FC<BottomControlDockProps> = ({
  collapsed,
  onToggleCollapse,
  isPlaying,
  onTogglePlay,
  speedMultiplier,
  onSpeedChange,
  simTimeSec,
  startTimeSec,
  endTimeSec,
  onSeek,
  settings,
  onSettingsChange,
  tracks,
  activeCallsigns,
  volumes,
  onUpdateVolumeBounds,
  selectedCallsign,
  followSelected,
  onSelectAircraft,
  onToggleFollow,
  keyframes,
  useKeyframes,
  onToggleUseKeyframes,
  onAddKeyframe,
  onDeleteKeyframe,
  onJumpToKeyframe,
  onJumpCameraPreset,
  onApplyAutoCameraPreset,
  onOpenImport,
  onOpenExport,
  runwayProcedures,
  waypoints,
  baseMapLabels,
  airportCode,
  airportCenter,
}) => {
  const [activeTab, setActiveTab] = useState<DockTab>('visual');
  const [trafficFilter, setTrafficFilter] = useState<'active' | 'all'>('active');
  const [sectorEditorOpen, setSectorEditorOpen] = useState(false);
  const [waypointFilterOpen, setWaypointFilterOpen] = useState(false);
  const [cityFilterOpen, setCityFilterOpen] = useState(false);
  const [waypointSearch, setWaypointSearch] = useState('');

  const cityLabels = baseMapLabels.filter((lb) => lb.kind === 'CITY');

  const isDark = settings.theme === 'cinematic-dark';
  const span = Math.max(1, endTimeSec - startTimeSec);
  const progressPct = Math.max(0, Math.min(100, ((simTimeSec - startTimeSec) / span) * 100));

  const activeCallsignSet = new Set(activeCallsigns);
  const visibleTracks =
    trafficFilter === 'active'
      ? tracks.filter((tr) => activeCallsignSet.has(tr.callsign))
      : tracks;

  const panelBg = isDark
    ? 'bg-slate-950/95 border-slate-800 text-slate-100'
    : 'bg-slate-100/95 border-slate-400/60 text-slate-900';

  const subtleSurface = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-300';
  const mutedText = isDark ? 'text-slate-400' : 'text-slate-600';

  const setTheme = (theme: ThemePreset) => onSettingsChange({ theme });
  const setTrailStyle = (trailStyle: TrailStyle) => onSettingsChange({ trailStyle });

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center w-[min(1060px,96vw)] pointer-events-none"
      data-testid="bottom-control-dock"
    >
      {/* Collapse / Expand Zen Mode Drawer Handle */}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Show controls' : 'Hide controls'}
        aria-expanded={!collapsed}
        className={`pointer-events-auto mb-1.5 flex items-center gap-1.5 px-3 py-1 rounded-md border text-xs font-medium transition-colors cursor-pointer ${panelBg} hover:border-sky-500/70`}
      >
        {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        <span className="whitespace-nowrap">
          {collapsed ? 'Show Controls' : 'Hide Controls'}
        </span>
      </button>

      {/* Main Dock Container */}
      <div
        className={`pointer-events-auto w-full rounded-xl border shadow-lg transition-all duration-200 overflow-hidden ${panelBg} ${
          collapsed ? 'max-h-0 opacity-0 border-0 pointer-events-none' : 'max-h-[430px] opacity-100'
        }`}
      >
        {/* Row 1: Playback, Timeline Scrubber with Keyframe Diamonds, Speed & Primary Actions */}
        <div className="px-4 pt-3 pb-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
            {/* Play / Pause */}
            <button
              type="button"
              onClick={onTogglePlay}
              aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
              className="w-9 h-9 shrink-0 rounded-lg bg-sky-600 hover:bg-sky-500 text-white flex items-center justify-center transition-colors cursor-pointer"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>

            {/* UTC Time Readout */}
            <div className="font-mono-tabular text-sm font-semibold whitespace-nowrap shrink-0 w-[86px]">
              {formatUtcTime(simTimeSec)}
              <span className={`text-[10px] font-normal ml-1 ${mutedText}`}>UTC</span>
            </div>

            {/* Scrubber Track + Keyframe Markers */}
            <div className="relative flex-1 min-w-[160px] h-7 flex items-center">
              <div
                className={`absolute left-0 right-0 h-1 rounded-full ${
                  isDark ? 'bg-slate-800' : 'bg-slate-300'
                }`}
              />
              <div
                className="absolute left-0 h-1 rounded-full bg-sky-500 pointer-events-none"
                style={{ width: `${progressPct}%` }}
              />
              {/* Camera Keyframe Diamond Markers */}
              {keyframes.map((kf) => {
                const leftPct = Math.max(0, Math.min(100, ((kf.timeSec - startTimeSec) / span) * 100));
                return (
                  <button
                    key={kf.id}
                    type="button"
                    onClick={() => onJumpToKeyframe(kf)}
                    title={`Keyframe: ${kf.label} (${formatUtcTime(kf.timeSec)})`}
                    aria-label={`Jump to keyframe ${kf.label}`}
                    style={{ left: `${leftPct}%` }}
                    className="absolute -translate-x-1/2 top-0.5 w-2.5 h-2.5 rotate-45 bg-amber-400 border border-slate-900 hover:scale-125 transition-transform z-10 cursor-pointer"
                  />
                );
              })}
              <input
                type="range"
                aria-label="Simulation timeline"
                min={startTimeSec}
                max={endTimeSec}
                step={0.5}
                value={simTimeSec}
                onChange={(e) => onSeek(Number(e.target.value))}
                className="aero-slider aero-slider-timeline relative z-20 w-full h-7"
              />
            </div>

            {/* Speed Selector */}
            <div
              className={`flex items-center p-0.5 rounded-lg border shrink-0 ${subtleSurface}`}
              role="group"
              aria-label="Playback speed"
            >
              {SPEED_OPTIONS.map((spd) => (
                <button
                  key={spd}
                  type="button"
                  onClick={() => onSpeedChange(spd)}
                  className={`px-2 py-1 text-[11px] font-mono-tabular font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    speedMultiplier === spd
                      ? 'bg-sky-600 text-white'
                      : `${mutedText} hover:text-sky-500`
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>

            {/* Import & Render Video */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={onOpenImport}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${subtleSurface} hover:border-sky-500`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Import</span>
              </button>
              <button
                type="button"
                onClick={onOpenExport}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors cursor-pointer whitespace-nowrap"
              >
                <Film className="w-3.5 h-3.5" />
                <span>Render Video</span>
              </button>
            </div>
          </div>
        </div>

        {/* Hairline Divider & Tab Strip */}
        <div
          className={`px-4 py-1.5 border-t flex items-center justify-between gap-4 ${
            isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-300/80 bg-slate-200/50'
          }`}
        >
          <div className="flex items-center gap-1" role="tablist" aria-label="Control categories">
            {(
              [
                { id: 'visual', label: 'Visual & Trails', icon: SlidersHorizontal },
                { id: 'camera', label: 'Camera & Keyframes', icon: Camera },
                { id: 'traffic', label: `Traffic (${activeCallsigns.length})`, icon: Plane },
                { id: 'layers', label: 'Airspace Layers', icon: Layers },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === id
                    ? isDark
                      ? 'bg-slate-800 text-sky-400'
                      : 'bg-white text-sky-700 shadow-xs'
                    : `${mutedText} hover:text-sky-500`
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className={`hidden md:flex items-center gap-2 text-[11px] ${mutedText}`}>
            <span>Space: Play</span>
            <span aria-hidden="true">·</span>
            <span>K: Keyframe</span>
            <span aria-hidden="true">·</span>
            <span>H: Hide HUD</span>
          </div>
        </div>

        {/* Row 2: Active Tab Content */}
        <div className="px-4 py-3 min-h-[64px]">
          {activeTab === 'visual' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {/* Theme Switcher */}
              <div className="flex items-center gap-1.5">
                <span className={`text-[11px] font-medium ${mutedText}`}>Theme</span>
                <div className={`flex items-center p-0.5 rounded-lg border ${subtleSurface}`}>
                  <button
                    type="button"
                    onClick={() => setTheme('tactical-light')}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      settings.theme === 'tactical-light'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    Tactical Light
                  </button>
                  <button
                    type="button"
                    onClick={() => setTheme('cinematic-dark')}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      settings.theme === 'cinematic-dark'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    Cinematic Dark
                  </button>
                </div>
              </div>

              {/* Trail Style Switcher */}
              <div className="flex items-center gap-1.5">
                <span className={`text-[11px] font-medium ${mutedText}`}>Trail</span>
                <div className={`flex items-center p-0.5 rounded-lg border ${subtleSurface}`}>
                  <button
                    type="button"
                    onClick={() => setTrailStyle('cinematic-ribbon')}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      settings.trailStyle === 'cinematic-ribbon'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    Luminous Ribbons
                  </button>
                  <button
                    type="button"
                    onClick={() => setTrailStyle('radar-ticks')}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      settings.trailStyle === 'radar-ticks'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    Radar Ticks
                  </button>
                </div>
              </div>

              {/* Datablock Mode Switcher */}
              <div className="flex items-center gap-1.5">
                <span className={`text-[11px] font-medium ${mutedText}`}>Tags</span>
                <div className={`flex items-center p-0.5 rounded-lg border ${subtleSurface}`}>
                  <button
                    type="button"
                    onClick={() => onSettingsChange({ datablockMode: 'minimal' })}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      settings.datablockMode === 'minimal'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    Minimal
                  </button>
                  <button
                    type="button"
                    onClick={() => onSettingsChange({ datablockMode: 'detailed' })}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      settings.datablockMode === 'detailed'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    Detailed
                  </button>
                </div>
              </div>

              {/* Vertical Exaggeration Slider */}
              <label className="flex items-center gap-1.5 text-[11px]">
                <span className={`font-medium whitespace-nowrap ${mutedText}`}>Vertical</span>
                <input
                  type="range"
                  min={1}
                  max={15}
                  step={0.5}
                  value={settings.verticalExaggeration}
                  onChange={(e) =>
                    onSettingsChange({ verticalExaggeration: Number(e.target.value) })
                  }
                  className="aero-slider w-12"
                />
                <span className="font-mono-tabular font-semibold w-7 text-right">
                  {settings.verticalExaggeration.toFixed(1)}x
                </span>
              </label>

              {/* Trail Length Slider */}
              <label className="flex items-center gap-1.5 text-[11px]">
                <span className={`font-medium whitespace-nowrap ${mutedText}`}>Trail</span>
                <input
                  type="range"
                  min={30}
                  max={300}
                  step={15}
                  value={settings.trailLengthSec}
                  onChange={(e) => onSettingsChange({ trailLengthSec: Number(e.target.value) })}
                  className="aero-slider w-12"
                />
                <span className="font-mono-tabular font-semibold w-7 text-right">
                  {settings.trailLengthSec}s
                </span>
              </label>

              {/* Zero-Phase 3D Track Smoothing Slider (X/Y/Z Gaussian filter + manual flight stabilization) */}
              <label
                className="flex items-center gap-1.5 text-[11px]"
                title="Zero-phase 3D track smoothing window (stabilizes noisy manual X/Y/Z flight paths without time lag)"
              >
                <span className={`font-medium whitespace-nowrap ${mutedText}`}>Track Smooth</span>
                <input
                  type="range"
                  aria-label="Track smoothing window"
                  min={0}
                  max={30}
                  step={1}
                  value={settings.altSmoothSec}
                  onChange={(e) => onSettingsChange({ altSmoothSec: Number(e.target.value) })}
                  className="aero-slider w-12"
                />
                <span className="font-mono-tabular font-semibold w-6 text-right">
                  {settings.altSmoothSec}s
                </span>
              </label>

              {/* Radar Range / Radial Fog-of-War Slider */}
              <label
                className="flex items-center gap-1.5 text-[11px]"
                title="Radar coverage radius: map terrain and traffic smoothly fade into horizon fog across 75-100%"
              >
                <span className={`font-medium whitespace-nowrap ${mutedText}`}>Range</span>
                <input
                  type="range"
                  aria-label="Radar range kilometers"
                  min={80}
                  max={260}
                  step={10}
                  value={settings.radarRangeKm}
                  onChange={(e) => onSettingsChange({ radarRangeKm: Number(e.target.value) })}
                  className="aero-slider w-14"
                />
                <span className="font-mono-tabular font-semibold w-10 text-right">
                  {settings.radarRangeKm}km
                </span>
              </label>

              {/* Bloom Slider (Cinematic Dark) */}
              {isDark && (
                <label className="flex items-center gap-1.5 text-[11px]">
                  <span className={`font-medium whitespace-nowrap ${mutedText}`}>Bloom</span>
                  <input
                    type="range"
                    min={0}
                    max={1.2}
                    step={0.05}
                    value={settings.bloomStrength}
                    onChange={(e) => onSettingsChange({ bloomStrength: Number(e.target.value) })}
                    className="aero-slider w-12"
                  />
                  <span className="font-mono-tabular font-semibold w-7 text-right">
                    {settings.bloomStrength.toFixed(2)}
                  </span>
                </label>
              )}
            </div>
          )}

          {activeTab === 'camera' && (
            <div className="flex flex-col gap-2">
              {/* Row 1: Instant Views, 1-Click Auto Paths, Keyframe Capture & Path Preview */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-[11px] font-medium ${mutedText}`}>View</span>
                  {(
                    [
                      { id: 'tactical-top', label: 'Tactical Top' },
                      { id: 'iso-south', label: 'Iso 3/4' },
                      { id: 'approach-low', label: 'Low Approach' },
                      { id: 'orbit-wide', label: 'Wide TMA' },
                    ] as const
                  ).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onJumpCameraPreset(preset.id)}
                      className={`px-2 py-1 rounded-md border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${subtleSurface} hover:border-sky-500`}
                    >
                      {preset.label}
                    </button>
                  ))}

                  <span className={`text-[11px] font-medium ml-1.5 ${mutedText}`}>Auto</span>
                  {(
                    [
                      { id: 'slow-orbit', label: 'Slow Orbit' },
                      { id: 'runway-glide', label: 'Runway Glide' },
                      { id: 'high-drift', label: 'High Drift' },
                    ] as Array<{ id: CameraAutoPresetId; label: string }>
                  ).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onApplyAutoCameraPreset(preset.id)}
                      className={`px-2 py-1 rounded-md border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${subtleSurface} hover:border-amber-500`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={onAddKeyframe}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${subtleSurface} hover:border-amber-500`}
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-500" />
                    <span>Add Keyframe</span>
                  </button>

                  <button
                    type="button"
                    onClick={onToggleUseKeyframes}
                    disabled={keyframes.length < 2}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40 ${
                      useKeyframes
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : `border ${subtleSurface} hover:border-amber-500`
                    }`}
                  >
                    {useKeyframes ? 'Path: On' : 'Path: Off'}
                  </button>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.showCameraPath}
                    onClick={() => onSettingsChange({ showCameraPath: !settings.showCameraPath })}
                    title="Show dashed 3D camera spline preview (auto-hidden in CinemaHUD & export)"
                    className={`px-2 py-1 rounded-md border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      settings.showCameraPath
                        ? 'bg-sky-600/80 border-sky-500 text-white'
                        : `${subtleSurface} ${mutedText} hover:border-sky-500`
                    }`}
                  >
                    3D Preview
                  </button>
                </div>
              </div>

              {/* Row 2: Cinematic Easing, Spline Tension, Orbit Inertia, Lens Focal Length & Keyframe Nodes */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-1.5 border-t border-slate-800/50">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {/* Easing Selector */}
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[11px] font-medium ${mutedText}`}>Easing</span>
                    <div
                      className={`flex items-center p-0.5 rounded-md border ${subtleSurface}`}
                      role="group"
                      aria-label="Camera spline easing"
                    >
                      {(
                        [
                          { id: 'linear', label: 'Linear' },
                          { id: 'smooth-s', label: 'Smooth S' },
                          { id: 'ease-in', label: 'Ease In' },
                          { id: 'ease-out', label: 'Ease Out' },
                        ] as Array<{ id: CameraEasingMode; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => onSettingsChange({ cameraEasing: opt.id })}
                          className={`px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                            settings.cameraEasing === opt.id
                              ? 'bg-sky-600 text-white'
                              : `${mutedText} hover:text-sky-500`
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Spline Tension */}
                  <label
                    className="flex items-center gap-1.5 text-[11px]"
                    title="Catmull-Rom spline tension (0.50 = pure centripetal, 1.00 = taut chord)"
                  >
                    <span className={`font-medium whitespace-nowrap ${mutedText}`}>Tension</span>
                    <input
                      type="range"
                      aria-label="Camera spline tension"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.cameraTension}
                      onChange={(e) => onSettingsChange({ cameraTension: Number(e.target.value) })}
                      className="aero-slider w-12"
                    />
                    <span className="font-mono-tabular font-semibold w-7 text-right">
                      {settings.cameraTension.toFixed(2)}
                    </span>
                  </label>

                  {/* Orbit Inertia / Damping */}
                  <label
                    className="flex items-center gap-1.5 text-[11px]"
                    title="OrbitControls damping factor (lower = heavier cinematic glide inertia)"
                  >
                    <span className={`font-medium whitespace-nowrap ${mutedText}`}>Inertia</span>
                    <input
                      type="range"
                      aria-label="Orbit inertia damping"
                      min={0.02}
                      max={0.2}
                      step={0.01}
                      value={settings.orbitDamping}
                      onChange={(e) => onSettingsChange({ orbitDamping: Number(e.target.value) })}
                      className="aero-slider w-12"
                    />
                    <span className="font-mono-tabular font-semibold w-7 text-right">
                      {settings.orbitDamping.toFixed(2)}
                    </span>
                  </label>

                  {/* Focal Length / Lens (24mm..85mm) */}
                  <label
                    className="flex items-center gap-1.5 text-[11px]"
                    title={`Full-frame 35mm equivalent focal length (${Math.round(focalLengthMmToFovDeg(settings.focalLengthMm))}° vertical FOV)`}
                  >
                    <span className={`font-medium whitespace-nowrap ${mutedText}`}>Lens</span>
                    <input
                      type="range"
                      aria-label="Camera focal length millimeters"
                      min={24}
                      max={85}
                      step={1}
                      value={settings.focalLengthMm}
                      onChange={(e) => onSettingsChange({ focalLengthMm: Number(e.target.value) })}
                      className="aero-slider w-14"
                    />
                    <span className="font-mono-tabular font-semibold w-10 text-right">
                      {settings.focalLengthMm}mm
                    </span>
                  </label>
                </div>

                {/* Keyframe Pill Strip */}
                <div className="flex items-center gap-1 max-w-[260px] overflow-x-auto">
                  {keyframes.map((kf) => (
                    <div
                      key={kf.id}
                      className={`flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded border text-[10px] font-mono-tabular shrink-0 ${subtleSurface}`}
                    >
                      <button
                        type="button"
                        onClick={() => onJumpToKeyframe(kf)}
                        title={kf.label}
                        className="hover:text-sky-500 cursor-pointer"
                      >
                        {formatUtcTime(kf.timeSec)}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteKeyframe(kf.id)}
                        aria-label={`Delete keyframe at ${formatUtcTime(kf.timeSec)}`}
                        className="p-0.5 text-slate-400 hover:text-rose-500 cursor-pointer"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'traffic' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                {/* Active Now / All in Log Filter */}
                <div
                  className={`flex items-center p-0.5 rounded-lg border shrink-0 ${subtleSurface}`}
                  role="group"
                  aria-label="Traffic visibility filter"
                >
                  <button
                    type="button"
                    onClick={() => setTrafficFilter('active')}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      trafficFilter === 'active'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    Active Now ({activeCallsigns.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setTrafficFilter('all')}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      trafficFilter === 'all'
                        ? 'bg-sky-600 text-white'
                        : `${mutedText} hover:text-sky-500`
                    }`}
                  >
                    All in Log ({tracks.length})
                  </button>
                </div>

                <button
                  type="button"
                  disabled={!selectedCallsign}
                  onClick={onToggleFollow}
                  title="Free-orbit follow camera: smoothly tracks aircraft displacement while allowing full 360° orbit and zoom"
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40 ${
                    followSelected && selectedCallsign
                      ? 'bg-sky-600 text-white'
                      : `border ${subtleSurface} hover:border-sky-500`
                  }`}
                >
                  <Crosshair className="w-3.5 h-3.5" />
                  <span>
                    {followSelected && selectedCallsign
                      ? `Following ${selectedCallsign}`
                      : selectedCallsign
                        ? `Follow ${selectedCallsign}`
                        : 'Select Aircraft to Follow'}
                  </span>
                </button>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap max-h-[64px] overflow-y-auto">
                {visibleTracks.length === 0 ? (
                  <span className={`text-xs ${mutedText}`}>
                    {tracks.length === 0
                      ? 'No aircraft tracks in current log. Import a full EuroScope FSD log or load UWGG demo.'
                      : 'No airborne aircraft at this timestamp. Scrub timeline or switch to "All in Log".'}
                  </span>
                ) : (
                  visibleTracks.map((tr) => {
                    const isSel = selectedCallsign === tr.callsign;
                    const isActive = activeCallsignSet.has(tr.callsign);
                    return (
                      <button
                        key={tr.callsign}
                        type="button"
                        onClick={() => onSelectAircraft(isSel ? null : tr.callsign)}
                        className={`px-2.5 py-1 rounded-md border font-mono-tabular text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          isSel
                            ? 'bg-sky-600 border-sky-500 text-white'
                            : `${subtleSurface} hover:border-sky-500 ${isActive ? '' : 'opacity-60'}`
                        }`}
                      >
                        {tr.callsign}
                        {tr.flightPlan?.destination && (
                          <span className="ml-1.5 opacity-70 text-[10px]">
                            {tr.flightPlan.destination}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {activeTab === 'layers' && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    { key: 'hideGroundTraffic', label: 'Hide Ground Traffic' },
                    { key: 'showBaseMap', label: 'Base Map' },
                    { key: 'showUrbanGlow', label: 'City Lights' },
                    { key: 'showCityRoads', label: 'City Roads' },
                    { key: 'showVolumes', label: '3D Sectors' },
                    { key: 'showSectorFill', label: 'Solid Fill' },
                    { key: 'showAirways', label: 'Airways & Runways' },
                    { key: 'showRestricted', label: 'Restricted Zones' },
                    { key: 'showWaypoints', label: 'Waypoints' },
                    { key: 'showLabels', label: 'Datablocks' },
                    { key: 'showDropStems', label: 'Drop Stems' },
                  ] as const
                ).map(({ key, label }) => {
                  const active = settings[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      role="switch"
                      aria-checked={active}
                      onClick={() => onSettingsChange({ [key]: !active })}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        active
                          ? 'bg-sky-600 border-sky-500 text-white'
                          : `${subtleSurface} ${mutedText} hover:border-sky-500`
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}

                {cityLabels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setCityFilterOpen((v) => !v);
                      setWaypointFilterOpen(false);
                      setSectorEditorOpen(false);
                    }}
                    aria-expanded={cityFilterOpen}
                    className={`ml-auto px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      cityFilterOpen
                        ? 'bg-emerald-500/20 border-emerald-500/70 text-emerald-300'
                        : `${subtleSurface} ${mutedText} hover:border-emerald-500/70`
                    }`}
                  >
                    Filter Cities ({cityLabels.length})
                  </button>
                )}

                {waypoints.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setWaypointFilterOpen((v) => !v);
                      setCityFilterOpen(false);
                      setSectorEditorOpen(false);
                    }}
                    aria-expanded={waypointFilterOpen}
                    className={`${cityLabels.length === 0 ? 'ml-auto ' : ''}px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      waypointFilterOpen
                        ? 'bg-sky-500/20 border-sky-500/70 text-sky-300'
                        : `${subtleSurface} ${mutedText} hover:border-sky-500/70`
                    }`}
                  >
                    Filter Points ({waypoints.length})
                  </button>
                )}

                {volumes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSectorEditorOpen((v) => !v);
                      setWaypointFilterOpen(false);
                      setCityFilterOpen(false);
                    }}
                    aria-expanded={sectorEditorOpen}
                    className={`${cityLabels.length === 0 && waypoints.length === 0 ? 'ml-auto ' : ''}px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      sectorEditorOpen
                        ? 'bg-amber-500/20 border-amber-500/70 text-amber-300'
                        : `${subtleSurface} ${mutedText} hover:border-amber-500/70`
                    }`}
                  >
                    Sector Altitudes ({volumes.length})
                  </button>
                )}
              </div>

              {/* Waypoint Category Tiers, Secondary Airports & City Label Filter Row */}
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/50">
                <span className={`text-[11px] font-medium ${mutedText}`}>Points</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.showEnrouteFixes}
                  onClick={() => onSettingsChange({ showEnrouteFixes: !settings.showEnrouteFixes })}
                  className={`px-2 py-0.5 rounded-md border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    settings.showEnrouteFixes
                      ? 'bg-sky-600/80 border-sky-500 text-white'
                      : `${subtleSurface} ${mutedText} hover:border-sky-500`
                  }`}
                >
                  Enroute / STAR Fixes
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.showApproachFixes}
                  title="Technical runway/localizer/approach fixes (auto-hidden via Zoom LOD when zoomed out)"
                  onClick={() =>
                    onSettingsChange({ showApproachFixes: !settings.showApproachFixes })
                  }
                  className={`px-2 py-0.5 rounded-md border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    settings.showApproachFixes
                      ? 'bg-sky-600/80 border-sky-500 text-white'
                      : `${subtleSurface} ${mutedText} hover:border-sky-500`
                  }`}
                >
                  Approach Fixes (Auto LOD)
                </button>

                <div className="flex items-center gap-1.5 ml-1">
                  <span className={`text-[11px] font-medium ${mutedText}`}>
                    Secondary Airports
                  </span>
                  <div
                    className={`flex items-center p-0.5 rounded-md border ${subtleSurface}`}
                    role="group"
                    aria-label="Secondary airports display mode"
                  >
                    {(
                      [
                        { id: 'hidden', label: 'Off' },
                        { id: 'dimmed', label: 'Dim' },
                        { id: 'bright', label: 'On' },
                      ] as Array<{ id: SecondaryAirportsMode; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => onSettingsChange({ secondaryAirportsMode: opt.id })}
                        className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors cursor-pointer ${
                          settings.secondaryAirportsMode === opt.id
                            ? 'bg-sky-600 text-white'
                            : `${mutedText} hover:text-sky-500`
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* City Labels Filter: All / Major / Off */}
                <div className="flex items-center gap-1.5 ml-1">
                  <span className={`text-[11px] font-medium ${mutedText}`}>Cities</span>
                  <div
                    className={`flex items-center p-0.5 rounded-md border ${subtleSurface}`}
                    role="group"
                    aria-label="City labels display mode"
                  >
                    {(
                      [
                        { id: 'all', label: 'All' },
                        { id: 'major', label: 'Major' },
                        { id: 'off', label: 'Off' },
                      ] as Array<{ id: CityLabelsMode; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => onSettingsChange({ cityLabelsMode: opt.id })}
                        className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors cursor-pointer ${
                          settings.cityLabelsMode === opt.id
                            ? 'bg-sky-600 text-white'
                            : `${mutedText} hover:text-sky-500`
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {cityFilterOpen && cityLabels.length > 0 && (
                <div
                  className={`pt-2 border-t flex flex-col gap-1.5 ${
                    isDark ? 'border-slate-800/80' : 'border-slate-300'
                  }`}
                  data-testid="cities-filter-editor"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[10px] ${mutedText}`}>
                      Toggle individual map city labels (overrides {settings.cityLabelsMode} mode)
                    </span>
                    {Object.keys(settings.cityLabelOverrides).length > 0 && (
                      <button
                        type="button"
                        onClick={() => onSettingsChange({ cityLabelOverrides: {} })}
                        className={`px-2 py-0.5 rounded-md border text-[10px] font-medium cursor-pointer ${subtleSurface} hover:border-amber-500`}
                      >
                        Reset ({Object.keys(settings.cityLabelOverrides).length})
                      </button>
                    )}
                  </div>
                  <div className="max-h-[96px] overflow-y-auto grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-1">
                    {cityLabels.map((city) => {
                      const checked = shouldShowGroundLabel(
                        city,
                        settings.cityLabelsMode,
                        settings.cityLabelOverrides,
                      );
                      const isMajor = city.placeTier !== 'minor';
                      return (
                        <label
                          key={city.id}
                          className={`flex items-center justify-between gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono-tabular cursor-pointer ${
                            checked ? subtleSurface : `${subtleSurface} opacity-50`
                          }`}
                        >
                          <span className="flex items-center gap-1 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                onSettingsChange({
                                  cityLabelOverrides: {
                                    ...settings.cityLabelOverrides,
                                    [city.id]: e.target.checked,
                                  },
                                })
                              }
                              className="accent-emerald-500 cursor-pointer"
                            />
                            <span className="truncate font-semibold">{city.text}</span>
                          </span>
                          <span
                            className={`text-[8px] uppercase ${
                              isMajor ? 'text-emerald-400' : mutedText
                            }`}
                          >
                            {isMajor ? 'MAJOR' : 'TOWN'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {waypointFilterOpen && waypoints.length > 0 && (
                <div
                  className={`pt-2 border-t flex flex-col gap-1.5 ${
                    isDark ? 'border-slate-800/80' : 'border-slate-300'
                  }`}
                  data-testid="waypoints-filter-editor"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      aria-label="Search waypoints"
                      value={waypointSearch}
                      onChange={(e) => setWaypointSearch(e.target.value)}
                      placeholder="Filter .sct points (e.g. USTOK, GG039, XUDK)..."
                      className={`flex-1 max-w-[280px] px-2 py-1 rounded-md border text-[11px] font-mono-tabular outline-none ${
                        isDark
                          ? 'bg-slate-950 border-slate-700 text-slate-100 placeholder:text-slate-500 focus:border-sky-500'
                          : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-sky-500'
                      }`}
                    />
                    {Object.keys(settings.waypointOverrides).length > 0 && (
                      <button
                        type="button"
                        onClick={() => onSettingsChange({ waypointOverrides: {} })}
                        className={`px-2 py-1 rounded-md border text-[10px] font-medium cursor-pointer ${subtleSurface} hover:border-amber-500`}
                      >
                        Reset Overrides ({Object.keys(settings.waypointOverrides).length})
                      </button>
                    )}
                  </div>
                  <div className="max-h-[104px] overflow-y-auto grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-7 gap-1">
                    {waypoints
                      .filter((wp) => {
                        const q = waypointSearch.trim().toUpperCase();
                        return !q || wp.id.toUpperCase().includes(q);
                      })
                      .slice(0, 120)
                      .map((wp) => {
                        const cat = classifyWaypoint(wp, airportCode, airportCenter);
                        const defaultOn =
                          cat === 'primary_airport'
                            ? true
                            : cat === 'secondary_airport'
                              ? settings.secondaryAirportsMode !== 'hidden'
                              : cat === 'approach_fix'
                                ? settings.showApproachFixes
                                : settings.showEnrouteFixes;
                        const checked =
                          settings.waypointOverrides[wp.id] !== undefined
                            ? settings.waypointOverrides[wp.id]
                            : defaultOn;
                        const badge =
                          cat === 'primary_airport'
                            ? 'MAIN'
                            : cat === 'secondary_airport'
                              ? 'APT'
                              : cat === 'approach_fix'
                                ? 'APP'
                                : 'FIX';
                        return (
                          <label
                            key={wp.id}
                            className={`flex items-center justify-between gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono-tabular cursor-pointer ${
                              checked ? subtleSurface : `${subtleSurface} opacity-50`
                            }`}
                          >
                            <span className="flex items-center gap-1 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) =>
                                  onSettingsChange({
                                    waypointOverrides: {
                                      ...settings.waypointOverrides,
                                      [wp.id]: e.target.checked,
                                    },
                                  })
                                }
                                className="accent-sky-500 cursor-pointer"
                              />
                              <span className="truncate font-semibold">{wp.id}</span>
                            </span>
                            <span className={`text-[8px] uppercase ${mutedText}`}>{badge}</span>
                          </label>
                        );
                      })}
                  </div>
                </div>
              )}

              {sectorEditorOpen && volumes.length > 0 && (
                <div
                  className={`pt-2 border-t max-h-[132px] overflow-y-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 ${
                    isDark ? 'border-slate-800/80' : 'border-slate-300'
                  }`}
                  data-testid="sector-altitudes-editor"
                >
                  {volumes.map((vol) => (
                    <div
                      key={vol.id}
                      className={`flex items-center justify-between gap-2 px-2 py-1 rounded-md border text-[11px] ${subtleSurface}`}
                    >
                      <span
                        className="font-mono-tabular font-semibold truncate max-w-[115px]"
                        title={`${vol.name} (${vol.kind})`}
                      >
                        {vol.name}
                      </span>
                      <div className="flex items-center gap-1 shrink-0 font-mono-tabular">
                        <input
                          type="number"
                          aria-label={`${vol.name} floor feet`}
                          step={500}
                          min={0}
                          max={60000}
                          value={Math.round(vol.floorFt)}
                          onChange={(e) => {
                            const nextFloor = Math.max(0, Number(e.target.value) || 0);
                            onUpdateVolumeBounds(
                              vol.id,
                              nextFloor,
                              Math.max(nextFloor + 500, vol.ceilingFt),
                            );
                          }}
                          className={`w-[58px] px-1 py-0.5 rounded border text-[10px] text-right outline-none ${
                            isDark
                              ? 'bg-slate-950 border-slate-700 text-slate-100 focus:border-sky-500'
                              : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-sky-500'
                          }`}
                        />
                        <span className={mutedText}>–</span>
                        <input
                          type="number"
                          aria-label={`${vol.name} ceiling feet`}
                          step={500}
                          min={500}
                          max={66000}
                          value={Math.round(vol.ceilingFt)}
                          onChange={(e) => {
                            const nextCeil = Math.max(
                              vol.floorFt + 500,
                              Number(e.target.value) || 500,
                            );
                            onUpdateVolumeBounds(vol.id, vol.floorFt, nextCeil);
                          }}
                          className={`w-[58px] px-1 py-0.5 rounded border text-[10px] text-right outline-none ${
                            isDark
                              ? 'bg-slate-950 border-slate-700 text-slate-100 focus:border-sky-500'
                              : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-sky-500'
                          }`}
                        />
                        <span className={`text-[9px] ${mutedText}`}>ft</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {runwayProcedures && runwayProcedures.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/50">
                  <span className={`text-[11px] font-medium ${mutedText}`}>Procedures</span>
                  {runwayProcedures.map((rp) => {
                    const sidKey = `${rp.runway}:SID`;
                    const starKey = `${rp.runway}:STAR`;
                    const sidOn = settings.procedureVisibility[sidKey] !== false;
                    const starOn = settings.procedureVisibility[starKey] !== false;
                    const toggleProc = (procKey: string, current: boolean) => {
                      onSettingsChange({
                        procedureVisibility: {
                          ...settings.procedureVisibility,
                          [procKey]: !current,
                        },
                      });
                    };
                    return (
                      <div
                        key={rp.runway}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] ${subtleSurface}`}
                      >
                        <span className={`font-mono-tabular font-semibold mr-0.5 ${mutedText}`}>
                          RWY {rp.runway}
                        </span>
                        {rp.hasSid && (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={sidOn}
                            onClick={() => toggleProc(sidKey, sidOn)}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                              sidOn
                                ? 'bg-sky-500/25 text-sky-300 border border-sky-500/60'
                                : `${mutedText} opacity-60 hover:opacity-100`
                            }`}
                          >
                            SID
                          </button>
                        )}
                        {rp.hasStar && (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={starOn}
                            onClick={() => toggleProc(starKey, starOn)}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                              starOn
                                ? 'bg-amber-500/25 text-amber-300 border border-amber-500/60'
                                : `${mutedText} opacity-60 hover:opacity-100`
                            }`}
                          >
                            STAR
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
