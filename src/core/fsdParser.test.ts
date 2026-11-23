import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeFsdPbh,
  encodeFsdPbh,
  parseEuroScopeFsdLog,
  parseTimestampHeader,
} from './fsdParser';

test('PBH bitfield encodes and decodes heading, bank, pitch accurately', () => {
  const pbh = encodeFsdPbh(205, 12, 4, false);
  const decoded = decodeFsdPbh(pbh);
  assert.ok(Math.abs(decoded.headingDeg - 205) < 0.5, `Got hdg ${decoded.headingDeg}`);
  assert.ok(Math.abs(decoded.bankDeg - 12) < 0.5, `Got bank ${decoded.bankDeg}`);
  assert.ok(Math.abs(decoded.pitchDeg - 4) < 0.5, `Got pitch ${decoded.pitchDeg}`);
  assert.equal(decoded.onGround, false);
});

test('parseTimestampHeader parses EuroScope log brackets', () => {
  assert.equal(parseTimestampHeader('[16:00:40 >>>> UWGG_R_APP]'), 16 * 3600 + 40);
  assert.equal(parseTimestampHeader('[23:59:59 <<<2 UWGG_R_APP]'), 23 * 3600 + 59 * 60 + 59);
  assert.equal(parseTimestampHeader('@N:AUL510:4215:1:56.23:43.78:6600:250:0:0'), null);
});

test('parseEuroScopeFsdLog parses @, ^, %, $FP packets, midnight rollover, and gap splitting', () => {
  const pbhNorth = encodeFsdPbh(10);
  const sampleLog = `
[23:59:50 <<<2 UWGG_R_APP]
%UWGG_R_APP:99998:5:150:5:56.23000:43.78417:0

[23:59:52 >>>> UWGG_R_APP]
$FPAUL510:*A:I:B738/M-SDE1FGHILORVWXY/HB1:437:UWGG:1600:1600:36000:ULLI:1:30:2:00:UUEE:RMK:LARNO2U LARNO

[23:59:55 >>>> UWGG_R_APP]
@N:AUL510:4215:1:56.24000:43.79000:4500:240:${pbhNorth}:0

[00:00:05 >>>> UWGG_R_APP]
@N:AUL510:4215:1:56.25000:43.79200:5200:255:${pbhNorth}:0

[00:02:30 >>>> UWGG_R_APP]
^AUL510:56.28000:43.80000:9000:9100:${pbhNorth}:10:0:-120:0:0:0:0
`;

  const dataset = parseEuroScopeFsdLog(sampleLog, 'test.txt');
  assert.equal(dataset.atcStations.length, 1);
  assert.equal(dataset.atcStations[0].callsign, 'UWGG_R_APP');
  assert.equal(dataset.tracks.length, 1);

  const track = dataset.tracks[0];
  assert.equal(track.callsign, 'AUL510');
  assert.equal(track.flightPlan?.destination, 'ULLI');
  assert.equal(track.flightPlan?.cruiseAltFt, 36000);
  assert.equal(track.samples.length, 3);
  // 00:00:05 rolled over midnight to 86405
  assert.ok(track.samples[1].timeSec > 86400);
  // Gap from 00:00:05 to 00:02:30 (145s > 60s) should split into 2 segments
  assert.equal(track.segments.length, 2);
});

test('parseEuroScopeFsdLog gracefully parses attached user handshake snippet without crashing', () => {
  const attachedPath = 'public/assets/aistudio/_______ea65dd28.txt';
  if (fs.existsSync(attachedPath)) {
    const text = fs.readFileSync(attachedPath, 'utf-8');
    const dataset = parseEuroScopeFsdLog(text, 'attached.txt');
    assert.equal(dataset.atcStations.length, 1);
    assert.equal(dataset.atcStations[0].callsign, 'UWGG_R_APP');
    assert.ok(Math.abs(dataset.center.lat - 56.23) < 0.001);
    assert.ok(dataset.diagnostics.flightPlans >= 2);
    assert.equal(dataset.diagnostics.warnings.length, 1);
  }
});
