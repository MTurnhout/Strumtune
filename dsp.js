/* Strumtune DSP core: polyphonic (strum) and monophonic (single string) pitch analysis.
 * Works in the browser (window.TunerDSP) and in Node (module.exports) for testing. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TunerDSP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- notes ----------
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function parseNote(str) {
    const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(-?\d)\s*$/.exec(String(str));
    if (!m) return null;
    let pc = PC[m[1].toUpperCase()];
    if (m[2] === '#' || m[2] === '♯') pc += 1;
    if (m[2] === 'b' || m[2] === '♭') pc -= 1;
    return (parseInt(m[3], 10) + 1) * 12 + pc;
  }
  function midiName(midi) {
    const n = Math.round(midi);
    return SHARP_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
  }
  const midiToFreq = (m, a4 = 440) => a4 * Math.pow(2, (m - 69) / 12);
  const freqToMidi = (f, a4 = 440) => 69 + 12 * Math.log2(f / a4);
  const cents = (f, ref) => 1200 * Math.log2(f / ref);

  // Nominal string inharmonicity: partial h sits at h*f0*sqrt(1+B h^2).
  const B_NOM = 5e-5;
  const inh = (h) => Math.sqrt((1 + B_NOM * h * h) / (1 + B_NOM));

  // ---------- FFT (radix-2, in place) ----------
  class FFT {
    constructor(n) {
      this.n = n;
      const levels = Math.round(Math.log2(n));
      if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        this.cos[i] = Math.cos((2 * Math.PI * i) / n);
        this.sin[i] = Math.sin((2 * Math.PI * i) / n);
      }
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0, x = i;
        for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
        this.rev[i] = r;
      }
    }
    transform(re, im) {
      const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cs[k] + im[l] * sn[k];
            const tim = im[l] * cs[k] - re[l] * sn[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    }
  }

  // ---------- long-window spectrum + peak picking ----------
  class Spectrum {
    constructor(sr, N) {
      this.sr = sr; this.N = N;
      this.fft = new FFT(N);
      this.re = new Float64Array(N);
      this.im = new Float64Array(N);
      this.wins = new Map();
    }
    hann(L) {
      let w = this.wins.get(L);
      if (!w) {
        const arr = new Float64Array(L);
        let sum = 0;
        for (let i = 0; i < L; i++) { arr[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1)); sum += arr[i]; }
        w = { arr, sum };
        if (this.wins.size > 64) this.wins.clear();
        this.wins.set(L, w);
      }
      return w;
    }
    // seg: Float32Array of length L <= N (time order). Returns dB magnitudes up to fmax.
    compute(seg, fmax) {
      const L = seg.length, N = this.N, re = this.re, im = this.im;
      const { arr: w, sum } = this.hann(L);
      let mean = 0;
      for (let i = 0; i < L; i++) mean += seg[i];
      mean /= L;
      re.fill(0); im.fill(0);
      for (let i = 0; i < L; i++) re[i] = (seg[i] - mean) * w[i];
      this.fft.transform(re, im);
      const binHz = this.sr / N;
      const kmax = Math.min(N / 2 - 2, Math.ceil(fmax / binHz) + 4);
      const db = new Float32Array(kmax + 1);
      const scale = 2 / sum;
      for (let k = 0; k <= kmax; k++) db[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) * scale + 1e-12);
      return { db, binHz, L, res: this.sr / L };
    }
  }

  function findPeaks(spec, fmin, fmax, opt = {}) {
    const snr = opt.snrDb ?? 12, range = opt.rangeDb ?? 50, minDb = opt.minDb ?? -Infinity;
    const { db, binHz, res } = spec;
    const k0 = Math.max(2, Math.floor(fmin / binHz)), k1 = Math.min(db.length - 2, Math.ceil(fmax / binHz));
    // noise floor: 25th percentile in blocks
    const blk = Math.max(16, Math.round(Math.max(80, 16 * res) / binHz));
    const floor = new Float32Array(db.length).fill(-200);
    for (let s = k0; s <= k1; s += blk) {
      const e = Math.min(k1 + 1, s + blk);
      const v = Array.from(db.subarray(s, e)).sort((a, b) => a - b);
      const f = v[Math.floor(v.length * 0.25)];
      for (let k = s; k < e; k++) floor[k] = f;
    }
    let maxDb = -Infinity;
    for (let k = k0; k <= k1; k++) if (db[k] > maxDb) maxDb = db[k];
    const raw = [];
    for (let k = k0; k <= k1; k++) {
      const b = db[k];
      if (b > db[k - 1] && b >= db[k + 1] && b > floor[k] + snr && b > maxDb - range && b > minDb) {
        const a = db[k - 1], c = db[k + 1], den = a - 2 * b + c;
        const d = den < 0 ? (0.5 * (a - c)) / den : 0;
        raw.push({ f: (k + d) * binHz, db: b - 0.25 * (a - c) * d, snr: b - floor[k] });
      }
    }
    // suppress window sidelobes and ripple next to much stronger peaks
    raw.sort((p, q) => q.db - p.db);
    const kept = [];
    for (const q of raw) {
      let ok = true;
      for (const p of kept) {
        const df = Math.abs(p.f - q.f);
        if (df < 0.8 * res || (df < 3 * res && q.db < p.db - 15) || (df < 10 * res && q.db < p.db - 30)) { ok = false; break; }
      }
      if (ok) kept.push(q);
    }
    kept.sort((p, q) => p.f - q.f);
    return { peaks: kept, maxDb };
  }

  // ---------- tuning plan: which harmonics of which string can collide ----------
  function prepareTuning(targets, opt = {}) {
    const R = opt.rangeCents ?? 60, margin = opt.marginCents ?? 20;
    const fmax = opt.fmax ?? 2000, hMax = opt.hMax ?? 10, kMax = opt.kMax ?? 30;
    const n = targets.length;
    const harms = [];
    for (let i = 0; i < n; i++) {
      const list = [];
      for (let h = 1; h <= hMax; h++) {
        const c = h * targets[i] * inh(h);
        if (c > fmax) break;
        const lo = c * Math.pow(2, -R / 1200), hi = c * Math.pow(2, R / 1200);
        const comps = [];
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          for (let k = 1; k <= kMax; k++) {
            const pk = k * targets[j] * inh(k);
            if (pk > hi * 1.1) break;
            if (Math.abs(cents(pk, c)) < R + margin) comps.push({ j, k });
          }
        }
        list.push({ h, c, lo, hi, comps, clean: comps.length === 0 });
      }
      harms.push(list);
    }
    const order = targets.map((t, i) => i).sort((a, b) => targets[a] - targets[b]);
    return { targets: targets.slice(), harms, order, R, fmax };
  }

  // ---------- polyphonic analysis ----------
  const lin = (db) => Math.pow(10, db / 20);

  function combine(ev) {
    if (!ev.length) return null;
    // Anchor on the lowest harmonic found (least likely to be blended with another string's partial).
    let anchor = ev[0];
    for (const e of ev) if (e.h < anchor.h) anchor = e;
    let sw = 0, sl = 0;
    for (const e of ev) {
      if (Math.abs(cents(e.est, anchor.est)) < 5) {
        const w = lin(e.db) / (e.h * e.h);
        sw += w; sl += w * Math.log2(e.est);
      }
    }
    return Math.pow(2, sl / sw);
  }

  function analyzePoly(plan, peaks, res) {
    const n = plan.targets.length;
    const inWin = (lo, hi) => peaks.filter((p) => p.f >= lo && p.f <= hi);
    const strongest = (ps) => ps.reduce((a, p) => (p.db > a.db ? p : a), ps[0]);
    const st = plan.targets.map(() => ({ clean: [], extra: [], merged: [], det: false, mergedOnly: false, est: null, maxDb: -Infinity }));

    // Support: a string counts only if its fundamental, or both its 2nd and 3rd harmonics, show a peak.
    // This stops a lower string being "found" purely from an octave-higher string's partials.
    const support = plan.harms.map((list) => {
      const has = (h) => { const hm = list.find((x) => x.h === h); return hm ? inWin(hm.lo, hm.hi).length > 0 : false; };
      return has(1) || (has(2) && has(3));
    });

    const finalize = (i) => {
      const s = st[i];
      const indep = s.clean.concat(s.extra);
      s.det = false; s.mergedOnly = false; s.est = null; s.maxDb = -Infinity;
      if (!support[i]) return;
      // Independent only with unexplained evidence among the first three harmonics; otherwise the string
      // may just be another string's overtones (or in tune with them), so it is shown as "shared".
      if (indep.some((e) => e.h <= 3)) {
        s.det = true; s.est = combine(indep);
        for (const e of indep) s.maxDb = Math.max(s.maxDb, e.db);
      } else if (indep.length || s.merged.length) {
        const all = indep.concat(s.merged);
        s.det = true; s.mergedOnly = true;
        s.est = all.reduce((a, e) => (e.h < a.h ? e : a), all[0]).est;
      }
    };

    // Scan one string's harmonics from low to high. The first usable peak sets a guide pitch; later harmonics
    // take the candidate closest to h * guide, so an octave-higher string's peak is not mistaken for ours.
    // Match tolerance grows with partial number because real inharmonicity differs from the nominal value.
    const slack = (k) => 2 + 0.06 * (k * k - 1);
    const tol = (pr) => Math.max(0.7 * res, pr.f * (Math.pow(2, slack(pr.k) / 1200) - 1));
    const scan = (i, cleanOnly) => {
      const s = st[i];
      s.clean = []; s.extra = []; s.merged = [];
      let guide = null, baseDb = -Infinity;
      for (const hm of plan.harms[i]) {
        if (cleanOnly && !hm.clean) continue;
        const ps = inWin(hm.lo, hm.hi);
        if (!ps.length) continue;
        const preds = [];
        for (const c of hm.comps) {
          const o = st[c.j];
          if (o.det && !o.mergedOnly) preds.push({ f: c.k * o.est * inh(c.k), j: c.j, k: c.k });
        }
        const est = (p) => p.f / (hm.h * inh(hm.h));
        // A string's upper harmonic is never far louder than its own lower ones; a much louder peak there
        // belongs to another string (e.g. a faintly ringing A2 must not claim a plucked E4 as its 3rd harmonic).
        const plausible = (p) => baseDb === -Infinity || p.db <= baseDb + 20;
        const pick = (all) => {
          const cands = all.filter(plausible);
          if (!cands.length) return null;
          if (guide == null) return strongest(cands);
          let best = null, bd = Infinity;
          for (const p of cands) { const d = Math.abs(cents(est(p), guide)); if (d < bd) { bd = d; best = p; } }
          return bd < 2 + slack(hm.h) ? best : null;
        };
        const un = ps.filter((p) => !preds.some((pr) => Math.abs(p.f - pr.f) < tol(pr)));
        let e = null;
        if (un.length) {
          const p = pick(un);
          if (p) { e = { h: hm.h, f: p.f, db: p.db, est: est(p), kind: hm.clean ? 'clean' : 'resolved' }; (hm.clean ? s.clean : s.extra).push(e); }
        } else {
          const p = pick(ps);
          if (p) {
            let compRef = -Infinity;
            for (const pr of preds) compRef = Math.max(compRef, st[pr.j].maxDb);
            e = { h: hm.h, f: p.f, db: p.db, est: est(p) };
            if (p.db > compRef + 6) { e.kind = 'dominant'; s.extra.push(e); }
            else { e.kind = 'merged'; s.merged.push(e); }
          }
        }
        if (e && guide == null) guide = e.est;
        if (e) baseDb = Math.max(baseDb, e.db);
      }
      finalize(i);
    };

    // Pass A: only harmonics no other string can reach (seeds the competitor estimates).
    for (let i = 0; i < n; i++) scan(i, true);
    // Pass B: all harmonics, explaining shared peaks away with the other strings' current estimates.
    for (let iter = 0; iter < 3; iter++) for (const i of plan.order) scan(i, false);

    return st.map((s, i) => ({
      detected: s.det,
      independent: s.det && !s.mergedOnly,
      shared: s.mergedOnly,
      freq: s.est,
      cents: s.est ? cents(s.est, plan.targets[i]) : null,
      level: s.mergedOnly ? Math.max(...s.merged.concat(s.extra).map((e) => e.db)) : s.maxDb,
      evidence: s.clean.concat(s.extra, s.merged).map((e) => e.kind[0] + e.h),
    }));
  }

  // ---------- monophonic: McLeod pitch method (NSDF via FFT) ----------
  class MonoDetector {
    constructor() { this.cache = new Map(); }
    detect(x, sr, minF, maxF) {
      const n = x.length;
      let N = 1; while (N < 2 * n) N <<= 1;
      let c = this.cache.get(N);
      if (!c) { c = { fft: new FFT(N), re: new Float64Array(N), im: new Float64Array(N) }; this.cache.set(N, c); }
      const { fft, re, im } = c;
      let mean = 0;
      for (let i = 0; i < n; i++) mean += x[i];
      mean /= n;
      re.fill(0); im.fill(0);
      const S = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) { const v = x[i] - mean; re[i] = v; S[i + 1] = S[i] + v * v; }
      fft.transform(re, im);
      for (let k = 0; k < N; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
      fft.transform(re, im); // real, symmetric input -> autocorrelation * N
      const maxLag = Math.min(n - 2, Math.ceil(sr / minF) + 2);
      const minLag = Math.max(2, Math.floor(sr / maxF));
      const nsdf = new Float64Array(maxLag + 2);
      for (let t = 0; t <= maxLag + 1; t++) {
        const m = S[n - t] + (S[n] - S[t]);
        nsdf[t] = m > 0 ? (2 * re[t]) / N / m : 0;
      }
      // key maxima between positive-going and negative-going zero crossings
      const keys = [];
      let t = 1;
      while (t <= maxLag && nsdf[t] > 0) t++; // skip lobe at lag 0
      let inPos = false, best = -1, bestT = -1;
      for (; t <= maxLag; t++) {
        if (!inPos && nsdf[t - 1] <= 0 && nsdf[t] > 0) { inPos = true; best = -1; bestT = -1; }
        if (inPos) {
          if (nsdf[t] > best) { best = nsdf[t]; bestT = t; }
          if (nsdf[t] <= 0 && nsdf[t - 1] > 0) { inPos = false; if (bestT >= minLag) keys.push(bestT); }
        }
      }
      if (inPos && bestT >= minLag && bestT < maxLag) keys.push(bestT);
      if (!keys.length) return { freq: null, clarity: 0 };
      let hi = 0;
      for (const k of keys) hi = Math.max(hi, nsdf[k]);
      const pick = keys.find((k) => nsdf[k] >= 0.9 * hi);
      const a = nsdf[pick - 1], b = nsdf[pick], cc = nsdf[pick + 1];
      const den = a - 2 * b + cc;
      const d = den < 0 ? (0.5 * (a - cc)) / den : 0;
      const clarity = b - 0.25 * (a - cc) * d;
      return { freq: sr / (pick + d), clarity };
    }
  }

  // Refines a rough single-note pitch from the spectral peaks of its 1st and 2nd harmonics, which avoids the
  // sharp bias inharmonic upper partials give autocorrelation.
  function refineMono(spec, seg, fRough) {
    const s = spec.compute(seg, fRough * 2.6);
    const { peaks } = findPeaks(s, fRough * 0.7, fRough * 2.6, { snrDb: 10, rangeDb: 40 });
    const ests = [];
    for (const h of [1, 2]) {
      const c = h * fRough;
      let best = null;
      for (const p of peaks) if (Math.abs(cents(p.f, c)) < 35 && (!best || p.db > best.db)) best = p;
      if (best) ests.push({ f: best.f / (h * inh(h)), w: lin(best.db) / h });
    }
    if (!ests.length) return fRough;
    // When the fundamental beats (two string polarisations, sympathetic strings) it drifts away from
    // the 2nd harmonic; then trust the stronger one instead of averaging the two.
    if (ests.length === 2 && Math.abs(cents(ests[0].f, ests[1].f)) > 3) return ests[0].w >= ests[1].w ? ests[0].f : ests[1].f;
    let sw = 0, sl = 0;
    for (const e of ests) { sw += e.w; sl += e.w * Math.log2(e.f); }
    return Math.pow(2, sl / sw);
  }

  // ---------- synthesis (demo + tests) ----------
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // Adds a plucked string into `out` (additive model: pluck-position comb, faster decay up high, inharmonicity).
  function addPluck(out, sr, o) {
    const rand = o.rand || Math.random;
    const B = o.B ?? 6e-5, beta = o.pluckPos ?? 0.18, tau0 = o.decay ?? 2.5;
    const start = Math.max(0, Math.round((o.delay || 0) * sr));
    const f0 = o.freq / Math.sqrt(1 + B);
    const nyq = sr / 2;
    for (let h = 1; h <= 40; h++) {
      const fh = h * f0 * Math.sqrt(1 + B * h * h);
      if (fh > Math.min(nyq * 0.9, 6000)) break;
      let a = (Math.abs(Math.sin(Math.PI * h * beta)) / Math.pow(h, 1.25)) * (o.amp ?? 0.2);
      if (o.lowCut) a *= fh / Math.sqrt(fh * fh + o.lowCut * o.lowCut); // crude small-mic bass roll-off
      if (a < 1e-5) continue;
      const tau = tau0 / (1 + 0.12 * Math.pow(h, 1.1));
      const w = (2 * Math.PI * fh) / sr, cw = Math.cos(w), sw = Math.sin(w);
      const ph = rand() * 2 * Math.PI;
      let re = Math.cos(ph), im = Math.sin(ph);
      const dec = Math.exp(-1 / (tau * sr));
      let env = a;
      const atk = Math.round(0.004 * sr);
      for (let i = start, c = 0; i < out.length; i++, c++) {
        const g = c < atk ? c / atk : 1;
        out[i] += env * g * im;
        const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
        env *= dec;
        if (env < 1e-6) break;
      }
    }
    // pick click
    const clickN = Math.round(0.006 * sr);
    for (let i = 0; i < clickN && start + i < out.length; i++) out[start + i] += (rand() * 2 - 1) * 0.03 * (o.amp ?? 0.2) * (1 - i / clickN);
  }

  function synthesize(sr, dur, notes, opt = {}) {
    const rand = opt.rand || Math.random;
    const out = new Float32Array(Math.round(sr * dur));
    for (const nt of notes) addPluck(out, sr, Object.assign({ rand, lowCut: opt.lowCut }, nt));
    const noise = opt.noise ?? 0.0005;
    for (let i = 0; i < out.length; i++) out[i] += (rand() * 2 - 1) * noise;
    return out;
  }

  return { refineMono, parseNote, midiName, midiToFreq, freqToMidi, cents, FFT, Spectrum, findPeaks, prepareTuning, analyzePoly, MonoDetector, synthesize, rng, inh };
});
