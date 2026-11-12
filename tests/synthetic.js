// Accuracy test on synthetic plucked strings: strums with random detunes, and single plucks.
// Usage: node tests/synthetic.js [plan]   ("plan" lists each string's collision-free harmonics)
// Set V=1 to print every reading off by more than 5 cents.
const path = require('path');
const D = require(path.join(__dirname, '..', 'dsp.js'));
const sr = 48000;
const TUNINGS = {
  standard: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
  dropD: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'],
  openG: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'],
  dadgad: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'],
  sevenB: ['B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
  bass4: ['E1', 'A1', 'D2', 'G2'],
};
const spec = new D.Spectrum(sr, 65536);
const mono = new D.MonoDetector();
const mspec = new D.Spectrum(sr, 32768);
const rand = D.rng(12345);
const R = (a, b) => a + (b - a) * rand();

function polyRun(targets, segStart, L, x) {
  const plan = D.prepareTuning(targets);
  const seg = x.subarray(segStart, segStart + L);
  const s = spec.compute(seg, plan.fmax);
  const { peaks } = D.findPeaks(s, 25, plan.fmax);
  const r = D.analyzePoly(plan, peaks, s.res); r.peaks = peaks; return r;
}

const showClean = process.argv[2] === 'plan';
for (const [name, notes] of Object.entries(TUNINGS)) {
  const targets = notes.map((n) => D.midiToFreq(D.parseNote(n)));
  if (showClean) {
    const plan = D.prepareTuning(targets);
    console.log(name, plan.harms.map((l, i) => notes[i] + ':' + l.filter((h) => h.clean).map((h) => h.h).join(',')).join('  '));
    continue;
  }
  const stat = { indep: [], shared: [], missed: 0, wrongCount: 0, monoErr: [], monoWrong: 0, singleCount: [] };
  for (let trial = 0; trial < 20; trial++) {
    const lowCut = trial % 2 ? 120 : 0;
    const det = targets.map(() => R(-35, 35));
    const x = D.synthesize(sr, 1.8, targets.map((t, i) => ({ freq: t * Math.pow(2, det[i] / 1200), delay: 0.012 * i + R(0, 0.005), amp: 0.15 * Math.pow(10, R(-6, 3) / 20), pluckPos: R(0.1, 0.25), B: R(2e-5, 1.2e-4), decay: R(1.5, 3.5) })), { rand, lowCut });
    for (const L of [65536]) {
      const r = polyRun(targets, Math.round(0.03 * sr), L, x);
      r.forEach((s, i) => {
        if (!s.detected) { stat.missed++; return; }
        const err = s.cents - det[i];
        (s.independent ? stat.indep : stat.shared).push(Math.abs(err)); if (Math.abs(err) > 5 && process.env.V) console.log('  outlier', name, notes[i], s.independent ? 'ind' : 'sh', 'err', err.toFixed(1), 'det', det.map(d=>d.toFixed(0)).join(','), s.evidence.join(' ')); if (process.env.V && Math.abs(err) > 5) console.log('    peaks', r.peaks.filter(p => Math.abs(D.cents(p.f, targets[i])) < 90).map(p => D.cents(p.f, targets[i]).toFixed(1) + '/' + p.db.toFixed(0)).join(' '), ' preds:', targets.map((t, j) => { const k = Math.round(targets[i] / t); return j !== i && Math.abs(D.cents(k * t, targets[i])) < 80 ? notes[j] + 'h' + k + '@' + (D.cents(k * t * D.inh(k), targets[i]) + det[j]).toFixed(1) : ''; }).filter(Boolean).join(' '));
      });
      if (r.filter((s) => s.independent).length < 3) stat.wrongCount++;
    }
    // single pluck
    const i = Math.floor(rand() * targets.length);
    const d1 = R(-40, 40);
    const y = D.synthesize(sr, 1.0, [{ freq: targets[i] * Math.pow(2, d1 / 1200), amp: 0.2, pluckPos: R(0.1, 0.25), B: R(2e-5, 1.2e-4) }], { rand, lowCut });
    const r1 = polyRun(targets, Math.round(0.03 * sr), Math.round(0.2 * sr), y);
    stat.singleCount.push(r1.filter((s) => s.independent).length);
    const minF = Math.min(...targets) * 0.6, maxF = Math.max(...targets) * 1.6;
    const N = Math.min(...targets) < 60 ? 8192 : 4096;
    const m = mono.detect(y.subarray(Math.round(0.1 * sr), Math.round(0.1 * sr) + N), sr, minF, maxF);
    if (m.freq) { const M2 = Math.min(...targets) < 60 ? 16384 : 8192; m.freq = D.refineMono(mspec, y.subarray(Math.round(0.1 * sr), Math.round(0.1 * sr) + M2), m.freq); }
    const truth = targets[i] * Math.pow(2, d1 / 1200);
    if (!m.freq || Math.abs(D.cents(m.freq, truth)) > 50) stat.monoWrong++;
    else stat.monoErr.push(Math.abs(D.cents(m.freq, truth)));
  }
  const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : '-');
  console.log(`${name.padEnd(9)} strum: indep n=${stat.indep.length} med=${q(stat.indep, 0.5)} p90=${q(stat.indep, 0.9)} max=${q(stat.indep, 1)} | shared n=${stat.shared.length} med=${q(stat.shared, 0.5)} p90=${q(stat.shared, 0.9)} max=${q(stat.shared, 1)} | missed=${stat.missed} lowCount=${stat.wrongCount}`);
  console.log(`${''.padEnd(9)} single: polyCounts=${stat.singleCount.join('')} mono med=${q(stat.monoErr, 0.5)} max=${q(stat.monoErr, 1)} wrong=${stat.monoWrong}`);
}
