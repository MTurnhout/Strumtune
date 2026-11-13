// Replays a recording through a copy of index.html's live engine (onset detection, 80 ms ticks,
// Auto mode decision) and prints what the tuner would show. Keep it in step with index.html.
// Usage: node tests/replay.js <audio file> [sampleRate=48000]   (needs ffmpeg on PATH; standard tuning)
// Set V=1 to print every tick instead of a sample of them.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require(path.join(__dirname, '..', 'dsp.js'));
const sr = +process.argv[3] || 48000;
const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', process.argv[2], '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30 });
const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
const notes = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
const targets = notes.map((n) => D.midiToFreq(D.parseNote(n)));
const lo = Math.min(...targets), hi = Math.max(...targets);
const fmax = Math.min(2400, Math.max(1500, hi * 5));
const nextPow2 = (v) => { let n = 1; while (n < v) n <<= 1; return n; };
const cfg = { fmax, fmin: Math.max(22, lo * 0.7), minF: Math.max(22, lo * 0.6), maxF: hi * 1.7, monoM: nextPow2(sr * (lo < 60 ? 0.17 : 0.085)) };
cfg.refineM = cfg.monoM * 2;
const plan = D.prepareTuning(targets, { fmax });
// Same as index.html: onset blocks of ~11 ms and a ~1.4 s strum window at any sample rate.
const SUB = 512 * Math.max(1, Math.round(sr / 48000));
const Npoly = nextPow2(sr * 1.3);
const RING = Math.max(1 << 19, 2 * Npoly);
const spec = new D.Spectrum(sr, Npoly), monoSpec = new D.Spectrum(sr, cfg.refineM * 4), mono = new D.MonoDetector();
const E = { ring: new Float32Array(RING), mask: RING - 1, total: 0, subAcc: 0, subN: 0, hist: [], noise: 1e-6, onset: -1, lastOnsetAt: -1e12, handledOnset: -2, onsetMode: null, lastDecided: null, monoHist: [] };
const gate = () => Math.max(E.noise * 10, 2e-8);
function onSub(ms, end) {
  const h = E.hist; let prev = 0, c = 0;
  for (let i = Math.max(0, h.length - 10); i < h.length - 1; i++) { prev += h[i]; c++; }
  prev = c ? prev / c : ms;
  if (ms > gate() && ms > 4 * prev && end - E.lastOnsetAt > 0.25 * sr) { E.onset = end - SUB; E.lastOnsetAt = end; console.log(`-- onset at ${(E.onset / sr).toFixed(2)}s`); }
  h.push(ms); if (h.length > 40) h.shift();
  if (ms > 1e-11) { if (ms < E.noise) E.noise = ms; else E.noise *= 1.002; }
}
function push(buf) { for (let k = 0; k < buf.length; k++) { const v = buf[k]; E.ring[(E.total + k) & E.mask] = v; E.subAcc += v * v; if (++E.subN === SUB) { onSub(E.subAcc / SUB, E.total + k + 1); E.subAcc = 0; E.subN = 0; } } E.total += buf.length; }
function getLast(n) { const o = new Float32Array(n), s = E.total - n; for (let i = 0; i < n; i++) o[i] = E.ring[(s + i) & E.mask]; return o; }
const tickN = Math.round(0.08 * sr); let nextTick = tickN;
const verbose = process.env.V;
for (let i = 0; i < x.length; i += 1024) {
  push(x.subarray(i, Math.min(x.length, i + 1024)));
  if (E.total < nextTick) continue; nextTick += tickN;
  const rec = getLast(2048); let ms = 0; for (const v of rec) ms += v * v; ms /= 2048;
  if (ms < gate()) continue;
  if (E.onset !== E.handledOnset) { E.handledOnset = E.onset; E.onsetMode = null; E.monoHist = []; }
  const now = E.total, since = now - Math.max(E.onset, now - 10 * sr), sinceSec = since / sr, skip = Math.round(0.03 * sr);
  const wantPoly = E.onsetMode !== 'single' || sinceSec < 0.8, wantMono = E.onsetMode !== 'strum';
  let poly = null, m = null;
  if (wantPoly && since > 0.2 * sr) {
    let L = Math.min(Npoly, since - skip); L -= L % 1024;
    const sp = spec.compute(getLast(L), cfg.fmax); const { peaks } = D.findPeaks(sp, cfg.fmin, cfg.fmax, { minDb: 10 * Math.log10(E.noise) + 10 });
    poly = D.analyzePoly(plan, peaks, sp.res); poly.loud = Math.max(-Infinity, ...poly.filter((s) => s.detected).map((s) => s.level)); poly.count = poly.filter((s) => s.independent && s.level >= poly.loud - 20).length; poly.peaks = peaks;
  }
  if (wantMono && since > 0.06 * sr) {
    const M = Math.min(cfg.monoM, Math.max(2048, since - skip));
    m = mono.detect(getLast(M), sr, cfg.minF, cfg.maxF);
    if (m.freq && m.clarity > 0.75) m.raw = m.freq, m.freq = D.refineMono(monoSpec, getLast(Math.min(cfg.refineM, Math.max(2048, since - skip))), m.freq);
  }
  if (poly && sinceSec < 0.8) { if (poly.count >= 3 && sinceSec < 0.5) E.onsetMode = 'strum'; else if (E.onsetMode !== 'strum' && m && m.clarity > 0.8) E.onsetMode = 'single'; }
  else if (!E.onsetMode && m && m.clarity > 0.9 && sinceSec >= 0.8) E.onsetMode = 'single';
  if (E.onsetMode) E.lastDecided = E.onsetMode;
  const mode = E.onsetMode || (E.lastDecided === 'single' && m && m.clarity > 0.9 ? 'single' : null);
  let near = '';
  if (m && m.freq) { let bi = 0, bd = 1e9; targets.forEach((t, j) => { const d = Math.abs(D.cents(m.freq, t)); if (d < bd) { bd = d; bi = j; } }); near = `${notes[bi]} ${D.cents(m.freq, targets[bi]).toFixed(1)}c`; }
  const line = `${(now / sr).toFixed(2)}s +${sinceSec.toFixed(2)} mode=${mode} | mono ${m && m.freq ? (m.raw || m.freq).toFixed(2) + '->' + m.freq.toFixed(2) + 'Hz cl=' + m.clarity.toFixed(2) + ' ' + near : '-'}` +
    (poly ? ` | poly n=${poly.count} [${poly.map((s, j) => s.detected ? notes[j] + (s.independent ? '' : '≈') + s.cents.toFixed(1) + '@' + (isFinite(s.level) ? s.level.toFixed(0) : '?') : '').filter(Boolean).join(' ')}]` : '');
  if (verbose || sinceSec < 1.2 || Math.round(sinceSec / 0.08) % 6 === 0) console.log(line);
}
