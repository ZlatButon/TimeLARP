import React, { useEffect, useRef } from 'react';
import type {
  AirspaceDataset,
  AirportTrafficCounters,
  CameraKeyframe,
  RadarDataset,
  SceneSettings,
} from '../types/radar';
import { RadarSceneEngine } from '../scene/RadarSceneEngine';

interface RadarViewportProps {
  airspace: AirspaceDataset;
  radar: RadarDataset;
  settings: SceneSettings;
  isPlaying: boolean;
  speedMultiplier: number;
  simTimeSec: number;
  seekNonce: number;
  selectedCallsign: string | null;
  followSelected: boolean;
  keyframes: CameraKeyframe[];
  useKeyframes: boolean;
  cinemaMode: boolean;
  onSelectAircraft: (callsign: string | null) => void;
  onTimeAdvance: (newTimeSec: number) => void;
  onActiveCountChange: (count: number) => void;
  onActiveCallsignsChange: (callsigns: string[]) => void;
  onAirportStatsChange: (stats: AirportTrafficCounters) => void;
  onEngineReady: (engine: RadarSceneEngine | null) => void;
}

/**
 * Isolated full-viewport WebGL container.
 * All text labels (waypoints, sector boundaries/frequencies, ground geography, and
 * de-overlapped aircraft datablocks with leader lines) render natively inside WebGL
 * synchronously with camera updates for zero jitter and native video export inclusion.
 */
export const RadarViewport: React.FC<RadarViewportProps> = ({
  airspace,
  radar,
  settings,
  isPlaying,
  speedMultiplier,
  simTimeSec,
  seekNonce,
  selectedCallsign,
  followSelected,
  keyframes,
  useKeyframes,
  cinemaMode,
  onSelectAircraft,
  onTimeAdvance,
  onActiveCountChange,
  onActiveCallsignsChange,
  onAirportStatsChange,
  onEngineReady,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<RadarSceneEngine | null>(null);

  const callbacksRef = useRef({
    onSelectAircraft,
    onTimeAdvance,
    onActiveCountChange,
    onActiveCallsignsChange,
    onAirportStatsChange,
    onEngineReady,
  });
  callbacksRef.current = {
    onSelectAircraft,
    onTimeAdvance,
    onActiveCountChange,
    onActiveCallsignsChange,
    onAirportStatsChange,
    onEngineReady,
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const engine = new RadarSceneEngine(container, airspace, radar, settings, {
      onSelectAircraft: (cs) => callbacksRef.current.onSelectAircraft(cs),
      onTimeAdvance: (t) => callbacksRef.current.onTimeAdvance(t),
      onActiveCountChange: (count) => callbacksRef.current.onActiveCountChange(count),
      onActiveCallsignsChange: (list) => callbacksRef.current.onActiveCallsignsChange(list),
      onAirportStatsChange: (stats) => callbacksRef.current.onAirportStatsChange(stats),
    });

    engineRef.current = engine;
    (window as unknown as { __aeroscopeEngine?: RadarSceneEngine }).__aeroscopeEngine = engine;
    callbacksRef.current.onEngineReady(engine);

    const resizeObserver = new ResizeObserver(() => {
      engine.resize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      callbacksRef.current.onEngineReady(null);
      delete (window as unknown as { __aeroscopeEngine?: RadarSceneEngine }).__aeroscopeEngine;
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstAirspaceRef = useRef(true);
  useEffect(() => {
    if (firstAirspaceRef.current) {
      firstAirspaceRef.current = false;
      return;
    }
    engineRef.current?.setAirspaceDataset(airspace);
  }, [airspace]);

  const firstRadarRef = useRef(true);
  useEffect(() => {
    if (firstRadarRef.current) {
      firstRadarRef.current = false;
      return;
    }
    engineRef.current?.setRadarDataset(radar);
  }, [radar]);

  useEffect(() => {
    engineRef.current?.updateSettings(settings);
  }, [settings]);

  useEffect(() => {
    engineRef.current?.setPlaybackState(isPlaying, speedMultiplier);
  }, [isPlaying, speedMultiplier]);

  const lastSeekNonceRef = useRef(seekNonce);
  useEffect(() => {
    if (seekNonce !== lastSeekNonceRef.current) {
      lastSeekNonceRef.current = seekNonce;
      engineRef.current?.setSimTime(simTimeSec);
    }
  }, [seekNonce, simTimeSec]);

  useEffect(() => {
    engineRef.current?.setSelectedAircraft(selectedCallsign, followSelected);
  }, [selectedCallsign, followSelected]);

  useEffect(() => {
    engineRef.current?.setKeyframes(keyframes, useKeyframes);
  }, [keyframes, useKeyframes]);

  useEffect(() => {
    engineRef.current?.setCinemaMode(cinemaMode);
  }, [cinemaMode]);

  return (
    <div
      className="relative w-full h-full overflow-hidden select-none"
      data-testid="radar-viewport"
      data-theme={settings.theme}
    >
      <div
        ref={mountRef}
        className="absolute inset-0 w-full h-full"
        data-testid="webgl-canvas-mount"
      />
    </div>
  );
};
