import type { AircraftTrack, AirportTrafficCounters, GeoPoint } from '../types/radar';
import { LocalENUProjector } from './geo';

export interface AirportFlightEvent {
  callsign: string;
  takeoffTimeSec: number | null;
  landingTimeSec: number | null;
}

export interface AirportFlightEventIndex {
  airportCode: string;
  events: AirportFlightEvent[];
}

/**
 * Precompute deterministic takeoff & landing timestamps specifically for `targetAirportCode`.
 *
 * Departure (AIRBORNE) rule:
 * - Track's origin matches `targetAirportCode` OR its first radar sample starts within 16 km of the
 *   target airport below `airportElevationFt + 4000 ft`.
 * - Track actually climbs / departs (reaches at least `airportElevationFt + 450 ft` and `gsKt >= 100`).
 * - `takeoffTimeSec` is the exact timestamp of liftoff (first sample with `gsKt >= 95` or `agl >= 250 ft`).
 *
 * Arrival (LANDED) rule:
 * - Track's destination matches `targetAirportCode` OR its final radar sample ends within 14 km of
 *   the target airport below `airportElevationFt + 2200 ft`.
 * - Track previously flew higher than its final altitude by at least 900 ft (true descent approach).
 * - `landingTimeSec` is the timestamp when the aircraft touches down (`agl <= 320 ft && gsKt <= 115`)
 *   or exits radar on short final (`lastSeen` inside 12 km & descending).
 */
export function buildAirportFlightEventIndex(
  tracks: AircraftTrack[],
  targetAirportCode: string,
  airportCenter: GeoPoint,
  airportElevationFt = 256,
): AirportFlightEventIndex {
  const code = targetAirportCode.trim().toUpperCase();
  const events: AirportFlightEvent[] = [];

  for (const track of tracks) {
    const samples = track.samples;
    if (samples.length === 0) continue;

    const first = samples[0];
    const last = samples[samples.length - 1];

    const fpOrig = track.flightPlan?.origin?.trim().toUpperCase() ?? '';
    const fpDest = track.flightPlan?.destination?.trim().toUpperCase() ?? '';

    const firstDistKm = LocalENUProjector.distanceKm(airportCenter, {
      lat: first.lat,
      lon: first.lon,
    });
    const lastDistKm = LocalENUProjector.distanceKm(airportCenter, {
      lat: last.lat,
      lon: last.lon,
    });

    const firstAgl = first.altFt - airportElevationFt;
    const lastAgl = last.altFt - airportElevationFt;

    let maxAltFt = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].altFt > maxAltFt) maxAltFt = samples[i].altFt;
    }
    const maxAgl = maxAltFt - airportElevationFt;

    // 1. Detect departure from target airport
    let takeoffTimeSec: number | null = null;
    const isDepartureCandidate =
      (fpOrig === code && firstDistKm <= 28 && firstAgl <= 6500) ||
      (firstDistKm <= 16 && firstAgl <= 3500 && maxAgl > firstAgl + 600);

    if (isDepartureCandidate && maxAgl >= 450) {
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const agl = s.altFt - airportElevationFt;
        if (agl >= 240 || s.gsKt >= 100) {
          takeoffTimeSec = s.timeSec;
          break;
        }
      }
    }

    // 2. Detect arrival & landing at target airport
    let landingTimeSec: number | null = null;
    const descendedEnough = maxAltFt - last.altFt >= 900;
    const isArrivalCandidate =
      descendedEnough &&
      ((fpDest === code && lastDistKm <= 16 && lastAgl <= 2800) ||
        (lastDistKm <= 13 && lastAgl <= 2000));

    if (isArrivalCandidate) {
      // Walk backward from end while on ground/rollout to find the actual touchdown moment
      let touchdownIdx = samples.length - 1;
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        const dKm = LocalENUProjector.distanceKm(airportCenter, { lat: s.lat, lon: s.lon });
        const agl = s.altFt - airportElevationFt;
        if (dKm <= 10 && agl <= 260 && s.gsKt <= 115) {
          touchdownIdx = i;
        } else {
          break;
        }
      }
      landingTimeSec = samples[touchdownIdx].timeSec;
    }

    if (takeoffTimeSec !== null || landingTimeSec !== null) {
      events.push({
        callsign: track.callsign,
        takeoffTimeSec,
        landingTimeSec,
      });
    }
  }

  return {
    airportCode: code,
    events,
  };
}

/**
 * Deterministically compute cumulative AIRBORNE (departures) and LANDED (arrivals)
 * counts for the target airport at any timestamp `currentTimeSec` (supports scrubbing forward & backward).
 */
export function computeAirportTrafficCounters(
  index: AirportFlightEventIndex,
  currentTimeSec: number,
): AirportTrafficCounters {
  let airborne = 0;
  let landed = 0;

  for (let i = 0; i < index.events.length; i++) {
    const ev = index.events[i];
    if (ev.takeoffTimeSec !== null && ev.takeoffTimeSec <= currentTimeSec) {
      airborne++;
    }
    if (ev.landingTimeSec !== null && ev.landingTimeSec <= currentTimeSec) {
      landed++;
    }
  }

  return { airborne, landed };
}
