import {
  FileSystemWritableFileStreamTarget,
  Muxer,
  StreamTarget,
} from 'webm-muxer';
import type { ExportConfig, ThemePreset } from '../types/radar';
import { formatUtcTimeHm } from '../core/geo';
import { computeExportPlan, PagedStreamBuffer } from '../core/exportPlan';
import type { RadarSceneEngine } from './RadarSceneEngine';

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
  simTimeSec: number;
  elapsedSec: number;
  etaSec: number | null;
  writtenBytes: number;
  encoderBackend: 'webcodecs-stream' | 'webcodecs-disk' | 'mediarecorder-webm';
}

export interface CinemaHudMeta {
  title: string;
  subtitle: string;
  dateLabel: string;
  airportCode?: string;
}

export interface ExportVideoOptions {
  /** Optional FileSystemWritableFileStream from showSaveFilePicker for zero-RAM disk streaming */
  writableStream?: FileSystemWritableFileStream;
}

export interface ExportVideoResult {
  /** Non-null when buffered into a Blob (default PagedStreamBuffer / MediaRecorder); null if streamed directly to disk */
  blob: Blob | null;
  streamedToDisk: boolean;
  totalFrames: number;
  writtenBytes: number;
}

/**
 * Composite the unified asymmetric Cinema Telemetry HUD + airport AIRBORNE/LANDED counters + sector legend
 * onto the exported video frame (matching the live HUD 1:1).
 */
function compositeCinemaHudOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  _height: number,
  simTimeSec: number,
  airborneCount: number,
  landedCount: number,
  theme: ThemePreset,
  meta: CinemaHudMeta,
): void {
  const isDark = theme === 'cinematic-dark';
  const s = width / 1280;
  const x0 = Math.round(28 * s);
  const y0 = Math.round(24 * s);
  const barH = Math.round(78 * s);

  const primaryText = isDark ? 'rgba(241, 245, 249, 0.96)' : 'rgba(15, 23, 42, 0.94)';
  const secondaryText = isDark ? 'rgba(148, 163, 184, 0.86)' : 'rgba(51, 65, 85, 0.85)';

  ctx.save();

  // Soft dark radial vignette behind top-left HUD block for effortless readability over any scene brightness
  if (isDark) {
    const vigR = Math.round(420 * s);
    const vig = ctx.createRadialGradient(
      x0 + Math.round(80 * s),
      y0 + Math.round(32 * s),
      Math.round(16 * s),
      x0 + Math.round(80 * s),
      y0 + Math.round(32 * s),
      vigR,
    );
    vig.addColorStop(0, 'rgba(4, 8, 16, 0.56)');
    vig.addColorStop(0.5, 'rgba(4, 8, 16, 0.24)');
    vig.addColorStop(1, 'rgba(4, 8, 16, 0.0)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, vigR + x0 * 2, Math.round(210 * s));
  }

  ctx.shadowColor = isDark ? 'rgba(2, 6, 23, 0.92)' : 'rgba(255, 255, 255, 0.45)';
  ctx.shadowBlur = 8 * s;

  // Vertical asymmetric accent stripe (warm gold -> amber -> electric cyan -> indigo)
  const grad = ctx.createLinearGradient(x0, y0, x0, y0 + barH);
  grad.addColorStop(0, isDark ? '#fde68a' : '#d97706');
  grad.addColorStop(0.35, isDark ? '#f59e0b' : '#ea580c');
  grad.addColorStop(0.68, isDark ? '#38bdf8' : '#0284c7');
  grad.addColorStop(1, isDark ? '#818cf8' : '#4338ca');
  ctx.fillStyle = grad;
  ctx.fillRect(x0, y0, Math.max(2, Math.round(2.5 * s)), barH);

  const tx = x0 + Math.round(13 * s);

  // Row 1: Region Title + Generous Gap + Calm HH:MM UTC Clock (no flickering seconds)
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = primaryText;
  ctx.font = `700 ${Math.round(15 * s)}px "Plus Jakarta Sans", sans-serif`;
  const titleStr = meta.title.toUpperCase();
  ctx.fillText(titleStr, tx, y0);

  const titleW = ctx.measureText(titleStr).width;
  ctx.fillStyle = isDark ? 'rgba(125, 211, 252, 0.96)' : 'rgba(3, 105, 161, 0.95)';
  ctx.font = `700 ${Math.round(14 * s)}px "JetBrains Mono", monospace`;
  ctx.fillText(
    `${formatUtcTimeHm(simTimeSec)} UTC`,
    tx + titleW + Math.round(24 * s),
    y0 + Math.round(1 * s),
  );

  // Row 2: Session Date · Subtitle
  ctx.fillStyle = secondaryText;
  ctx.font = `500 ${Math.round(10 * s)}px "JetBrains Mono", monospace`;
  ctx.fillText(
    `${meta.dateLabel.toUpperCase()}  ·  ${meta.subtitle.toUpperCase()}`,
    tx,
    y0 + Math.round(21 * s),
  );

  // Row 3: Target Airport Cumulative Departures (AIRBORNE) & Arrivals (LANDED)
  const aptPrefix = meta.airportCode ? `${meta.airportCode.toUpperCase()}  ` : '';
  ctx.fillStyle = primaryText;
  ctx.font = `700 ${Math.round(11 * s)}px "JetBrains Mono", monospace`;
  ctx.fillText(
    `${aptPrefix}${String(airborneCount).padStart(2, '0')} AIRBORNE  ·  ${String(landedCount).padStart(2, '0')} LANDED`,
    tx,
    y0 + Math.round(39 * s),
  );

  // Row 4: Miniature Active Sector Color Legend (● TWR ● RADAR ● APP ● CTR)
  const legendItems = [
    { label: 'TWR', color: isDark ? '#fde68a' : '#d97706' },
    { label: 'RADAR', color: isDark ? '#f59e0b' : '#ea580c' },
    { label: 'APP', color: isDark ? '#38bdf8' : '#0284c7' },
    { label: 'CTR', color: isDark ? '#818cf8' : '#4338ca' },
  ];
  let lx = tx;
  const ly = y0 + Math.round(60 * s);
  const dotR = Math.max(2.5, 3.0 * s);
  ctx.font = `600 ${Math.round(9.5 * s)}px "JetBrains Mono", monospace`;
  for (const item of legendItems) {
    ctx.beginPath();
    ctx.arc(lx + dotR, ly + Math.round(5 * s), dotR, 0, Math.PI * 2);
    ctx.fillStyle = item.color;
    ctx.fill();

    ctx.fillStyle = secondaryText;
    ctx.fillText(item.label, lx + dotR * 2 + Math.round(5 * s), ly);
    lx += dotR * 2 + ctx.measureText(item.label).width + Math.round(16 * s);
  }

  ctx.restore();
}

/**
 * Deterministic frame-by-frame video export decoupled from requestAnimationFrame.
 * Supports arbitrary multi-hour logs without frame-count truncation via paged/streaming WebM muxing.
 */
export async function exportDeterministicVideo(
  engine: RadarSceneEngine,
  config: ExportConfig,
  theme: ThemePreset,
  meta: CinemaHudMeta,
  signal: AbortSignal,
  onProgress: (p: ExportProgress) => void,
  options: ExportVideoOptions = {},
): Promise<ExportVideoResult> {
  const plan = computeExportPlan({
    startTimeSec: config.startTimeSec,
    endTimeSec: config.endTimeSec,
    fps: config.fps,
    speedMultiplier: config.speedMultiplier,
    width: config.width,
    height: config.height,
  });

  const { totalFrames, bitrateBps } = plan;

  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = config.width;
  compositeCanvas.height = config.height;
  const ctx = compositeCanvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not acquire 2D compositing context for video export.');
  }

  const restoreViewport = engine.beginDeterministicExport(config.width, config.height);
  const startedAtMs = performance.now();
  let lastProgressMs = 0;

  try {
    const supportsWebCodecs =
      typeof window !== 'undefined' &&
      'VideoEncoder' in window &&
      'VideoFrame' in window;

    if (supportsWebCodecs) {
      let codecString = 'vp09.00.10.08';
      let muxerCodec: 'V_VP9' | 'V_VP8' = 'V_VP9';
      const vp9Check = await VideoEncoder.isConfigSupported({
        codec: codecString,
        width: config.width,
        height: config.height,
        bitrate: bitrateBps,
        framerate: config.fps,
      });
      if (!vp9Check.supported) {
        codecString = 'vp8';
        muxerCodec = 'V_VP8';
      }

      const writable = options.writableStream;
      const pagedBuffer = writable ? null : new PagedStreamBuffer(4 * 1024 * 1024);
      let diskApproxBytes = 0;

      const target = writable
        ? new FileSystemWritableFileStreamTarget(writable, { chunkSize: 8 * 1024 * 1024 })
        : new StreamTarget({
            onData: (data, position) => {
              pagedBuffer!.write(data, position);
            },
          });

      const muxer = new Muxer({
        target,
        video: {
          codec: muxerCodec,
          width: config.width,
          height: config.height,
          frameRate: config.fps,
        },
        firstTimestampBehavior: 'offset',
      });

      let encoderError: Error | null = null;
      const encoder = new VideoEncoder({
        output: (chunk, metaChunk) => {
          diskApproxBytes += chunk.byteLength;
          muxer.addVideoChunk(chunk, metaChunk);
        },
        error: (err) => {
          encoderError = err instanceof Error ? err : new Error(String(err));
        },
      });

      encoder.configure({
        codec: codecString,
        width: config.width,
        height: config.height,
        bitrate: bitrateBps,
        framerate: config.fps,
      });

      const backend: ExportProgress['encoderBackend'] = writable
        ? 'webcodecs-disk'
        : 'webcodecs-stream';

      for (let f = 0; f < totalFrames; f++) {
        if (signal.aborted) {
          encoder.close();
          if (writable) {
            try {
              await writable.abort();
            } catch {
              // ignore abort cleanup error
            }
          }
          throw new DOMException('Export cancelled by user', 'AbortError');
        }
        if (encoderError) throw encoderError;

        const simTime = plan.frameSimTime(f);
        const { airportStats } = engine.renderDeterministicFrame(
          simTime,
          config.width,
          config.height,
          config.useKeyframes,
          config.includeLabels,
        );

        ctx.clearRect(0, 0, config.width, config.height);
        ctx.drawImage(engine.renderer.domElement, 0, 0, config.width, config.height);
        compositeCinemaHudOnCanvas(
          ctx,
          config.width,
          config.height,
          simTime,
          airportStats.airborne,
          airportStats.landed,
          theme,
          meta,
        );

        // Drift-free exact microsecond timestamps over arbitrary frame counts
        const timestampUs = Math.round((f * 1_000_000) / config.fps);
        const nextTimestampUs = Math.round(((f + 1) * 1_000_000) / config.fps);
        const frame = new VideoFrame(compositeCanvas, {
          timestamp: timestampUs,
          duration: Math.max(1, nextTimestampUs - timestampUs),
        });
        const keyFrame = f % (config.fps * 2) === 0;
        encoder.encode(frame, { keyFrame });
        frame.close();

        // Keep WebCodecs encoder queue bounded so long renders never spike GPU/RAM
        if (encoder.encodeQueueSize >= 6) {
          await encoder.flush();
        }

        const nowMs = performance.now();
        if (f === 0 || f === totalFrames - 1 || nowMs - lastProgressMs >= 140) {
          lastProgressMs = nowMs;
          const elapsedSec = Math.max(0.05, (nowMs - startedAtMs) / 1000);
          const done = f + 1;
          const fpsActual = done / elapsedSec;
          const remaining = totalFrames - done;
          const etaSec = done >= 4 && fpsActual > 0 ? remaining / fpsActual : null;
          onProgress({
            currentFrame: done,
            totalFrames,
            percent: Math.round((done / totalFrames) * 100),
            simTimeSec: simTime,
            elapsedSec,
            etaSec,
            writtenBytes: pagedBuffer ? pagedBuffer.byteLength : diskApproxBytes,
            encoderBackend: backend,
          });
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      await encoder.flush();
      encoder.close();
      muxer.finalize();

      if (writable) {
        await writable.close();
        return {
          blob: null,
          streamedToDisk: true,
          totalFrames,
          writtenBytes: diskApproxBytes,
        };
      }

      const chunks = pagedBuffer!.toChunks();
      return {
        blob: new Blob(chunks, { type: 'video/webm' }),
        streamedToDisk: false,
        totalFrames,
        writtenBytes: pagedBuffer!.byteLength,
      };
    }

    // Fallback: Canvas captureStream + MediaRecorder with 1s timeslice chunking
    const stream = compositeCanvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const chunks: BlobPart[] = [];
    let recordedBytes = 0;
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrateBps });
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) {
        chunks.push(ev.data);
        recordedBytes += ev.data.size;
      }
    };

    const stopPromise = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    recorder.start(1000);

    for (let f = 0; f < totalFrames; f++) {
      if (signal.aborted) {
        recorder.stop();
        throw new DOMException('Export cancelled by user', 'AbortError');
      }
      const simTime = plan.frameSimTime(f);
      const { airportStats } = engine.renderDeterministicFrame(
        simTime,
        config.width,
        config.height,
        config.useKeyframes,
        config.includeLabels,
      );
      ctx.clearRect(0, 0, config.width, config.height);
      ctx.drawImage(engine.renderer.domElement, 0, 0, config.width, config.height);
      compositeCinemaHudOnCanvas(
        ctx,
        config.width,
        config.height,
        simTime,
        airportStats.airborne,
        airportStats.landed,
        theme,
        meta,
      );
      track.requestFrame?.();

      const nowMs = performance.now();
      if (f === 0 || f === totalFrames - 1 || nowMs - lastProgressMs >= 140) {
        lastProgressMs = nowMs;
        const elapsedSec = Math.max(0.05, (nowMs - startedAtMs) / 1000);
        const done = f + 1;
        const fpsActual = done / elapsedSec;
        const etaSec = done >= 4 && fpsActual > 0 ? (totalFrames - done) / fpsActual : null;
        onProgress({
          currentFrame: done,
          totalFrames,
          percent: Math.round((done / totalFrames) * 100),
          simTimeSec: simTime,
          elapsedSec,
          etaSec,
          writtenBytes: recordedBytes,
          encoderBackend: 'mediarecorder-webm',
        });
      }
      await new Promise((r) => setTimeout(r, Math.round(1000 / config.fps)));
    }

    recorder.stop();
    const blob = await stopPromise;
    return {
      blob,
      streamedToDisk: false,
      totalFrames,
      writtenBytes: blob.size,
    };
  } finally {
    restoreViewport();
  }
}
