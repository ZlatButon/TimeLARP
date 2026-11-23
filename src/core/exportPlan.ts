export interface ExportPlanInput {
  startTimeSec: number;
  endTimeSec: number;
  fps: 30 | 60;
  speedMultiplier: number;
  width?: number;
  height?: number;
}

export interface ExportPlan {
  startTimeSec: number;
  endTimeSec: number;
  durationSimSec: number;
  fps: 30 | 60;
  speedMultiplier: number;
  simStepPerFrame: number;
  totalFrames: number;
  outputVideoSec: number;
  bitrateBps: number;
  estimatedBytes: number;
  frameSimTime: (frameIndex: number) => number;
}

/**
 * Calibrated target bitrate for crisp dark-mode vector radar lines & typography
 * without excessive file bloat on multi-hour timelapses.
 */
export function selectVideoBitrateBps(width: number, height: number, fps: 30 | 60): number {
  const pixels = width * height;
  const is1080p = pixels >= 1920 * 1080;
  if (is1080p) {
    return fps === 60 ? 9_000_000 : 6_500_000;
  }
  return fps === 60 ? 5_500_000 : 4_000_000;
}

/**
 * Compute an uncapped, deterministic export plan covering the ENTIRE [startTimeSec, endTimeSec]
 * simulation window (no 3,600-frame truncation on multi-hour logs).
 */
export function computeExportPlan(input: ExportPlanInput): ExportPlan {
  const startTimeSec = input.startTimeSec;
  const durationSimSec = Math.max(1, input.endTimeSec - startTimeSec);
  const endTimeSec = startTimeSec + durationSimSec;
  const fps = input.fps;
  const speedMultiplier = Math.max(1, input.speedMultiplier);
  const simStepPerFrame = speedMultiplier / fps;
  const totalFrames = Math.max(1, Math.ceil(durationSimSec / simStepPerFrame));
  const outputVideoSec = totalFrames / fps;
  const bitrateBps = selectVideoBitrateBps(input.width ?? 1280, input.height ?? 720, fps);
  const estimatedBytes = Math.round((outputVideoSec * bitrateBps) / 8);

  const frameSimTime = (frameIndex: number): number => {
    if (totalFrames <= 1) return startTimeSec;
    if (frameIndex >= totalFrames - 1) return endTimeSec;
    return Math.min(endTimeSec, startTimeSec + frameIndex * simStepPerFrame);
  };

  return {
    startTimeSec,
    endTimeSec,
    durationSimSec,
    fps,
    speedMultiplier,
    simStepPerFrame,
    totalFrames,
    outputVideoSec,
    bitrateBps,
    estimatedBytes,
    frameSimTime,
  };
}

/**
 * Calculate the exact timelapse speed multiplier needed to fit `durationSimSec`
 * into a target output video length (`targetVideoSec`).
 */
export function computeSpeedForTargetDuration(
  durationSimSec: number,
  targetVideoSec: number,
): number {
  const safeSim = Math.max(1, durationSimSec);
  const safeTarget = Math.max(5, targetVideoSec);
  return Math.max(1, Number((safeSim / safeTarget).toFixed(2)));
}

/**
 * Format seconds cleanly as `4h 52m`, `2m 26s`, or `45s`.
 */
export function formatDurationHms(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return rem > 0 ? `${h}h ${m}m ${rem}s` : `${h}h ${m}m`;
  }
  if (m > 0) {
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  return `${rem}s`;
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Fixed-page random-access byte buffer for `webm-muxer`'s `StreamTarget`.
 * Avoids the 2x-3x contiguous `ArrayBuffer` reallocation spikes of `ArrayBufferTarget`
 * on long multi-hour renders while supporting out-of-order header/duration patching
 * during `muxer.finalize()`.
 */
export class PagedStreamBuffer {
  private readonly pageSize: number;
  private readonly pages: Uint8Array[] = [];
  private _byteLength = 0;

  constructor(pageSize = 4 * 1024 * 1024) {
    this.pageSize = Math.max(1024, pageSize);
  }

  public get byteLength(): number {
    return this._byteLength;
  }

  public write(data: Uint8Array, position: number): void {
    if (data.byteLength === 0) return;
    let srcOffset = 0;
    let dstPos = position;

    while (srcOffset < data.byteLength) {
      const pageIdx = Math.floor(dstPos / this.pageSize);
      const pageOffset = dstPos % this.pageSize;
      while (this.pages.length <= pageIdx) {
        this.pages.push(new Uint8Array(this.pageSize));
      }
      const page = this.pages[pageIdx];
      const copyLen = Math.min(data.byteLength - srcOffset, this.pageSize - pageOffset);
      page.set(data.subarray(srcOffset, srcOffset + copyLen), pageOffset);
      srcOffset += copyLen;
      dstPos += copyLen;
    }

    if (dstPos > this._byteLength) {
      this._byteLength = dstPos;
    }
  }

  /**
   * Return exact-length `Uint8Array` slices suitable for passing directly to `new Blob(chunks)`
   * without copying into a single giant contiguous ArrayBuffer.
   */
  public toChunks(): Uint8Array<ArrayBuffer>[] {
    if (this._byteLength === 0) return [];
    const lastPageIdx = Math.floor((this._byteLength - 1) / this.pageSize);
    const lastPageLen = this._byteLength - lastPageIdx * this.pageSize;
    const chunks: Uint8Array<ArrayBuffer>[] = [];

    for (let i = 0; i <= lastPageIdx; i++) {
      const page = (this.pages[i] ?? new Uint8Array(this.pageSize)) as Uint8Array<ArrayBuffer>;
      if (i === lastPageIdx && lastPageLen < this.pageSize) {
        chunks.push(page.subarray(0, lastPageLen) as Uint8Array<ArrayBuffer>);
      } else {
        chunks.push(page);
      }
    }
    return chunks;
  }
}
