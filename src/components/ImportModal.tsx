import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Filter,
  Globe,
  Loader2,
  Map as MapIcon,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  AirspaceDataset,
  BaseMapData,
  GeoPoint,
  RadarDataset,
  ThemePreset,
} from '../types/radar';
import { LocalENUProjector } from '../core/geo';
import { parseEuroScopeFsdLog } from '../core/fsdParser';
import {
  buildFilteredAirspaceFromCatalog,
  inspectEuroScopeFiles,
  selectDefaultVolumesForAirport,
  type EuroScopeCatalog,
} from '../core/sectorParser';
import { parseGeoJsonBaseMap } from '../core/airspaceZones';

interface ImportModalProps {
  open: boolean;
  theme: ThemePreset;
  currentRadar: RadarDataset;
  currentAirspace: AirspaceDataset;
  customTitle: string;
  osmStatus: 'idle' | 'loading' | 'indexeddb' | 'openfreemap' | 'overpass' | 'error';
  osmDetail: string | null;
  onClose: () => void;
  onUpdateCustomTitle: (title: string) => void;
  onUpdateTargetAirportCode: (code: string) => void;
  onLoadRadar: (radar: RadarDataset) => void;
  onLoadAirspace: (airspace: AirspaceDataset, radiusKm?: number) => void;
  onLoadBaseMap: (baseMap: BaseMapData) => void;
  onReloadOsmTerrain: (center: GeoPoint, radiusKm: number, airportCode: string) => void;
  onResetDemo: () => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  open,
  theme,
  currentRadar,
  currentAirspace,
  customTitle,
  osmStatus,
  osmDetail,
  onClose,
  onUpdateCustomTitle,
  onUpdateTargetAirportCode,
  onLoadRadar,
  onLoadAirspace,
  onLoadBaseMap,
  onReloadOsmTerrain,
  onResetDemo,
}) => {
  const [sctBuffer, setSctBuffer] = useState<string>('');
  const [eseBuffer, setEseBuffer] = useState<string>('');
  const [sctFileName, setSctFileName] = useState<string>('');
  const [eseFileName, setEseFileName] = useState<string>('');
  const [catalog, setCatalog] = useState<EuroScopeCatalog | null>(null);
  const [targetAirportCode, setTargetAirportCode] = useState<string>(currentAirspace.airportCode);
  const [radiusKm, setRadiusKm] = useState<number>(150);
  const [enabledVolumeIds, setEnabledVolumeIds] = useState<Set<string>>(() => new Set());
  const [filterTitle, setFilterTitle] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const selectedAirportCenter = useMemo<GeoPoint>(() => {
    if (!catalog) return currentAirspace.center;
    const found = catalog.airports.find((a) => a.code === targetAirportCode);
    return found ? { lat: found.lat, lon: found.lon } : catalog.infoCenter;
  }, [catalog, targetAirportCode, currentAirspace.center]);

  const candidateVolumes = useMemo(() => {
    if (!catalog) return [];
    const upper = targetAirportCode.toUpperCase();
    return catalog.volumes
      .map((vol) => {
        const anyClose = vol.polygon.some(
          (p) => LocalENUProjector.distanceKm(selectedAirportCenter, p) <= radiusKm * 1.5,
        );
        const matchesCode = vol.name.toUpperCase().includes(upper);
        const first = vol.polygon[0];
        const approxDist = first ? LocalENUProjector.distanceKm(selectedAirportCenter, first) : 9999;
        return { vol, anyClose, matchesCode, approxDist };
      })
      .filter((item) => item.anyClose || item.matchesCode || enabledVolumeIds.has(item.vol.id))
      .sort((a, b) => {
        if (a.matchesCode !== b.matchesCode) return a.matchesCode ? -1 : 1;
        return a.approxDist - b.approxDist;
      });
  }, [catalog, targetAirportCode, selectedAirportCenter, radiusKm, enabledVolumeIds]);

  if (!open) return null;

  const isDark = theme === 'cinematic-dark';
  const surfaceCls = isDark
    ? 'bg-slate-950 border-slate-800 text-slate-100'
    : 'bg-white border-slate-300 text-slate-900';
  const cardCls = isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200';
  const inputCls = isDark
    ? 'bg-slate-950 border-slate-700 text-slate-100 focus:border-sky-500'
    : 'bg-white border-slate-300 text-slate-900 focus:border-sky-500';
  const mutedCls = isDark ? 'text-slate-400' : 'text-slate-600';

  const handleFsdFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseEuroScopeFsdLog(text, file.name, currentAirspace.center);
    if (parsed.tracks.length > 0) {
      onLoadRadar(parsed);
      const ctrlEvs = parsed.diagnostics.controllerEvents ?? 0;
      setStatusMsg({
        kind: 'ok',
        text: `Loaded ${parsed.tracks.length} aircraft tracks (${parsed.diagnostics.pilotPackets} radar hits, ${ctrlEvs} ATC handoff/ownership events) from ${file.name}.`,
      });
    } else {
      setStatusMsg({
        kind: 'warn',
        text:
          parsed.diagnostics.warnings[0] ??
          `No pilot tracks found in ${file.name}. Keeping current radar traffic active.`,
      });
    }
  };

  const inspectAndPrepareFilter = (nextSct: string, nextEse: string, fileName: string) => {
    const inspected = inspectEuroScopeFiles(nextSct, nextEse, currentAirspace.center);
    setCatalog(inspected);

    // Prefer the airport matching the currently active airport if present, otherwise [INFO] / first airport
    const preferredApt =
      inspected.airports.find((a) => a.code === currentAirspace.airportCode) ??
      inspected.airports.find((a) => a.code === inspected.infoAirportCode) ??
      inspected.airports[0];
    const aptCode = preferredApt?.code ?? inspected.infoAirportCode;
    const aptCenter = preferredApt
      ? { lat: preferredApt.lat, lon: preferredApt.lon }
      : inspected.infoCenter;
    const defaultVols = selectDefaultVolumesForAirport(inspected, aptCode, aptCenter, radiusKm);
    const defaultTitle = `${aptCode} · ${inspected.defaultTitle}`;

    setTargetAirportCode(aptCode);
    setEnabledVolumeIds(defaultVols);
    setFilterTitle(defaultTitle);

    setStatusMsg({
      kind: 'ok',
      text: `Indexed ${fileName}: ${inspected.airports.length} airports, ${inspected.volumes.length} sectors, ${inspected.procedures.length} SID/STAR routes. Review filter below and click Apply Airspace Filter.`,
    });
  };

  const handleSectorFile = async (file: File) => {
    const text = await file.text();
    const lower = file.name.toLowerCase();
    let nextSct = sctBuffer;
    let nextEse = eseBuffer;
    if (lower.endsWith('.ese')) {
      nextEse = text;
      setEseBuffer(text);
      setEseFileName(file.name);
    } else {
      nextSct = text;
      setSctBuffer(text);
      setSctFileName(file.name);
    }

    if (nextSct || nextEse) {
      inspectAndPrepareFilter(nextSct, nextEse, file.name);
    }
  };

  const handleAirportChange = (nextCode: string) => {
    setTargetAirportCode(nextCode);
    if (!catalog) return;
    const apt = catalog.airports.find((a) => a.code === nextCode);
    const center = apt ? { lat: apt.lat, lon: apt.lon } : catalog.infoCenter;
    setEnabledVolumeIds(selectDefaultVolumesForAirport(catalog, nextCode, center, radiusKm));
    setFilterTitle(`${nextCode} · ${catalog.defaultTitle}`);
  };

  const handleApplyCatalogFilter = () => {
    if (!catalog) return;
    const filtered = buildFilteredAirspaceFromCatalog(catalog, {
      targetAirportCode,
      radiusKm,
      enabledVolumeIds,
      customTitle: filterTitle.trim() || catalog.defaultTitle,
      maxWaypoints: 46,
    });
    onUpdateCustomTitle(filterTitle.trim());
    onLoadAirspace(filtered, radiusKm);
    setStatusMsg({
      kind: 'ok',
      text: `Applied ${filtered.airportCode} (${radiusKm} km): ${filtered.volumes.length} sectors, ${filtered.waypoints.length} deduplicated fixes, ${filtered.runwayProcedures?.length ?? 0} runways with SID/STAR. Loading OpenFreeMap terrain...`,
    });
  };

  const toggleVolume = (volId: string) => {
    setEnabledVolumeIds((prev) => {
      const next = new Set(prev);
      if (next.has(volId)) next.delete(volId);
      else next.add(volId);
      return next;
    });
  };

  const handleGeoJsonFile = async (file: File) => {
    try {
      const text = await file.text();
      const baseMap = parseGeoJsonBaseMap(text, file.name, currentAirspace.center);
      const holeCount = baseMap.polygons.reduce((acc, p) => acc + (p.holes?.length ?? 0), 0);
      if (
        baseMap.polygons.length > 0 ||
        baseMap.polylines.length > 0 ||
        baseMap.labels.length > 0
      ) {
        onLoadBaseMap(baseMap);
        setStatusMsg({
          kind: 'ok',
          text: `Loaded GeoJSON "${file.name}": ${baseMap.polygons.length} polygons${holeCount > 0 ? ` (${holeCount} holes)` : ''}, ${baseMap.polylines.length} rivers/shores, ${baseMap.labels.length} city labels.`,
        });
      } else {
        setStatusMsg({
          kind: 'warn',
          text: `Parsed ${file.name}, but no GeoJSON geometry intersected within 650 km of ${currentAirspace.airportCode} center (${currentAirspace.center.lat.toFixed(2)}, ${currentAirspace.center.lon.toFixed(2)}). Check coordinate order [lon, lat].`,
        });
      }
    } catch (err) {
      setStatusMsg({
        kind: 'warn',
        text: `Invalid GeoJSON file (${err instanceof Error ? err.message : 'parse error'}).`,
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-modal-title"
    >
      <div
        className={`w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl border shadow-2xl overflow-hidden ${surfaceCls}`}
      >
        <div
          className={`px-5 py-3.5 border-b flex items-center justify-between shrink-0 ${
            isDark ? 'border-slate-800' : 'border-slate-200'
          }`}
        >
          <h2 id="import-modal-title" className="text-base font-semibold">
            Import Radar Log, Airspace Filter & Map Terrain
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import dialog"
            className="p-1.5 rounded-md hover:bg-slate-500/15 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3.5 overflow-y-auto flex-1">
          {/* Scene HUD Title & Target Airport ICAO Override */}
          <div className={`p-3 rounded-lg border grid grid-cols-1 sm:grid-cols-[1fr_170px] gap-2.5 ${cardCls}`}>
            <label className="flex flex-col gap-1 text-xs">
              <span className="flex items-center gap-1.5 font-medium">
                <SlidersHorizontal className="w-3.5 h-3.5 text-sky-400" />
                <span>Cinema HUD Title</span>
              </span>
              <input
                type="text"
                value={customTitle}
                onChange={(e) => onUpdateCustomTitle(e.target.value)}
                placeholder={currentAirspace.name}
                className={`px-2.5 py-1.5 rounded-md border text-xs outline-none ${inputCls}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Target Airport (ICAO)</span>
              <input
                type="text"
                maxLength={6}
                aria-label="Target Airport ICAO"
                value={currentAirspace.airportCode}
                onChange={(e) =>
                  onUpdateTargetAirportCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                }
                placeholder="UWGG"
                className={`px-2.5 py-1.5 rounded-md border font-mono-tabular uppercase text-xs outline-none ${inputCls}`}
              />
            </label>
          </div>

          {/* Radar FSD Log Upload */}
          <div className={`p-3.5 rounded-lg border ${cardCls}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 font-medium text-sm">
                  <FileText className="w-4 h-4 text-sky-500" />
                  <span>EuroScope FSD Radar Log (.txt)</span>
                </div>
                <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
                  Parses [HH:MM:SS] timestamps, @N:/^ pilot packets, PBH heading bitfields, $FP
                  flight plans, and ATC ownership ($CQ IT/DR, $HA, $CR WH, #PC CCP, CSV col 8).
                </p>
              </div>
              <label className="shrink-0 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium cursor-pointer whitespace-nowrap">
                Select .txt
                <input
                  type="file"
                  accept=".txt,.log,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFsdFile(f);
                  }}
                />
              </label>
            </div>
            <div className={`mt-2 text-[11px] font-mono-tabular ${mutedCls}`}>
              Active: {currentRadar.sourceName} · {currentRadar.tracks.length} tracks ·{' '}
              {currentRadar.diagnostics.pilotPackets} hits ·{' '}
              {currentRadar.diagnostics.controllerEvents ?? 0} ATC handoffs
            </div>
          </div>

          {/* EuroScope Sector Files (.sct / .ese) + Interactive Smart Filter */}
          <div className={`p-3.5 rounded-lg border ${cardCls}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 font-medium text-sm">
                  <MapIcon className="w-4 h-4 text-amber-500" />
                  <span>EuroScope Airspace (.sct / .ese)</span>
                </div>
                <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
                  Upload .sct and/or .ese to filter by target airport, radius, and specific 3D
                  sectors. Automatically deduplicates stacked fixes and groups SID/STAR by runway.
                </p>
              </div>
              <label className="shrink-0 px-3 py-1.5 rounded-lg border border-sky-600 text-sky-400 hover:bg-sky-600/10 text-xs font-medium cursor-pointer whitespace-nowrap">
                Select .sct / .ese
                <input
                  type="file"
                  accept=".sct,.ese,.sct2"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleSectorFile(f);
                  }}
                />
              </label>
            </div>

            <div className={`mt-2 text-[11px] font-mono-tabular ${mutedCls}`}>
              Active: {currentAirspace.name} · {currentAirspace.volumes.length} sectors ·{' '}
              {currentAirspace.waypoints.length} fixes
              {sctFileName ? ` · SCT: ${sctFileName}` : ''}
              {eseFileName ? ` · ESE: ${eseFileName}` : ''}
            </div>

            {/* Smart Filter Drawer (appears immediately when .sct or .ese is loaded) */}
            {catalog && (
              <div
                className={`mt-3 pt-3 border-t space-y-3 ${
                  isDark ? 'border-slate-800' : 'border-slate-200'
                }`}
                data-testid="euroscope-filter-panel"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                    <Filter className="w-3.5 h-3.5" />
                    <span>Smart Sector Filter</span>
                  </div>
                  <span className={`text-[11px] font-mono-tabular ${mutedCls}`}>
                    {enabledVolumeIds.size} of {catalog.volumes.length} sectors selected
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {/* Target Airport Picker */}
                  <label className="flex flex-col gap-1 text-[11px]">
                    <span className={mutedCls}>Target Airport</span>
                    <select
                      value={targetAirportCode}
                      onChange={(e) => handleAirportChange(e.target.value)}
                      className={`px-2.5 py-1.5 rounded-md border text-xs outline-none ${inputCls}`}
                    >
                      {catalog.airports.length > 0 ? (
                        catalog.airports.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} {a.frequency ? `(${a.frequency})` : ''}
                          </option>
                        ))
                      ) : (
                        <option value={catalog.infoAirportCode}>{catalog.infoAirportCode}</option>
                      )}
                    </select>
                  </label>

                  {/* Radius Slider */}
                  <label className="flex flex-col gap-1 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span className={mutedCls}>Crop Radius</span>
                      <span className="font-mono-tabular font-semibold">{radiusKm} km</span>
                    </div>
                    <input
                      type="range"
                      min={60}
                      max={300}
                      step={10}
                      value={radiusKm}
                      onChange={(e) => setRadiusKm(Number(e.target.value))}
                      className="aero-slider w-full mt-1"
                    />
                  </label>
                </div>

                {/* Editable Clean Title */}
                <label className="flex flex-col gap-1 text-[11px]">
                  <span className={mutedCls}>Region Title for HUD</span>
                  <input
                    type="text"
                    value={filterTitle}
                    onChange={(e) => setFilterTitle(e.target.value)}
                    className={`px-2.5 py-1.5 rounded-md border text-xs outline-none ${inputCls}`}
                  />
                </label>

                {/* Sector Volumes Checklist */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-[11px] font-medium ${mutedCls}`}>
                      3D Sector Volumes (unchecked FIRs are excluded)
                    </span>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() =>
                          setEnabledVolumeIds(
                            selectDefaultVolumesForAirport(
                              catalog,
                              targetAirportCode,
                              selectedAirportCenter,
                              radiusKm,
                            ),
                          )
                        }
                        className="text-sky-400 hover:underline cursor-pointer"
                      >
                        Local Only
                      </button>
                      <span className={mutedCls}>·</span>
                      <button
                        type="button"
                        onClick={() =>
                          setEnabledVolumeIds(new Set(candidateVolumes.map((v) => v.vol.id)))
                        }
                        className="text-sky-400 hover:underline cursor-pointer"
                      >
                        All Near
                      </button>
                      <span className={mutedCls}>·</span>
                      <button
                        type="button"
                        onClick={() => setEnabledVolumeIds(new Set())}
                        className="text-slate-400 hover:underline cursor-pointer"
                      >
                        None
                      </button>
                    </div>
                  </div>

                  <div
                    className={`max-h-36 overflow-y-auto rounded-md border p-2 grid grid-cols-1 sm:grid-cols-2 gap-1 ${
                      isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'
                    }`}
                  >
                    {candidateVolumes.length === 0 ? (
                      <div className={`text-xs col-span-2 py-2 text-center ${mutedCls}`}>
                        No sector polygons found within {radiusKm} km. Increase radius or pick
                        another airport.
                      </div>
                    ) : (
                      candidateVolumes.map(({ vol }) => {
                        const checked = enabledVolumeIds.has(vol.id);
                        return (
                          <label
                            key={vol.id}
                            className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] cursor-pointer ${
                              checked
                                ? isDark
                                  ? 'bg-sky-950/60 text-sky-200'
                                  : 'bg-sky-50 text-sky-900'
                                : mutedCls
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleVolume(vol.id)}
                              className="accent-sky-500 cursor-pointer"
                            />
                            <span className="truncate font-mono-tabular">{vol.name}</span>
                            <span className="ml-auto text-[10px] opacity-65 shrink-0">
                              {vol.shortCode}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleApplyCatalogFilter}
                    className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold cursor-pointer"
                  >
                    Apply Airspace Filter
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* OpenFreeMap Vector Tiles Dark Terrain & Manual GeoJSON Override */}
          <div className={`p-3.5 rounded-lg border ${cardCls}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <Globe className="w-4 h-4 text-emerald-500" />
                  <span>OpenFreeMap Vector Terrain & GeoJSON</span>
                </div>
                <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
                  Loads dark vector rivers, reservoirs, arterial roads, and realistic nocturnal
                  city lights directly from OpenFreeMap MVT tiles (cached in IndexedDB).
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={osmStatus === 'loading'}
                  onClick={() =>
                    onReloadOsmTerrain(
                      currentAirspace.center,
                      Math.min(250, Math.max(150, radiusKm)),
                      currentAirspace.airportCode,
                    )
                  }
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                >
                  {osmStatus === 'loading' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Globe className="w-3.5 h-3.5" />
                  )}
                  <span>{osmStatus === 'loading' ? 'Loading Tiles...' : 'Load Map Terrain'}</span>
                </button>
                <label className="px-2.5 py-1.5 rounded-lg border border-emerald-600/70 text-emerald-400 hover:bg-emerald-600/10 text-xs font-medium cursor-pointer whitespace-nowrap">
                  .geojson
                  <input
                    type="file"
                    accept=".geojson,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleGeoJsonFile(f);
                    }}
                  />
                </label>
              </div>
            </div>
            <div className={`mt-2 text-[11px] font-mono-tabular ${mutedCls}`}>
              Active: {currentAirspace.baseMap?.name ?? 'None'} ·{' '}
              {currentAirspace.baseMap?.polygons.length ?? 0} water/land polygons ·{' '}
              {currentAirspace.baseMap?.polylines.length ?? 0} rivers/shores ·{' '}
              {currentAirspace.baseMap?.labels.length ?? 0} cities
              {osmStatus !== 'idle' && osmStatus !== 'loading' ? ` · Source: ${osmStatus}` : ''}
            </div>
            {osmDetail && (
              <div
                className={`mt-2 px-2.5 py-1.5 rounded-md border text-[11px] flex items-start gap-1.5 ${
                  osmStatus === 'error'
                    ? isDark
                      ? 'bg-amber-950/50 border-amber-800/80 text-amber-200'
                      : 'bg-amber-50 border-amber-300 text-amber-900'
                    : isDark
                      ? 'bg-emerald-950/40 border-emerald-800/70 text-emerald-300'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                }`}
                data-testid="osm-diagnostics"
              >
                {osmStatus === 'error' ? (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                )}
                <span>{osmDetail}</span>
              </div>
            )}
          </div>

          {/* Diagnostic feedback */}
          {statusMsg && (
            <div
              className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                statusMsg.kind === 'ok'
                  ? isDark
                    ? 'bg-emerald-950/50 border-emerald-800 text-emerald-300'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : isDark
                    ? 'bg-amber-950/50 border-amber-800 text-amber-200'
                    : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              {statusMsg.kind === 'ok' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{statusMsg.text}</span>
            </div>
          )}
        </div>

        <div
          className={`px-5 py-3.5 border-t flex items-center justify-between shrink-0 ${
            isDark ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-slate-50'
          }`}
        >
          <button
            type="button"
            onClick={() => {
              setCatalog(null);
              setSctBuffer('');
              setEseBuffer('');
              setSctFileName('');
              setEseFileName('');
              onResetDemo();
              setStatusMsg({ kind: 'ok', text: 'Restored built-in UWGG Volga TMA demo dataset.' });
            }}
            className={`flex items-center gap-1.5 text-xs font-medium cursor-pointer ${mutedCls} hover:text-sky-500`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Restore UWGG Demo Dataset</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
