import type {
  AircraftTrack,
  ControllerEvent,
  FlightPlanInfo,
  GeoPoint,
  RadarDataset,
  RadarSample,
  TrackSegment,
} from '../types/radar';
import { LocalENUProjector } from './geo';
import { parseControllerCallsign } from './airspaceZones';

/** Maximum time gap (seconds) before splitting an aircraft track into a separate segment */
export const MAX_RADAR_GAP_SEC = 60;

/**
 * Decode VATSIM/FSD 32-bit packed Pitch-Bank-Heading (PBH) integer.
 * Bit layout (standard VATSIM FSD spec):
 *   Bits 22..31 (10 bits): Pitch (signed, 1024 = 360 deg)
 *   Bits 12..21 (10 bits): Bank  (signed, 1024 = 360 deg)
 *   Bits  2..11 (10 bits): Heading (unsigned, 0..1023 -> 0..360 deg)
 *   Bit       1 (1 bit):   On-ground flag
 */
export function decodeFsdPbh(pbh: number): {
  headingDeg: number;
  bankDeg: number;
  pitchDeg: number;
  onGround: boolean;
} {
  const unsigned = pbh >>> 0;
  const hdgRaw = (unsigned >>> 2) & 0x3ff;
  const bankRaw = (unsigned >>> 12) & 0x3ff;
  const pitchRaw = (unsigned >>> 22) & 0x3ff;
  const onGround = ((unsigned >>> 1) & 1) === 1;

  const headingDeg = (hdgRaw * 360) / 1024;
  const bankSigned = bankRaw >= 512 ? bankRaw - 1024 : bankRaw;
  const pitchSigned = pitchRaw >= 512 ? pitchRaw - 1024 : pitchRaw;

  return {
    headingDeg,
    bankDeg: -(bankSigned * 360) / 1024,
    pitchDeg: -(pitchSigned * 360) / 1024,
    onGround,
  };
}

/**
 * Encode Pitch-Bank-Heading back into a VATSIM 32-bit PBH integer (useful for tests & demo logs).
 */
export function encodeFsdPbh(headingDeg: number, bankDeg = 0, pitchDeg = 0, onGround = false): number {
  const normHdg = ((headingDeg % 360) + 360) % 360;
  const hdgRaw = Math.round((normHdg / 360) * 1024) & 0x3ff;
  const bankRaw = (Math.round((-bankDeg / 360) * 1024) + 1024) & 0x3ff;
  const pitchRaw = (Math.round((-pitchDeg / 360) * 1024) + 1024) & 0x3ff;
  return (((pitchRaw << 22) | (bankRaw << 12) | (hdgRaw << 2) | (onGround ? 2 : 0)) >>> 0);
}

/**
 * Parse a timestamp header like `[16:00:40 >>>> UWGG_R_APP]` or `[16:00:40.250 <<<2 UWGG_R_APP]`.
 */
export function parseTimestampHeader(line: string): number | null {
  const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s+|])/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const frac = match[4] ? Number(`0.${match[4]}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + frac;
}

/**
 * Split a list of time-sorted RadarSamples into continuous TrackSegments
 * whenever there is a radar drop/gap exceeding MAX_RADAR_GAP_SEC.
 */
export function segmentSamples(
  samples: RadarSample[],
  maxGapSec = MAX_RADAR_GAP_SEC,
): TrackSegment[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.timeSec - b.timeSec);
  const deduped: RadarSample[] = [];
  for (const s of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(s.timeSec - prev.timeSec) < 0.05) {
      deduped[deduped.length - 1] = s;
    } else {
      deduped.push(s);
    }
  }

  const segments: TrackSegment[] = [];
  let current: RadarSample[] = [deduped[0]];

  for (let i = 1; i < deduped.length; i++) {
    const prev = deduped[i - 1];
    const next = deduped[i];
    if (next.timeSec - prev.timeSec > maxGapSec) {
      segments.push({
        samples: current,
        startTime: current[0].timeSec,
        endTime: current[current.length - 1].timeSec,
      });
      current = [next];
    } else {
      current.push(next);
    }
  }

  segments.push({
    samples: current,
    startTime: current[0].timeSec,
    endTime: current[current.length - 1].timeSec,
  });

  return segments;
}

/**
 * Parse a EuroScope FSD session log (.txt) or CSV radar log.
 *
 * Supported packet families:
 *  - `[HH:MM:SS ...]` block timestamps (with automatic midnight rollover)
 *  - `@<mode>:<callsign>:<squawk>:<rating>:<lat>:<lon>:<altFt>:<gsKt>:<pbh>:<altDiff>` (Standard Pilot Position)
 *  - `^<callsign>:<lat>:<lon>:<altTrue>:<altMsl>:<pbh>:<vx>:<vy>:<vz>:...` (VATSIM Velocity Fast Position)
 *  - `%<callsign>:<freq>:<fac>:<vis>:<rating>:<lat>:<lon>:<alt>` (ATC Position / radar origin)
 *  - `$FP<callsign>:<target>:<rules>:<acType>:<tas>:<dep>:<depTime>:<actDep>:<cruiseAlt>:<dest>:...:<route>` (Flight Plan)
 *  - Controller ownership packets mapped directly onto each aircraft's `controllerEvents`:
 *      * `$CQ<ATC>:@94835:IT:<AIRCRAFT>` (Initiate Track — ATC assumes control)
 *      * `$CQ<ATC>:@94835:DR:<AIRCRAFT>` (Drop Track — ATC releases control)
 *      * `$HA<ACCEPTING_ATC>:<FROM_ATC>:<AIRCRAFT>` (Handoff Accepted — ownership transfers to ACCEPTING_ATC)
 *      * `$CR<ATC>:<REQ>:WH:Y:<AIRCRAFT>` or `$CR<ATC>:<REQ>:WH:<AIRCRAFT>:Y` (Who-Has confirmation)
 *      * `#PC<FROM_ATC>:<TO_ATC>:CCP:(HC|HA|HT|IH):<AIRCRAFT>` (EuroScope proxy coordination)
 *  - CSV fallback: `TIME_SEC,CALLSIGN,LAT,LON,ALT_FT,GS_KT,HDG[,CONTROLLER]` (8th column = explicit controller)
 */
export function parseEuroScopeFsdLog(
  rawText: string,
  sourceName = 'EuroScope FSD Log',
  fallbackCenter: GeoPoint = { lat: 56.23, lon: 43.78417 },
  maxRadiusKm = 450,
): RadarDataset {
  const lines = rawText.split(/\r?\n/);
  const warnings: string[] = [];

  let currentBaseTime: number | null = null;
  let dayOffsetSec = 0;
  let lastRawTimeOfDay: number | null = null;
  let packetSeqInSecond = 0;

  const flightPlans = new Map<string, FlightPlanInfo>();
  const samplesByCallsign = new Map<string, RadarSample[]>();
  const squawkByCallsign = new Map<string, string>();
  const atcStationsMap = new Map<string, { callsign: string; lat: number; lon: number }>();
  const controllerEventsByCallsign = new Map<string, ControllerEvent[]>();

  let pilotPackets = 0;
  let controllerEventCount = 0;
  let detectedCenter: GeoPoint | null = null;

  const pendingHandoffByAc = new Map<string, { targetAtc: string; timeSec: number }>();

  const isLikelyAtcCallsign = (cs: string): boolean => {
    const u = cs.trim().toUpperCase();
    if (!u || u === 'SERVER' || u.startsWith('@') || u.startsWith('$')) return false;
    if (atcStationsMap.has(cs.trim()) || atcStationsMap.has(u)) return true;
    return /_(TWR|GND|DEL|APP|DEP|CTR|FSS|ACC|RADAR|TMA|OBS)$/.test(u) ||
      /_(R|F)_APP$/.test(u) ||
      /^(UUWV|UWWW|UWGG)_/.test(u);
  };

  const recordControllerEvent = (
    aircraftCallsign: string,
    timeSec: number,
    atcCallsign: string | null,
    droppedBy?: string,
  ) => {
    const ac = aircraftCallsign.trim().toUpperCase();
    if (!ac) return;
    const list = controllerEventsByCallsign.get(ac) ?? [];
    if (atcCallsign) {
      const cleanAtc = atcCallsign.trim().toUpperCase();
      const mapped = parseControllerCallsign(cleanAtc);
      const prev = list[list.length - 1];
      if (!prev || prev.controllerCallsign !== cleanAtc || Math.abs(prev.timeSec - timeSec) > 0.5) {
        list.push({
          timeSec,
          controllerCallsign: cleanAtc,
          sectorCode: mapped.sectorCode,
          kind: mapped.kind,
        });
        controllerEventCount++;
      }
    } else {
      const cleanDropper = droppedBy?.trim().toUpperCase();
      const prev = list[list.length - 1];
      // Ignore stale DR from a controller who is no longer the current owner
      if (
        cleanDropper &&
        prev?.controllerCallsign &&
        prev.controllerCallsign !== cleanDropper
      ) {
        return;
      }
      // If the dropping controller recently initiated a handoff ($HO or #PC:IH) to another ATC,
      // promote ownership directly to the handoff target (handles point-to-point $HA hidden from observer logs!)
      const pending = pendingHandoffByAc.get(ac);
      if (pending && timeSec - pending.timeSec <= 180) {
        pendingHandoffByAc.delete(ac);
        const mapped = parseControllerCallsign(pending.targetAtc);
        list.push({
          timeSec,
          controllerCallsign: pending.targetAtc,
          sectorCode: mapped.sectorCode,
          kind: mapped.kind,
        });
        controllerEventCount++;
      } else {
        list.push({
          timeSec,
          controllerCallsign: null,
          sectorCode: 'CTR',
          kind: 'ENROUTE',
          droppedBy: cleanDropper,
        });
        controllerEventCount++;
      }
    }
    controllerEventsByCallsign.set(ac, list);
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // 1. Block timestamp header: [16:00:40 >>>> UWGG_R_APP] (or inline "[16:00:40] @N:...")
    if (line.startsWith('[')) {
      const parsedTime = parseTimestampHeader(line);
      if (parsedTime !== null) {
        if (lastRawTimeOfDay !== null && parsedTime + 3600 < lastRawTimeOfDay) {
          dayOffsetSec += 86400;
        }
        const absoluteTime = parsedTime + dayOffsetSec;
        if (currentBaseTime === null || Math.abs(absoluteTime - currentBaseTime) >= 0.001) {
          currentBaseTime = absoluteTime;
          packetSeqInSecond = 0;
        }
        lastRawTimeOfDay = parsedTime;
      }
      const closeBracket = line.indexOf(']');
      const trailing = closeBracket >= 0 ? line.slice(closeBracket + 1).trim() : '';
      if (!trailing) continue;
      line = trailing;
    }

    const effectiveTime = currentBaseTime ?? 0;

    // 2. ATC position packet (%UWGG_R_APP:99998:5:150:5:56.23000:43.78417:0)
    if (line.startsWith('%')) {
      const parts = line.slice(1).split(':');
      if (parts.length >= 7) {
        const callsign = parts[0].trim();
        const lat = Number(parts[5]);
        const lon = Number(parts[6]);
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          atcStationsMap.set(callsign.toUpperCase(), { callsign, lat, lon });
          if (!detectedCenter) {
            detectedCenter = { lat, lon };
          }
        }
      }
      continue;
    }

    // 3. Controller Ownership / Handoff packets ($CQ IT/HT/DR/TA/HD/SP/DI/CA, $HO, $HA, $CR WH, #PC CCP)
    if (line.startsWith('$CQ')) {
      const parts = line.slice(3).split(':');
      // $CQ<ATC>:@94835:(IT|HT|DR|TA|HD|SP|DI|CA):<AIRCRAFT>...
      if (parts.length >= 4) {
        const sender = parts[0].trim();
        const cmd = parts[2].trim().toUpperCase();
        const targetAc = parts[3].trim();
        if (isLikelyAtcCallsign(sender) && targetAc) {
          if (cmd === 'IT' || cmd === 'HT') {
            pendingHandoffByAc.delete(targetAc.toUpperCase());
            recordControllerEvent(targetAc, effectiveTime, sender);
          } else if (cmd === 'DR') {
            recordControllerEvent(targetAc, effectiveTime, null, sender);
          } else if (
            cmd === 'TA' ||
            cmd === 'HD' ||
            cmd === 'SP' ||
            cmd === 'DI' ||
            cmd === 'CA'
          ) {
            // Active ATC clearance (Temp Alt / Heading / Speed / Direct / Cleared Alt):
            // Only infer ownership when the aircraft currently has NO active controller
            // (and never let GND/DEL hijack an airborne track via clearance edits).
            const existing = controllerEventsByCallsign.get(targetAc.toUpperCase());
            const lastEv = existing && existing.length > 0 ? existing[existing.length - 1] : null;
            const senderIsGround = /(_GND|_DEL)$/i.test(sender);
            if (!senderIsGround && (!lastEv || lastEv.controllerCallsign === null)) {
              pendingHandoffByAc.delete(targetAc.toUpperCase());
              recordControllerEvent(targetAc, effectiveTime, sender);
            }
          }
        }
      }
      continue;
    }

    if (line.startsWith('$HO')) {
      // $HO<FROM_ATC>:<TO_ATC>:<AIRCRAFT> (Handoff Offered — remember target ATC)
      const parts = line.slice(3).split(':');
      if (parts.length >= 3) {
        const toAtc = parts[1].trim().toUpperCase();
        const targetAc = parts[2].trim().toUpperCase();
        if (isLikelyAtcCallsign(toAtc) && targetAc) {
          pendingHandoffByAc.set(targetAc, { targetAtc: toAtc, timeSec: effectiveTime });
        }
      }
      continue;
    }

    if (line.startsWith('$HA')) {
      // $HA<ACCEPTING_ATC>:<FROM_ATC>:<AIRCRAFT>
      const parts = line.slice(3).split(':');
      if (parts.length >= 3) {
        const acceptingAtc = parts[0].trim();
        const targetAc = parts[2].trim();
        if (isLikelyAtcCallsign(acceptingAtc) && targetAc) {
          pendingHandoffByAc.delete(targetAc.toUpperCase());
          recordControllerEvent(targetAc, effectiveTime, acceptingAtc);
        }
      }
      continue;
    }

    if (line.startsWith('$CR')) {
      // $CR<ATC>:<REQUESTER>:WH:Y:<AIRCRAFT> or WH:<AIRCRAFT>:Y or 4-part WH:<AIRCRAFT>
      const parts = line.slice(3).split(':');
      if (parts.length >= 4 && parts[2].trim().toUpperCase() === 'WH') {
        const ownerAtc = parts[0].trim();
        if (isLikelyAtcCallsign(ownerAtc)) {
          if (parts.length >= 5) {
            const p3 = parts[3].trim().toUpperCase();
            const p4 = parts[4].trim().toUpperCase();
            if (p3 === 'Y' && parts[4].trim()) {
              recordControllerEvent(parts[4].trim(), effectiveTime, ownerAtc);
            } else if (p4 === 'Y' && parts[3].trim()) {
              recordControllerEvent(parts[3].trim(), effectiveTime, ownerAtc);
            }
          } else if (parts[3].trim() && parts[3].trim().toUpperCase() !== 'N') {
            recordControllerEvent(parts[3].trim(), effectiveTime, ownerAtc);
          }
        }
      }
      continue;
    }

    if (line.startsWith('#PC')) {
      // #PC<FROM_ATC>:<TO_ATC>:CCP:(HC|HA|HT|IH):<AIRCRAFT>...
      const parts = line.slice(3).split(':');
      if (parts.length >= 5 && parts[2].trim().toUpperCase() === 'CCP') {
        const fromAtc = parts[0].trim();
        const toAtc = parts[1].trim().toUpperCase();
        const sub = parts[3].trim().toUpperCase();
        const targetAc = parts[4].trim();
        if (isLikelyAtcCallsign(fromAtc) && targetAc) {
          if (sub === 'HT' || sub === 'HA') {
            pendingHandoffByAc.delete(targetAc.toUpperCase());
            recordControllerEvent(targetAc, effectiveTime, fromAtc);
          } else if (sub === 'IH' && isLikelyAtcCallsign(toAtc)) {
            pendingHandoffByAc.set(targetAc.toUpperCase(), {
              targetAtc: toAtc,
              timeSec: effectiveTime,
            });
            recordControllerEvent(targetAc, effectiveTime, fromAtc);
          } else if (sub === 'HC') {
            pendingHandoffByAc.delete(targetAc.toUpperCase());
            recordControllerEvent(targetAc, effectiveTime, fromAtc);
          }
        }
      }
      continue;
    }

    // 4. Flight Plan packet ($FP<callsign>:...)
    if (line.startsWith('$FP')) {
      const parts = line.slice(3).split(':');
      if (parts.length >= 10) {
        const callsign = parts[0].trim();
        const rawType = parts[3] || '';
        const aircraftType = rawType.split('-')[0] || 'UNKN';
        const origin = (parts[5] || '').trim();
        const rawCruise = (parts[8] || '').trim();
        let cruiseAltFt = Number(rawCruise.replace(/[^\d]/g, '')) || 0;
        if (rawCruise.toUpperCase().startsWith('FL') || (cruiseAltFt > 0 && cruiseAltFt < 600)) {
          cruiseAltFt *= 100;
        }
        const destination = (parts[9] || '').trim();
        const route = parts.slice(16).join(':').trim();
        const firstRouteToken = route.split(/\s+/)[0];
        flightPlans.set(callsign, {
          callsign,
          aircraftType,
          origin,
          destination,
          cruiseAltFt,
          route,
          sidOrStar: firstRouteToken && firstRouteToken.length >= 4 ? firstRouteToken : undefined,
        });
      }
      continue;
    }

    // 5. Standard Pilot Position (@N:CALLSIGN:SQUAWK:RATING:LAT:LON:ALT:GS:PBH:ALTDIFF)
    if (line.startsWith('@')) {
      const parts = line.split(':');
      if (parts.length >= 9) {
        const callsign = parts[1].trim();
        const squawk = parts[2].trim();
        const lat = Number(parts[4]);
        const lon = Number(parts[5]);
        const altFt = Number(parts[6]);
        const gsKt = Number(parts[7]);
        const pbh = Number(parts[8]);

        if (
          callsign &&
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lon) <= 180 &&
          Number.isFinite(altFt)
        ) {
          const decoded = Number.isFinite(pbh) ? decodeFsdPbh(pbh) : null;
          const sample: RadarSample = {
            timeSec: effectiveTime + packetSeqInSecond * 0.0001,
            lat,
            lon,
            altFt: Math.max(0, altFt),
            gsKt: Number.isFinite(gsKt) ? Math.max(0, gsKt) : 0,
            headingDeg: decoded ? decoded.headingDeg : 0,
            squawk,
            hasExplicitHeading: decoded !== null,
          };
          packetSeqInSecond++;
          pilotPackets++;
          squawkByCallsign.set(callsign, squawk);
          const list = samplesByCallsign.get(callsign);
          if (list) list.push(sample);
          else samplesByCallsign.set(callsign, [sample]);
        }
      }
      continue;
    }

    // 6. Fast Pilot Position (^CALLSIGN:LAT:LON:ALT_TRUE:ALT_MSL:PBH:VX:VY:VZ:...)
    if (line.startsWith('^')) {
      const parts = line.slice(1).split(':');
      if (parts.length >= 6) {
        const callsign = parts[0].trim();
        const lat = Number(parts[1]);
        const lon = Number(parts[2]);
        const altTrue = Number(parts[3]);
        const altMsl = Number(parts[4]);
        const pbh = Number(parts[5]);
        const vx = Number(parts[6] ?? 0);
        const vz = Number(parts[8] ?? 0);

        if (callsign && Number.isFinite(lat) && Number.isFinite(lon)) {
          const decoded = Number.isFinite(pbh) ? decodeFsdPbh(pbh) : null;
          const gsKt =
            Number.isFinite(vx) && Number.isFinite(vz) && (vx !== 0 || vz !== 0)
              ? Math.hypot(vx, vz) * 1.94384
              : 0;
          const altFt = Number.isFinite(altMsl) && altMsl > 0 ? altMsl : altTrue;
          const sample: RadarSample = {
            timeSec: effectiveTime + packetSeqInSecond * 0.0001,
            lat,
            lon,
            altFt: Number.isFinite(altFt) ? Math.max(0, altFt) : 0,
            gsKt,
            headingDeg: decoded ? decoded.headingDeg : 0,
            squawk: squawkByCallsign.get(callsign),
            hasExplicitHeading: decoded !== null,
          };
          packetSeqInSecond++;
          pilotPackets++;
          const list = samplesByCallsign.get(callsign);
          if (list) list.push(sample);
          else samplesByCallsign.set(callsign, [sample]);
        }
      }
      continue;
    }

    // 7. CSV fallback: TIME_SEC,CALLSIGN,LAT,LON,ALT_FT,GS_KT,HDG[,CONTROLLER]
    if (!line.startsWith('#') && !line.startsWith('$') && line.includes(',')) {
      const cols = line.split(',').map((c) => c.trim());
      if (cols.length >= 5) {
        const t = Number(cols[0]);
        const callsign = cols[1];
        const lat = Number(cols[2]);
        const lon = Number(cols[3]);
        const altFt = Number(cols[4]);
        const gsKt = Number(cols[5] ?? 250);
        const hdg = Number(cols[6]);
        const explicitCtrl = cols[7] ? cols[7].trim() : undefined;
        if (
          Number.isFinite(t) &&
          callsign &&
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          Number.isFinite(altFt)
        ) {
          pilotPackets++;
          if (explicitCtrl) {
            recordControllerEvent(callsign, t, explicitCtrl);
          }
          const sample: RadarSample = {
            timeSec: t,
            lat,
            lon,
            altFt: Math.max(0, altFt),
            gsKt: Number.isFinite(gsKt) ? gsKt : 0,
            headingDeg: Number.isFinite(hdg) ? ((hdg % 360) + 360) % 360 : 0,
            hasExplicitHeading: Number.isFinite(hdg),
            controllerCallsign: explicitCtrl,
          };
          const list = samplesByCallsign.get(callsign);
          if (list) list.push(sample);
          else samplesByCallsign.set(callsign, [sample]);
        }
      }
    }
  }

  const center = detectedCenter ?? fallbackCenter;
  const projector = new LocalENUProjector(center);

  const tracks: AircraftTrack[] = [];
  let minTime = Infinity;
  let maxTime = -Infinity;

  // Post-process controllerEvents across all tracks to eliminate EuroScope disconnect & handoff glitches:
  // 1) Mass DR disconnect bursts (>= 3 distinct aircraft dropped within 8s)
  // 2) Mass synchronized glitch waves (>= 3 aircraft jumping to same sector within 15s and >= 2 reverting within 210s)
  // 3) Brief DR gaps (<= 180s same-sector reconnect, <= 45s cross-sector handoff gap)
  // 4) Brief single-aircraft round-trip excursions A -> B -> A lasting <= 120s (e.g. ~1 min RADAR -> APP -> RADAR)
  cleanControllerTimelines(controllerEventsByCallsign);

  for (const [callsign, rawSamples] of samplesByCallsign.entries()) {
    const localSamples = rawSamples.filter(
      (s) => LocalENUProjector.distanceKm(center, { lat: s.lat, lon: s.lon }) <= maxRadiusKm,
    );
    if (localSamples.length === 0) continue;

    const segments = segmentSamples(localSamples, MAX_RADAR_GAP_SEC);

    for (const seg of segments) {
      for (let i = 0; i < seg.samples.length; i++) {
        const s = seg.samples[i];
        if (!s.hasExplicitHeading && seg.samples.length >= 2) {
          const a = i < seg.samples.length - 1 ? seg.samples[i] : seg.samples[i - 1];
          const b = i < seg.samples.length - 1 ? seg.samples[i + 1] : seg.samples[i];
          const pA = projector.toENU(a.lat, a.lon, a.altFt);
          const pB = projector.toENU(b.lat, b.lon, b.altFt);
          if (Math.hypot(pB.x - pA.x, pB.z - pA.z) > 0.001) {
            s.headingDeg = LocalENUProjector.headingFromDeltaXZ(pB.x - pA.x, pB.z - pA.z);
          }
        }
      }
    }

    const firstSeen = segments[0].startTime;
    const lastSeen = segments[segments.length - 1].endTime;
    minTime = Math.min(minTime, firstSeen);
    maxTime = Math.max(maxTime, lastSeen);

    const fp = flightPlans.get(callsign);
    const ctrlEvents = controllerEventsByCallsign.get(callsign.toUpperCase());

    tracks.push({
      callsign,
      squawk: squawkByCallsign.get(callsign) ?? '2000',
      flightPlan: fp,
      samples: segments.flatMap((seg) => seg.samples),
      segments,
      firstSeen,
      lastSeen,
      clearedFl: fp && fp.cruiseAltFt > 0 ? Math.round(fp.cruiseAltFt / 100) : undefined,
      controllerEvents: ctrlEvents && ctrlEvents.length > 0 ? ctrlEvents : undefined,
    });
  }

  tracks.sort((a, b) => a.callsign.localeCompare(b.callsign));

  if (pilotPackets === 0) {
    warnings.push(
      `No pilot position packets (@ or ^) found in "${sourceName}". Detected ${atcStationsMap.size} ATC position(s) and ${flightPlans.size} flight plan(s). Full EuroScope FSD logs begin emitting @N: / ^ pilot updates after initial server handshake.`,
    );
  }

  return {
    sourceName,
    center,
    startTime: Number.isFinite(minTime) ? minTime : 0,
    endTime: Number.isFinite(maxTime) ? Math.max(maxTime, minTime + 10) : 60,
    tracks,
    atcStations: Array.from(atcStationsMap.values()),
    diagnostics: {
      totalLines: lines.length,
      pilotPackets,
      flightPlans: flightPlans.size,
      controllerEvents: controllerEventCount,
      warnings,
    },
  };
}

/**
 * Clean EuroScope controller timelines across all aircraft to remove disconnect/reconnect glitches:
 *  - Mass DR bursts (>= 3 aircraft dropped within 8s)
 *  - Mass synchronized takeover waves (>= 3 aircraft jumping to same sector within 15s and >= 2 reverting within 210s)
 *  - Short DR reconnect gaps (up to 180s when re-acquired by same sector, up to 45s across handoff)
 *  - Short round-trip excursions A -> B -> A lasting <= 120s (e.g. ~1 min RADAR -> APP -> RADAR error)
 */
export function cleanControllerTimelines(
  controllerEventsByCallsign: Map<string, ControllerEvent[]>,
  options?: {
    maxRoundTripSec?: number;
    maxSameSectorDropSec?: number;
    maxCrossSectorDropSec?: number;
    massWaveRevertSec?: number;
  },
): void {
  const maxRoundTripSec = options?.maxRoundTripSec ?? 120;
  const maxSameSectorDropSec = options?.maxSameSectorDropSec ?? 180;
  const maxCrossSectorDropSec = options?.maxCrossSectorDropSec ?? 45;
  const massWaveRevertSec = options?.massWaveRevertSec ?? 210;

  // Step 1: Sort each track's events chronologically
  for (const evs of controllerEventsByCallsign.values()) {
    evs.sort((a, b) => a.timeSec - b.timeSec);
  }

  // Step 2: Detect and suppress mass DR disconnect bursts (>= 3 distinct aircraft within 8s)
  const allDropPoints: Array<{ callsignKey: string; timeSec: number }> = [];
  for (const [csKey, evs] of controllerEventsByCallsign.entries()) {
    for (const ev of evs) {
      if (ev.controllerCallsign === null) {
        allDropPoints.push({ callsignKey: csKey, timeSec: ev.timeSec });
      }
    }
  }
  const isMassDisconnectTime = (t: number): boolean => {
    const distinct = new Set<string>();
    for (let i = 0; i < allDropPoints.length; i++) {
      if (Math.abs(allDropPoints[i].timeSec - t) <= 8) {
        distinct.add(allDropPoints[i].callsignKey);
        if (distinct.size >= 3) return true;
      }
    }
    return false;
  };
  for (const [csKey, evs] of controllerEventsByCallsign.entries()) {
    controllerEventsByCallsign.set(
      csKey,
      evs.filter((ev) => ev.controllerCallsign !== null || !isMassDisconnectTime(ev.timeSec)),
    );
  }

  // Step 3: Detect mass synchronized glitch waves (e.g. RADAR disconnects -> >= 3 tracks jump to APP within 15s,
  //         and >= 2 of them revert to their previous sector within massWaveRevertSec)
  interface ActiveFlip {
    callsignKey: string;
    evIndex: number;
    timeSec: number;
    fromCode: string;
    toCode: string;
    revertsWithinWindow: boolean;
  }
  const flips: ActiveFlip[] = [];
  for (const [csKey, evs] of controllerEventsByCallsign.entries()) {
    for (let i = 1; i < evs.length; i++) {
      const prev = evs[i - 1];
      const curr = evs[i];
      if (!prev.controllerCallsign || !curr.controllerCallsign) continue;
      if (prev.sectorCode === curr.sectorCode) continue;

      let reverts = false;
      for (let j = i + 1; j < evs.length; j++) {
        if (evs[j].timeSec - curr.timeSec > massWaveRevertSec) break;
        if (evs[j].controllerCallsign && evs[j].sectorCode === prev.sectorCode) {
          reverts = true;
          break;
        }
      }
      flips.push({
        callsignKey: csKey,
        evIndex: i,
        timeSec: curr.timeSec,
        fromCode: prev.sectorCode,
        toCode: curr.sectorCode,
        revertsWithinWindow: reverts,
      });
    }
  }

  const removeIndicesByCallsign = new Map<string, Set<number>>();
  for (let i = 0; i < flips.length; i++) {
    const f = flips[i];
    const cluster = flips.filter(
      (other) => other.toCode === f.toCode && Math.abs(other.timeSec - f.timeSec) <= 15,
    );
    const distinctAc = new Set(cluster.map((c) => c.callsignKey));
    const revertingAc = new Set(
      cluster.filter((c) => c.revertsWithinWindow).map((c) => c.callsignKey),
    );
    if (distinctAc.size >= 3 && revertingAc.size >= 2) {
      for (const member of cluster) {
        // Strip the glitch takeover for every aircraft in the synchronized disconnect wave
        // that either reverts or stayed under the glitch target briefly
        const set = removeIndicesByCallsign.get(member.callsignKey) ?? new Set<number>();
        set.add(member.evIndex);
        removeIndicesByCallsign.set(member.callsignKey, set);
      }
    }
  }
  for (const [csKey, removeSet] of removeIndicesByCallsign.entries()) {
    const evs = controllerEventsByCallsign.get(csKey);
    if (!evs) continue;
    controllerEventsByCallsign.set(
      csKey,
      evs.filter((_, idx) => !removeSet.has(idx)),
    );
  }

  // Step 4: Iterative per-aircraft cleanup (coalesce duplicates, remove short DR gaps, remove <= 120s A -> B -> A bounces)
  for (const [csKey, rawEvs] of controllerEventsByCallsign.entries()) {
    let evs = [...rawEvs];
    let changed = true;
    let guard = 0;

    while (changed && guard < 12) {
      changed = false;
      guard++;

      // 4a. Coalesce consecutive duplicate sectorCodes / consecutive nulls
      const deduped: ControllerEvent[] = [];
      for (const ev of evs) {
        const prev = deduped[deduped.length - 1];
        if (
          prev &&
          ((prev.controllerCallsign === null && ev.controllerCallsign === null) ||
            (prev.controllerCallsign !== null &&
              ev.controllerCallsign !== null &&
              prev.sectorCode === ev.sectorCode))
        ) {
          changed = true;
          continue;
        }
        deduped.push(ev);
      }
      evs = deduped;

      // 4b. Remove short DR (null) gaps between active controllers
      const afterDrops: ControllerEvent[] = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.controllerCallsign === null) {
          const prev = afterDrops[afterDrops.length - 1];
          let nextActive: ControllerEvent | null = null;
          for (let j = i + 1; j < evs.length; j++) {
            if (evs[j].controllerCallsign !== null) {
              nextActive = evs[j];
              break;
            }
          }
          if (nextActive) {
            const gapSec = nextActive.timeSec - ev.timeSec;
            const sameSectorReconnect =
              prev && prev.controllerCallsign !== null && prev.sectorCode === nextActive.sectorCode;
            if (
              (sameSectorReconnect && gapSec <= maxSameSectorDropSec) ||
              gapSec <= maxCrossSectorDropSec
            ) {
              changed = true;
              continue;
            }
          }
        }
        afterDrops.push(ev);
      }
      evs = afterDrops;

      // 4c. Remove brief round-trip excursions A -> B -> A lasting <= maxRoundTripSec (e.g. RADAR -> APP -> RADAR ~1-2 min)
      const afterBounce: ControllerEvent[] = [];
      for (let i = 0; i < evs.length; i++) {
        const curr = evs[i];
        const prev = afterBounce[afterBounce.length - 1];
        const next = i + 1 < evs.length ? evs[i + 1] : null;
        if (
          prev &&
          prev.controllerCallsign !== null &&
          curr.controllerCallsign !== null &&
          next &&
          next.controllerCallsign !== null &&
          prev.sectorCode === next.sectorCode &&
          curr.sectorCode !== prev.sectorCode &&
          next.timeSec - curr.timeSec <= maxRoundTripSec
        ) {
          changed = true;
          continue;
        }
        afterBounce.push(curr);
      }
      evs = afterBounce;
    }

    controllerEventsByCallsign.set(csKey, evs);
  }
}

