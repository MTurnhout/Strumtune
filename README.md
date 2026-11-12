# Strumtune

A browser guitar tuner that reads all strings from one strum and switches to single-string mode by itself when you pluck one string. Supports preset tunings (guitar, extended range, bass, ukulele, mandolin) and custom tunings with per-string cents offsets.

## Run

Open `index.html` in Chrome or Edge (keep `dsp.js` next to it) and click **Start microphone**. If the browser refuses the microphone on a local file, serve the folder:

```
python -m http.server 8000
```

and open http://localhost:8000. **Demo strum** and **Demo single string** play a synthetic, randomly detuned guitar and show the true detune under each string.

## How it works

- **Strum (polyphonic):** a Hann-windowed FFT over up to ~1.4 s (65 536 samples at 44.1/48 kHz, 131 072 at 88.2/96 kHz) since the last onset. For each string, the tuner looks for peaks near its harmonics within ±60 cents. Harmonics no other string can reach are measured first; shared harmonics are explained away using the other strings' estimates. A string counts as played only with unexplained evidence among its first three harmonics. Strings that can't be separated from another string's overtone are shown as "≈ shared".
- **Single string (monophonic):** McLeod pitch method (NSDF via FFT) for a fast rough pitch, refined from the spectral peaks of the 1st and 2nd harmonics to avoid the sharp bias that inharmonic upper partials give autocorrelation.
- **Auto mode:** per onset, three or more strings within 20 dB of the loudest in the first 0.5 s means a strum; otherwise a clear single pitch means single-string mode, on the nearest string (or the string you tapped to lock).
- **Real-world robustness:** spectral peaks must be 10 dB above the quiet-room level (removes mains hum), a string can't claim a harmonic more than 20 dB louder than its own lower harmonics (sympathetically ringing strings don't steal the plucked string), and quieter strings are not counted as played.

## Files

| File | Purpose |
|---|---|
| `index.html` | The app: UI, audio input (AudioWorklet), onset detection, mode logic, tuning editor |
| `dsp.js` | Signal processing: FFT, peak picking, tuning plan, polyphonic and monophonic analysis, synthesis for the demo and tests |
| `tests/synthetic.js` | Accuracy test on synthetic strums and plucks across several tunings |
| `tests/replay.js` | Replays a recording through a copy of the app's live engine (needs ffmpeg) |

## Tests

```
node tests/synthetic.js
node tests/replay.js path/to/recording.m4a 96000
```

`tests/replay.js` duplicates the engine logic in `index.html`; keep the two in step when changing onset, gating or mode decisions.

## Limits

- A string within a few cents of another string's exact overtone (an octave or fifth above, common in open tunings and DADGAD) can't be separated in a strum; pluck it alone for an exact reading.
- Strum readings cover about ±60 cents per string and settle during the first second.
- Built-in and phone microphones barely pick up a low E fundamental; the tuner also uses the harmonics.
