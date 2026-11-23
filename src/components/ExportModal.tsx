import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Film, HardDrive, RotateCcw, X } from 'lucide-react';
import type { ExportConfig, ThemePreset } from '../types/radar';
import { formatUtcTime } from '../core/geo';
import {
  computeExportPlan,
  computeSpeedForTargetDuration,
  formatBytesCompact,
  formatDurationHms,
} from '../core/exportPlan';
import type { RadarSceneEngine } from '../scene/RadarSceneEngine';
import {
  exportDeterministicVideo,
  type CinemaHudMeta,
  type ExportProgress,
} from '../scene/VideoExporter';

interface ExportModalProps {
  open: boolean;
  theme: ThemePreset;
  engine: RadarSceneEngine | null;
  startTimeSec: number;
  endTimeSec: number;
  hasKeyframes: boolean;
  hudMeta: CinemaHudMeta;
  onClose: () => void;
}

const SPEED_PRESETS = [30, 60, 120, 240, 360, 600] as const;
const TARGET_VIDEO_PRESETS = [30, 60, 90, 120, 180] as const;

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (opts?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

export const ExportModal: React.FC<ExportModalProps> = ({
  open,
  theme,
  engine,
  startTimeSec,
  endTimeSec,
  hasKeyframes,
  hudMeta,
  onClose,
}) => {
  const fullSpanSec = Math.max(10, Math.round(endTimeSec - startTimeSec));

  const [resolution, setResolution] = useState<'720p' | '1080p'>('720p');
  const [fps, setFps] = useState<30 | 60>(60);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(60);
  const [targetVideoSec, setTargetVideoSec] = useState<number | null>(null);
  const [includeLabels, setIncludeLabels] = useState<boolean>(true);
  const [useKeyframes, setUseKeyframes] = useState<boolean>(hasKeyframes);
  const [rangeStartOffsetSec, setRangeStartOffsetSec] = useState<number>(0);
  const [rangeEndOffsetSec, setRangeEndOffsetSec] = useState<number>(fullSpanSec);
  const [streamToDisk, setStreamToDisk] = useState<boolean>(false);

  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [savedToDiskNotice, setSavedToDiskNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const prevLogKeyRef = useRef<string>('');

  // Sync export range automatically to the FULL log whenever a new radar log is loaded
  useEffect(() => {
    const logKey = `${Math.round(startTimeSec)}:${Math.round(endTimeSec)}`;
    if (logKey !== prevLogKeyRef.current) {
      prevLogKeyRef.current = logKey;
      setRangeStartOffsetSec(0);
      setRangeEndOffsetSec(fullSpanSec);
      setTargetVideoSec(null);
      // Pick a sensible initial speed for multi-hour logs so default output isn't 15 minutes long
      if (fullSpanSec >= 10800) {
        setSpeedMultiplier(240);
      } else if (fullSpanSec >= 3600) {
        setSpeedMultiplier(120);
      } else {
        setSpeedMultiplier(60);
      }
    }
  }, [startTimeSec, endTimeSec, fullSpanSec]);

  const supportsDiskStreaming = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      // showSaveFilePicker throws SecurityError inside cross-origin iframes
      return (
        typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function' &&
        window.self === window.top
      );
    } catch {
      return false;
    }
  }, []);

  if (!open) return null;

  const isDark = theme === 'cinematic-dark';
  const surfaceCls = isDark
    ? 'bg-slate-950 border-slate-800 text-slate-100'
    : 'bg-white border-slate-300 text-slate-900';
  const cardCls = isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200';
  const mutedCls = isDark ? 'text-slate-400' : 'text-slate-600';

  const clampedStartOffset = Math.max(0, Math.min(fullSpanSec - 10, rangeStartOffsetSec));
  const clampedEndOffset = Math.max(
    clampedStartOffset + 10,
    Math.min(fullSpanSec, rangeEndOffsetSec),
  );
  const effectiveSpanSec = clampedEndOffset - clampedStartOffset;
  const effectiveSpeed =
    targetVideoSec !== null
      ? computeSpeedForTargetDuration(effectiveSpanSec, targetVideoSec)
      : speedMultiplier;

  const width = resolution === '1080p' ? 1920 : 1280;
  const height = resolution === '1080p' ? 1080 : 720;

  const plan = computeExportPlan({
    startTimeSec: startTimeSec + clampedStartOffset,
    endTimeSec: startTimeSec + clampedEndOffset,
    fps,
    speedMultiplier: effectiveSpeed,
    width,
    height,
  });

  const rangeStep = fullSpanSec > 7200 ? 60 : fullSpanSec > 1800 ? 30 : 10;
  const isFullLog = clampedStartOffset === 0 && clampedEndOffset === fullSpanSec;

  const handleStartExport = async () => {
    if (!engine) return;
    setErrorMsg(null);
    setSavedToDiskNotice(null);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }

    const fileName = `aeroscope-timelapse-${resolution}-${fps}fps.webm`;
    let writableStream: FileSystemWritableFileStream | undefined;

    if (streamToDisk && supportsDiskStreaming) {
      try {
        const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
        if (picker) {
          const handle = await picker({
            suggestedName: fileName,
            types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }],
          });
          writableStream = await handle.createWritable();
        }
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') {
          return;
        }
        // Gracefully fall back to paged in-memory Blob streaming
        writableStream = undefined;
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsExporting(true);
    setProgress({
      currentFrame: 0,
      totalFrames: plan.totalFrames,
      percent: 0,
      simTimeSec: plan.startTimeSec,
      elapsedSec: 0,
      etaSec: null,
      writtenBytes: 0,
      encoderBackend: writableStream ? 'webcodecs-disk' : 'webcodecs-stream',
    });

    const config: ExportConfig = {
      width,
      height,
      fps,
      speedMultiplier: effectiveSpeed,
      startTimeSec: plan.startTimeSec,
      endTimeSec: plan.endTimeSec,
      includeLabels,
      useKeyframes: useKeyframes && hasKeyframes,
    };

    try {
      const result = await exportDeterministicVideo(
        engine,
        config,
        theme,
        hudMeta,
        controller.signal,
        (p) => setProgress(p),
        { writableStream },
      );

      if (result.streamedToDisk) {
        setSavedToDiskNotice(
          `Saved ${result.totalFrames.toLocaleString()} frames (${formatBytesCompact(result.writtenBytes)}) directly to disk.`,
        );
      } else if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        setDownloadUrl(url);

        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
      }
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setErrorMsg(err instanceof Error ? err.message : 'Video export failed.');
      }
    } finally {
      setIsExporting(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
    >
      <div
        className={`w-full max-w-xl max-h-[90vh] flex flex-col rounded-xl border shadow-2xl overflow-hidden ${surfaceCls}`}
      >
        <div
          className={`px-5 py-3.5 border-b flex items-center justify-between shrink-0 ${
            isDark ? 'border-slate-800' : 'border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-sky-500" />
            <h2 id="export-modal-title" className="text-base font-semibold">
              Deterministic Timelapse Video Export
            </h2>
          </div>
          <button
            type="button"
            disabled={isExporting}
            onClick={onClose}
            aria-label="Close render export dialog"
            className="p-1.5 rounded-md hover:bg-slate-500/15 disabled:opacity-40 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3.5 overflow-y-auto flex-1">
          <p className={`text-xs leading-relaxed ${mutedCls}`}>
            Uncapped frame-by-frame offline render stepping by{' '}
            <span className="font-mono-tabular font-semibold">
              1/{fps}s × {Number(effectiveSpeed.toFixed(1))}x
            </span>{' '}
            per frame via paged WebCodecs WebM muxing — supports full multi-hour logs without
            truncation.
          </p>

          <div className="grid grid-cols-2 gap-3">
            {/* Resolution */}
            <div className={`p-3 rounded-lg border ${cardCls}`}>
              <div className={`text-[11px] font-medium mb-2 ${mutedCls}`}>Resolution</div>
              <div className="flex gap-1.5">
                {(['720p', '1080p'] as const).map((res) => (
                  <button
                    key={res}
                    type="button"
                    disabled={isExporting}
                    onClick={() => setResolution(res)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-mono-tabular font-medium cursor-pointer ${
                      resolution === res
                        ? 'bg-sky-600 text-white'
                        : isDark
                          ? 'bg-slate-800 text-slate-300'
                          : 'bg-white border border-slate-200 text-slate-700'
                    }`}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>

            {/* Frame Rate */}
            <div className={`p-3 rounded-lg border ${cardCls}`}>
              <div className={`text-[11px] font-medium mb-2 ${mutedCls}`}>Frame Rate</div>
              <div className="flex gap-1.5">
                {([30, 60] as const).map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    disabled={isExporting}
                    onClick={() => setFps(rate)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-mono-tabular font-medium cursor-pointer ${
                      fps === rate
                        ? 'bg-sky-600 text-white'
                        : isDark
                          ? 'bg-slate-800 text-slate-300'
                          : 'bg-white border border-slate-200 text-slate-700'
                    }`}
                  >
                    {rate} FPS
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Speed & Fit-to-Duration Controls */}
          <div className={`p-3.5 rounded-lg border space-y-3 ${cardCls}`}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className={`text-xs font-medium ${mutedCls}`}>Timelapse Speed</span>
              <div className="flex gap-1 flex-wrap">
                {SPEED_PRESETS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={isExporting}
                    onClick={() => {
                      setTargetVideoSec(null);
                      setSpeedMultiplier(s);
                    }}
                    className={`px-2 py-1 rounded text-xs font-mono-tabular font-medium cursor-pointer ${
                      targetVideoSec === null && speedMultiplier === s
                        ? 'bg-sky-600 text-white'
                        : isDark
                          ? 'bg-slate-800 text-slate-300'
                          : 'bg-white border border-slate-200 text-slate-700'
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className={`text-xs font-medium ${mutedCls}`}>Or Fit to Video Length</span>
              <div className="flex gap-1 flex-wrap">
                {TARGET_VIDEO_PRESETS.map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    disabled={isExporting}
                    onClick={() => setTargetVideoSec(sec)}
                    className={`px-2 py-1 rounded text-xs font-mono-tabular font-medium cursor-pointer ${
                      targetVideoSec === sec
                        ? 'bg-emerald-600 text-white'
                        : isDark
                          ? 'bg-slate-800 text-slate-300'
                          : 'bg-white border border-slate-200 text-slate-700'
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>

            {/* Simulation Range (Full Log by Default) */}
            <div
              className={`pt-2.5 border-t space-y-2 ${
                isDark ? 'border-slate-800' : 'border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className={`font-medium ${mutedCls}`}>
                  Simulation Range ({formatDurationHms(effectiveSpanSec)} of{' '}
                  {formatDurationHms(fullSpanSec)})
                </span>
                {!isFullLog && (
                  <button
                    type="button"
                    disabled={isExporting}
                    onClick={() => {
                      setRangeStartOffsetSec(0);
                      setRangeEndOffsetSec(fullSpanSec);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-400 hover:underline cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Full Log</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-[11px]">
                <label className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono-tabular">
                    <span className={mutedCls}>Start</span>
                    <span className="font-semibold">
                      {formatUtcTime(startTimeSec + clampedStartOffset)} UTC
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Export start time"
                    disabled={isExporting}
                    min={0}
                    max={Math.max(0, clampedEndOffset - 10)}
                    step={rangeStep}
                    value={clampedStartOffset}
                    onChange={(e) => setRangeStartOffsetSec(Number(e.target.value))}
                    className="aero-slider w-full"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono-tabular">
                    <span className={mutedCls}>End</span>
                    <span className="font-semibold">
                      {formatUtcTime(startTimeSec + clampedEndOffset)} UTC
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Export end time"
                    disabled={isExporting}
                    min={Math.min(fullSpanSec, clampedStartOffset + 10)}
                    max={fullSpanSec}
                    step={rangeStep}
                    value={clampedEndOffset}
                    onChange={(e) => setRangeEndOffsetSec(Number(e.target.value))}
                    className="aero-slider w-full"
                  />
                </label>
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-x-5 gap-y-2 pt-1">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isExporting}
                  checked={includeLabels}
                  onChange={(e) => setIncludeLabels(e.target.checked)}
                  className="accent-sky-600"
                />
                <span>Bake ATC Datablocks & UTC</span>
              </label>

              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isExporting || !hasKeyframes}
                  checked={useKeyframes && hasKeyframes}
                  onChange={(e) => setUseKeyframes(e.target.checked)}
                  className="accent-sky-600"
                />
                <span>Use Camera Keyframes</span>
              </label>

              {supportsDiskStreaming && (
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={isExporting}
                    checked={streamToDisk}
                    onChange={(e) => setStreamToDisk(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Stream Directly to Disk</span>
                  </span>
                </label>
              )}
            </div>
          </div>

          {/* Summary Readout */}
          <div
            className={`px-3 py-2 rounded-lg border flex items-center justify-between flex-wrap gap-2 text-xs font-mono-tabular ${cardCls}`}
            data-testid="export-plan-summary"
          >
            <span>
              Output:{' '}
              <strong className={isDark ? 'text-slate-100' : 'text-slate-900'}>
                {formatDurationHms(plan.outputVideoSec)}
              </strong>{' '}
              ({plan.totalFrames.toLocaleString()} frames · ~
              {formatBytesCompact(plan.estimatedBytes)})
            </span>
            <span className={mutedCls}>
              {formatUtcTime(plan.startTimeSec)} – {formatUtcTime(plan.endTimeSec)} UTC
            </span>
          </div>

          {/* Progress Bar */}
          {progress && (
            <div className="space-y-1.5" data-testid="export-progress">
              <div className="flex items-center justify-between text-xs font-mono-tabular gap-2">
                <span>
                  {isExporting
                    ? `Frame ${progress.currentFrame.toLocaleString()} / ${progress.totalFrames.toLocaleString()} · ${formatUtcTime(progress.simTimeSec)} UTC`
                    : `Render complete (${progress.totalFrames.toLocaleString()} frames)`}
                </span>
                <span>
                  {progress.percent}%
                  {progress.writtenBytes > 0 ? ` · ${formatBytesCompact(progress.writtenBytes)}` : ''}
                  {isExporting && progress.etaSec !== null
                    ? ` · ETA ${formatDurationHms(progress.etaSec)}`
                    : ''}
                </span>
              </div>
              <div
                className={`h-2 rounded-full overflow-hidden ${
                  isDark ? 'bg-slate-800' : 'bg-slate-200'
                }`}
              >
                <div
                  className="h-full bg-sky-500 transition-all duration-100"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}

          {errorMsg && <div className="text-xs text-rose-500 font-medium">{errorMsg}</div>}

          {savedToDiskNotice && !isExporting && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 text-emerald-400 text-xs font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{savedToDiskNotice}</span>
            </div>
          )}

          {downloadUrl && !isExporting && (
            <a
              href={downloadUrl}
              download={`aeroscope-timelapse-${resolution}-${fps}fps.webm`}
              className="flex items-center justify-center gap-2 w-full py-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 text-emerald-500 text-xs font-semibold hover:bg-emerald-500/20"
            >
              <Download className="w-4 h-4" />
              <span>Download WebM Video Again</span>
            </a>
          )}
        </div>

        <div
          className={`px-5 py-3.5 border-t flex items-center justify-end gap-2 shrink-0 ${
            isDark ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-slate-50'
          }`}
        >
          {isExporting ? (
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium cursor-pointer"
            >
              Cancel Render
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className={`px-4 py-1.5 rounded-lg border text-xs font-medium cursor-pointer ${cardCls}`}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void handleStartExport()}
                className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium cursor-pointer"
              >
                Start Offline Render
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
