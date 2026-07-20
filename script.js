"use strict";

// Inharmonic frequency ratios for metallic (cymbal-family) synthesis —
// same idea as classic analog drum machines: several square oscillators
// at non-integer ratios, summed and highpassed, read as "metal" rather
// than a pitched tone.
const HIHAT_RATIOS = [1, 1.342, 1.2312, 1.6532, 1.9542, 2.1112];
const RIDE_RATIOS = [1, 1.5, 2.2, 2.87, 3.6, 4.2];
const CRASH_RATIOS = [1, 1.342, 1.2312, 1.6532, 1.9542, 2.1112, 2.9, 3.4];

/* ============================================================
   Audio Engine — synthesizes all sounds via Web Audio API
   ============================================================ */
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.noiseBuffer = null;
    this.masterGain = null;
    this.volume = 0.8;
    this.buffers = {};
    // Per-instrument mixer levels (1 = unity). Applied at the panner stage so
    // both sampled and synthesized fallback voices respect the same knob.
    this.trackVolume = {
      kick: 1,
      snare: 1,
      hihat: 1,
      hihatOpen: 1,
      tom: 1,
      floortom: 1,
      crash: 1,
      ride: 1,
    };
  }

  setTrackVolume(track, value) {
    this.trackVolume[track] = value;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();

      // Final output stage — volume control for everything, dry or wet.
      this.outputGain = this.ctx.createGain();
      this.outputGain.gain.value = this.volume;
      this.outputGain.connect(this.ctx.destination);

      // Drum-kit bus: kit voices (via _panner) connect here and go both dry
      // to the output AND wet through the reverb send below. Metronome
      // clicks and sticking taps connect straight to outputGain instead,
      // skipping this bus entirely — reverb blurs timing, which is exactly
      // what you don't want from a click track.
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.outputGain);
      this.noiseBuffer = this._buildNoiseBuffer();

      // Shared room reverb for the kit only. A synthesized decaying-noise
      // impulse response, rather than a real room capture, but it's what
      // turns dry one-shot hits into something that reads as "a kit in a
      // room" instead of isolated blips.
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.22;
      this.convolver = this.ctx.createConvolver();
      this.convolver.buffer = this._buildImpulseResponse();
      this.masterGain.connect(this.reverbSend);
      this.reverbSend.connect(this.convolver);
      this.convolver.connect(this.outputGain);

      this.samplesReady = this._loadSamples();

      // Some mobile browsers (older iOS Safari especially) need an actual
      // sound played — not just resume() — inside the gesture to fully
      // unlock audio output. A one-sample silent buffer does this inaudibly.
      try {
        const primer = this.ctx.createBufferSource();
        primer.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        primer.connect(this.ctx.destination);
        primer.start(0);
      } catch {
        // best-effort nudge only — safe to ignore if unsupported
      }
    }
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        // resume() can reject on some mobile browsers even mid-gesture;
        // swallow it rather than let it break the caller's await chain —
        // playback may still work, or the next tap will retry.
      }
    }
    await this.samplesReady;
    return this.ctx;
  }

  // Decode the embedded real drum/metronome samples (see samples.js) into
  // AudioBuffers. Falls back silently to synthesis per-voice if a sample
  // fails to decode.
  async _loadSamples() {
    const sources = {
      ...(typeof DRUM_SAMPLES === "undefined" ? {} : DRUM_SAMPLES),
      ...(typeof METRONOME_SAMPLES === "undefined" ? {} : METRONOME_SAMPLES),
    };
    await Promise.all(
      Object.entries(sources).map(async ([key, base64]) => {
        try {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          this.buffers[key] = await this.ctx.decodeAudioData(bytes.buffer);
        } catch {
          // leave this.buffers[key] unset — playX() falls back to synthesis
        }
      })
    );
  }

  // Plays a decoded sample through the shared panner/reverb bus, with a touch
  // of per-hit rate/gain jitter so repeats don't sound perfectly identical.
  // `key` selects the audio buffer; `volumeKey` (defaults to `key`) selects
  // which mixer slider controls it — the two differ for closed hihat, whose
  // sample is "hihatClosed" but whose mixer/track key is "hihat".
  _playSample(key, time, { pan = 0, volumeKey } = {}) {
    const buffer = this.buffers[key];
    if (!buffer) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this._jitter(1, 0.02);
    const gain = ctx.createGain();
    gain.gain.value = this._jitter(1, 0.06);
    const out = this._panner(pan, this.trackVolume[volumeKey || key] ?? 1);
    src.connect(gain).connect(out);
    src.start(time);
    return true;
  }

  _buildImpulseResponse(duration = 1.4, decayPower = 2.8) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decayPower);
      }
    }
    return impulse;
  }

  // Fixed stereo position per voice (a believable kit spread) with a touch of
  // per-hit jitter so it isn't perfectly static. Returns a panner already
  // wired to the master bus — callers connect their voice's layers into it.
  // volumeMultiplier is the per-instrument mixer level (see trackVolume) —
  // applied here so it's a single choke point both sampled and synthesized
  // voices pass through, rather than needing per-layer changes everywhere.
  _panner(panValue, volumeMultiplier = 1) {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, panValue + (Math.random() * 2 - 1) * 0.04));
    const vg = this.ctx.createGain();
    vg.gain.value = volumeMultiplier;
    p.connect(vg);
    vg.connect(this.masterGain);
    return p;
  }

  setVolume(v) {
    this.volume = v;
    if (this.outputGain) this.outputGain.gain.value = v;
  }

  _buildNoiseBuffer() {
    const seconds = 2;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _envGain(time, attack, decay, peak = 1) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(peak, time + attack);
    g.gain.exponentialRampToValueAtTime(0.001, time + attack + decay);
    return g;
  }

  // Small random variation applied to a value on every call — real drums never
  // sound identical hit to hit, so this "humanizes" pitch/gain/filter params.
  _jitter(value, pct) {
    return value * (1 + (Math.random() * 2 - 1) * pct);
  }

  // Soft-clip waveshaper for a bit of analog-style saturation/punch.
  _saturator(amount) {
    const ws = this.ctx.createWaveShaper();
    const n = 256;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * (1 + amount * 4));
    }
    ws.curve = curve;
    ws.oversample = "2x";
    return ws;
  }

  // Classic analog-drum-machine cymbal technique: several square oscillators
  // at inharmonic frequency ratios, summed and highpass-filtered, produce a
  // metallic timbre that plain filtered noise can't. Used for hihat/ride/crash.
  _metallicBurst(time, { baseFreq, ratios, hpFreq, attack, decay, peak, duration, destination }) {
    const ctx = this.ctx;
    const jitteredBase = this._jitter(baseFreq, 0.04);
    const sum = ctx.createGain();
    sum.gain.value = 1 / ratios.length;
    ratios.forEach((r) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = jitteredBase * r;
      osc.connect(sum);
      osc.start(time);
      osc.stop(time + duration);
    });
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = this._jitter(hpFreq, 0.05);
    const env = this._envGain(time, attack, decay, peak);
    sum.connect(hp).connect(env).connect(destination || this.masterGain);
  }

  // Karplus-Strong-style resonant body: a short noise "pluck" feeds a lowpassed
  // feedback delay loop tuned to `freq`. This is a lightweight physical model —
  // much closer to a real drum membrane's ringing resonance than a bare sine
  // sweep. Used for tom/floor tom bodies and layered under the snare shell.
  _karplusHit(time, { freq, decay, peak, damping = 2200, feedback = 0.9, burstDur = 0.01, destination }) {
    const ctx = this.ctx;
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 1 / freq;
    const fbGain = ctx.createGain();
    fbGain.gain.value = feedback;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = damping;

    const excite = ctx.createBufferSource();
    excite.buffer = this.noiseBuffer;
    const exciteGain = this._envGain(time, 0.0005, burstDur, 1);
    const outGain = this._envGain(time, 0.001, decay, peak);

    excite.connect(exciteGain).connect(delay);
    delay.connect(lowpass);
    lowpass.connect(fbGain).connect(delay);
    lowpass.connect(outGain).connect(destination || this.masterGain);

    excite.start(time);
    excite.stop(time + burstDur + 0.02);

    const cleanupMs = (decay + 0.3) * 1000;
    setTimeout(() => {
      try {
        delay.disconnect();
        fbGain.disconnect();
        lowpass.disconnect();
        outGain.disconnect();
      } catch {
        // nodes may already be disconnected; safe to ignore
      }
    }, cleanupMs);
  }

  // Metronome clicks intentionally connect straight to outputGain, bypassing
  // the kit's reverb bus — a click track needs to stay dry and precise.
  playClick(time, accent, timbre = "default") {
    const ctx = this.ctx;
    if (timbre === "wood") {
      this._karplusHit(time, {
        freq: accent ? 1100 : 850,
        decay: 0.05,
        peak: accent ? 1.2 : 0.9,
        damping: 3500,
        feedback: 0.65,
        destination: this.outputGain,
      });
      return;
    }
    if (timbre === "cowbell") {
      this._cowbellHit(time, accent ? 1.1 : 0.85, accent, this.outputGain);
      return;
    }
    if (timbre === "beep") {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = accent ? 2200 : 1500;
      const gain = this._envGain(time, 0.002, accent ? 0.07 : 0.045, accent ? 0.85 : 0.6);
      osc.connect(gain).connect(this.outputGain);
      osc.start(time);
      osc.stop(time + 0.1);
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = accent ? 1600 : 1000;
    const gain = this._envGain(time, 0.001, accent ? 0.08 : 0.05, accent ? 1.3 : 1);
    osc.connect(gain).connect(this.outputGain);
    osc.start(time);
    osc.stop(time + 0.1);
  }

  playSubClick(time, timbre = "default") {
    const ctx = this.ctx;
    if (timbre === "wood") {
      this._karplusHit(time, {
        freq: 1400,
        decay: 0.03,
        peak: 0.55,
        damping: 4000,
        feedback: 0.55,
        destination: this.outputGain,
      });
      return;
    }
    if (timbre === "cowbell") {
      this._cowbellHit(time, 0.45, false, this.outputGain);
      return;
    }
    if (timbre === "beep") {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = 1900;
      const gain = this._envGain(time, 0.002, 0.025, 0.35);
      osc.connect(gain).connect(this.outputGain);
      osc.start(time);
      osc.stop(time + 0.06);
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 1800;
    const gain = this._envGain(time, 0.001, 0.03, 0.45);
    osc.connect(gain).connect(this.outputGain);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  // Real acoustic cowbell hit (Latin Percussion, see samples.js) when
  // available; falls back to a classic 808-style synth cowbell.
  _cowbellHit(time, peak, accent, destination) {
    const dest = destination || this.masterGain;
    const buffer = this.buffers.cowbell;
    if (buffer) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = this._jitter(accent ? 1.03 : 1, 0.015);
      const gain = ctx.createGain();
      gain.gain.value = this._jitter(peak, 0.05);
      src.connect(gain).connect(dest);
      src.start(time);
      return;
    }
    const ctx = this.ctx;
    const detune = accent ? 1.03 : 1;
    const sum = ctx.createGain();
    sum.gain.value = 0.55;
    [587, 845].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = f * detune;
      osc.connect(sum);
      osc.start(time);
      osc.stop(time + 0.3);
    });
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 350;
    const env = this._envGain(time, 0.001, accent ? 0.2 : 0.14, peak);
    sum.connect(hp).connect(env).connect(dest);
  }

  _synthKick(time) {
    const ctx = this.ctx;
    const out = this._panner(0, this.trackVolume.kick);
    // pitched body, driven through a soft-clip saturator for analog punch
    const sat = this._saturator(0.5);
    sat.connect(out);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const startFreq = this._jitter(155, 0.02);
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(this._jitter(47, 0.05), time + 0.14);
    const gain = this._envGain(time, 0.001, 0.24, 1);
    osc.connect(gain).connect(sat);
    osc.start(time);
    osc.stop(time + 0.26);

    // beater click transient (attack realism)
    const click = ctx.createOscillator();
    click.type = "square";
    click.frequency.value = this._jitter(1800, 0.06);
    const clickGain = this._envGain(time, 0.0005, 0.012, 0.32);
    click.connect(clickGain).connect(out);
    click.start(time);
    click.stop(time + 0.02);
  }

  _synthSnare(time) {
    const ctx = this.ctx;
    const out = this._panner(-0.05, this.trackVolume.snare);
    // body tone with a light pitch drop
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    const startFreq = this._jitter(205, 0.02);
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(startFreq * 0.85, time + 0.08);
    const oscGain = this._envGain(time, 0.001, 0.1, 0.5);
    osc.connect(oscGain).connect(out);
    osc.start(time);
    osc.stop(time + 0.12);

    // shell resonance (physically-modeled ring under the noise wires)
    this._karplusHit(time, {
      freq: this._jitter(200, 0.03),
      decay: 0.09,
      peak: 0.3,
      damping: 3000,
      feedback: 0.75,
      destination: out,
    });

    // snare wires (body noise)
    const wires = ctx.createBufferSource();
    wires.buffer = this.noiseBuffer;
    const wiresFilter = ctx.createBiquadFilter();
    wiresFilter.type = "bandpass";
    wiresFilter.frequency.value = this._jitter(1800, 0.06);
    wiresFilter.Q.value = 0.6;
    const wiresGain = this._envGain(time, 0.001, 0.16, 0.9);
    wires.connect(wiresFilter).connect(wiresGain).connect(out);
    wires.start(time);
    wires.stop(time + 0.2);

    // crack transient (stick attack realism)
    const crack = ctx.createBufferSource();
    crack.buffer = this.noiseBuffer;
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = "highpass";
    crackFilter.frequency.value = 5000;
    const crackGain = this._envGain(time, 0.0005, 0.03, 0.6);
    crack.connect(crackFilter).connect(crackGain).connect(out);
    crack.start(time);
    crack.stop(time + 0.04);
  }

  _synthHihat(time, open = false) {
    const out = this._panner(-0.35, this.trackVolume[open ? "hihatOpen" : "hihat"]);
    this._metallicBurst(time, {
      baseFreq: 240,
      ratios: HIHAT_RATIOS,
      hpFreq: 7500,
      attack: 0.001,
      decay: open ? 0.45 : 0.07,
      peak: open ? 0.5 : 0.55,
      duration: open ? 0.5 : 0.1,
      destination: out,
    });
    // light sizzle layer
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 9000;
    const gain = this._envGain(time, 0.001, open ? 0.3 : 0.05, open ? 0.15 : 0.2);
    noise.connect(filter).connect(gain).connect(out);
    noise.start(time);
    noise.stop(time + (open ? 0.5 : 0.1));
  }

  _synthRide(time) {
    const out = this._panner(0.5, this.trackVolume.ride);
    this._metallicBurst(time, {
      baseFreq: 300,
      ratios: RIDE_RATIOS,
      hpFreq: 4000,
      attack: 0.001,
      decay: 0.5,
      peak: 0.35,
      duration: 0.55,
      destination: out,
    });
    // bell ping
    const ctx = this.ctx;
    const ping = ctx.createOscillator();
    ping.type = "sine";
    ping.frequency.value = 2600;
    const pingGain = this._envGain(time, 0.001, 0.2, 0.22);
    ping.connect(pingGain).connect(out);
    ping.start(time);
    ping.stop(time + 0.22);

    // shimmer wash
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 6500;
    filter.Q.value = 0.7;
    const gain = this._envGain(time, 0.001, 0.35, 0.25);
    noise.connect(filter).connect(gain).connect(out);
    noise.start(time);
    noise.stop(time + 0.4);
  }

  _synthCrash(time) {
    const out = this._panner(-0.55, this.trackVolume.crash);
    this._metallicBurst(time, {
      baseFreq: 250,
      ratios: CRASH_RATIOS,
      hpFreq: 3500,
      attack: 0.001,
      decay: 1.6,
      peak: 0.55,
      duration: 1.8,
      destination: out,
    });
    // noise wash for the trashy body
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 5000;
    const gain = this._envGain(time, 0.001, 1.4, 0.5);
    noise.connect(filter).connect(gain).connect(out);
    noise.start(time);
    noise.stop(time + 1.7);
  }

  _synthTom(time, isFloor) {
    const ctx = this.ctx;
    const out = this._panner(isFloor ? 0.35 : -0.15, this.trackVolume[isFloor ? "floortom" : "tom"]);
    const baseFreq = this._jitter(isFloor ? 95 : 165, 0.03);

    // physically-modeled resonant membrane (replaces a plain sine sweep —
    // this is what makes it read as a drum shell instead of a synth blip)
    this._karplusHit(time, {
      freq: baseFreq,
      decay: isFloor ? 0.5 : 0.38,
      peak: 1,
      damping: isFloor ? 1600 : 2400,
      feedback: isFloor ? 0.94 : 0.9,
      destination: out,
    });

    // pitch-drop sine layer underneath for extra low-end thump
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const startFreq = this._jitter(isFloor ? 100 : 175, 0.02);
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(startFreq * 0.6, time + (isFloor ? 0.22 : 0.16));
    const gain = this._envGain(time, 0.001, isFloor ? 0.3 : 0.22, 0.55);
    osc.connect(gain).connect(out);
    osc.start(time);
    osc.stop(time + (isFloor ? 0.35 : 0.28));

    // stick attack transient
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = isFloor ? 200 : 350;
    const noiseGain = this._envGain(time, 0.0005, 0.05, 0.2);
    noise.connect(noiseFilter).connect(noiseGain).connect(out);
    noise.start(time);
    noise.stop(time + 0.06);
  }

  // Public voice triggers: play the real sampled hit if it decoded
  // successfully, otherwise fall back to the synthesized version.
  playKick(time) {
    if (!this._playSample("kick", time, { pan: 0 })) this._synthKick(time);
  }

  playSnare(time) {
    if (!this._playSample("snare", time, { pan: -0.05 })) this._synthSnare(time);
  }

  playHihat(time, open = false) {
    const key = open ? "hihatOpen" : "hihatClosed";
    const volumeKey = open ? "hihatOpen" : "hihat";
    if (!this._playSample(key, time, { pan: -0.35, volumeKey })) this._synthHihat(time, open);
  }

  playRide(time) {
    if (!this._playSample("ride", time, { pan: 0.5 })) this._synthRide(time);
  }

  playCrash(time) {
    if (!this._playSample("crash", time, { pan: -0.55 })) this._synthCrash(time);
  }

  playTom(time, isFloor) {
    const key = isFloor ? "floortom" : "tom";
    if (!this._playSample(key, time, { pan: isFloor ? 0.35 : -0.15 })) this._synthTom(time, isFloor);
  }

  // Also dry/reverb-free — sticking practice is a timing reference too.
  playStick(time, isRight) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = isRight ? 900 : 600;
    const gain = this._envGain(time, 0.001, 0.06, 0.8);
    osc.connect(gain).connect(this.outputGain);
    osc.start(time);
    osc.stop(time + 0.08);
  }
}

const audioEngine = new AudioEngine();

/* ============================================================
   Scheduler — lookahead scheduling for accurate timing
   (based on the standard Web Audio "tale of two clocks" pattern)
   ============================================================ */
class Scheduler {
  constructor({ onStep, stepsPerLoop, secondsPerStep }) {
    this.onStep = onStep;
    this.stepsPerLoop = stepsPerLoop;
    this.secondsPerStep = secondsPerStep;
    this.lookahead = 25.0; // ms
    this.scheduleAheadTime = 0.1; // s
    this.currentStep = 0;
    this.nextStepTime = 0;
    this.timerId = null;
    this.running = false;
  }

  setStepDuration(seconds) {
    this.secondsPerStep = seconds;
  }

  setStepsPerLoop(n) {
    this.stepsPerLoop = n;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.currentStep = 0;
    this.nextStepTime = audioEngine.ctx.currentTime + 0.05;
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.timerId) clearTimeout(this.timerId);
    this.timerId = null;
  }

  _tick() {
    while (this.nextStepTime < audioEngine.ctx.currentTime + this.scheduleAheadTime) {
      this.onStep(this.currentStep, this.nextStepTime);
      this.nextStepTime += this.secondsPerStep;
      this.currentStep = (this.currentStep + 1) % this.stepsPerLoop;
    }
    this.timerId = setTimeout(() => this._tick(), this.lookahead);
  }
}

/* ============================================================
   Range slider fill (visual progress track — see input[type="range"] in CSS)
   ============================================================ */
function updateRangeFill(el) {
  const min = parseFloat(el.min || "0");
  const max = parseFloat(el.max || "100");
  const val = parseFloat(el.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--fill", `${pct}%`);
}

function bindRangeFill(el) {
  updateRangeFill(el);
  el.addEventListener("input", () => updateRangeFill(el));
}

document.querySelectorAll('input[type="range"]').forEach(bindRangeFill);

/* ============================================================
   Tab switching
   ============================================================ */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    stopAllPlayers();
  });
});

function stopAllPlayers() {
  metronomeStop();
  rhythmStop();
  stickingStop();
}

// Play/stop buttons hold icon <svg> children now, so update just the label
// span instead of overwriting the whole button with textContent.
function setPlayLabel(btn, text) {
  const label = btn.querySelector(".btn-label");
  if (label) label.textContent = text;
  else btn.textContent = text;
}

/* ============================================================
   METRONOME
   ============================================================ */
const bpmSlider = document.getElementById("bpmSlider");
const bpmInput = document.getElementById("bpmInput");
const bpmValue = document.getElementById("bpmValue");
const bpmMinus = document.getElementById("bpmMinus");
const bpmPlus = document.getElementById("bpmPlus");
const tapTempoBtn = document.getElementById("tapTempo");
const timeSignatureSel = document.getElementById("timeSignature");
const subdivisionSel = document.getElementById("subdivision");
const accentToggle = document.getElementById("accentToggle");
const metronomeTimbreSel = document.getElementById("metronomeTimbre");
const metronomeSwingTypeSel = document.getElementById("metronomeSwingType");
const metronomeSwingAmountSlider = document.getElementById("metronomeSwingAmount");
const metronomeSwingAmountValue = document.getElementById("metronomeSwingAmountValue");
const volumeSlider = document.getElementById("volumeSlider");
const beatLights = document.getElementById("beatLights");
const metronomePlayBtn = document.getElementById("metronomePlay");

let metronomeBpm = 120;
let metronomeScheduler = null;
let metronomeBeatEls = [];
let metronomeTimbre = localStorage.getItem("drumapp_metronome_timbre") || "default";
metronomeTimbreSel.value = metronomeTimbre;
let metronomeSwingType = localStorage.getItem("drumapp_metronome_swing_type") || "none";
let metronomeSwingAmount = parseInt(localStorage.getItem("drumapp_metronome_swing_amount") || "62", 10);
metronomeSwingTypeSel.value = metronomeSwingType;
metronomeSwingAmountSlider.value = metronomeSwingAmount;
metronomeSwingAmountValue.textContent = `${metronomeSwingAmount}%`;

function setBpm(v, { syncSlider = true, syncInput = true } = {}) {
  v = Math.min(300, Math.max(30, Math.round(v)));
  metronomeBpm = v;
  bpmValue.textContent = v;
  if (syncSlider) {
    bpmSlider.value = v;
    updateRangeFill(bpmSlider);
  }
  if (syncInput) bpmInput.value = v;
  if (metronomeScheduler) {
    metronomeScheduler.setStepDuration(stepDurationForMetronome());
  }
}

function stepDurationForMetronome() {
  const sub = parseInt(subdivisionSel.value, 10);
  return 60 / metronomeBpm / sub;
}

function buildBeatLights() {
  const beats = parseInt(timeSignatureSel.value, 10);
  beatLights.innerHTML = "";
  metronomeBeatEls = [];
  for (let i = 0; i < beats; i++) {
    const el = document.createElement("div");
    el.className = "beat-light" + (i === 0 ? " accent" : "");
    beatLights.appendChild(el);
    metronomeBeatEls.push(el);
  }
}

function reconfigureMetronomeScheduler() {
  if (!metronomeScheduler) return;
  const beats = parseInt(timeSignatureSel.value, 10);
  const sub = parseInt(subdivisionSel.value, 10);
  metronomeScheduler.setStepsPerLoop(beats * sub);
  metronomeScheduler.setStepDuration(stepDurationForMetronome());
  metronomeScheduler.currentStep = 0;
}

bpmSlider.addEventListener("input", () => setBpm(bpmSlider.value, { syncSlider: false }));
bpmInput.addEventListener("change", () => setBpm(bpmInput.value, { syncInput: false }));
bpmMinus.addEventListener("click", () => setBpm(metronomeBpm - 1));
bpmPlus.addEventListener("click", () => setBpm(metronomeBpm + 1));
timeSignatureSel.addEventListener("change", () => {
  buildBeatLights();
  reconfigureMetronomeScheduler();
});
subdivisionSel.addEventListener("change", reconfigureMetronomeScheduler);
volumeSlider.addEventListener("input", () => audioEngine.setVolume(volumeSlider.value / 100));
metronomeTimbreSel.addEventListener("change", () => {
  metronomeTimbre = metronomeTimbreSel.value;
  localStorage.setItem("drumapp_metronome_timbre", metronomeTimbre);
});
metronomeSwingTypeSel.addEventListener("change", () => {
  metronomeSwingType = metronomeSwingTypeSel.value;
  localStorage.setItem("drumapp_metronome_swing_type", metronomeSwingType);
});
metronomeSwingAmountSlider.addEventListener("input", () => {
  metronomeSwingAmount = parseInt(metronomeSwingAmountSlider.value, 10);
  metronomeSwingAmountValue.textContent = `${metronomeSwingAmount}%`;
  localStorage.setItem("drumapp_metronome_swing_amount", metronomeSwingAmount);
});

let tapTimes = [];
tapTempoBtn.addEventListener("click", () => {
  const now = performance.now();
  tapTimes = tapTimes.filter((t) => now - t < 2000);
  tapTimes.push(now);
  if (tapTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    setBpm(60000 / avgMs);
  }
});

// Delays the "off" subdivision(s) within a beat, in step units (same
// tail-alignment math as the rhythm tab's swing) — only meaningful when the
// subdivision resolution actually has an off-8th (sub 2 or 4) or off-16th
// (sub 4) position to delay; otherwise it's a no-op.
function metronomeSwingOffset(stepInBeat, sub) {
  if (metronomeSwingType === "none") return 0;
  const r = metronomeSwingAmount / 100;
  if (metronomeSwingType === "8th") {
    if (sub === 2 && stepInBeat === 1) return 2 * r - 1;
    if (sub === 4 && stepInBeat === 2) return 2 * (2 * r - 1);
    return 0;
  }
  if (metronomeSwingType === "16th") {
    if (sub === 4 && stepInBeat % 2 === 1) return 2 * r - 1;
    return 0;
  }
  return 0;
}

function metronomeOnStep(step, time) {
  const sub = parseInt(subdivisionSel.value, 10);
  const beats = parseInt(timeSignatureSel.value, 10);
  const isBeat = step % sub === 0;
  const beatIndex = Math.floor(step / sub) % beats;
  const stepInBeat = step % sub;
  const t = time + metronomeSwingOffset(stepInBeat, sub) * stepDurationForMetronome();

  if (isBeat) {
    const accent = accentToggle.checked && beatIndex === 0;
    audioEngine.playClick(t, accent, metronomeTimbre);
    flashBeatLight(beatIndex, t);
  } else {
    audioEngine.playSubClick(t, metronomeTimbre);
  }
}

function flashBeatLight(beatIndex, time) {
  const delay = Math.max(0, (time - audioEngine.ctx.currentTime) * 1000);
  setTimeout(() => {
    metronomeBeatEls.forEach((el) => el.classList.remove("on"));
    if (metronomeBeatEls[beatIndex]) metronomeBeatEls[beatIndex].classList.add("on");
  }, delay);
}

async function metronomeStart() {
  await audioEngine.ensureContext();
  audioEngine.setVolume(volumeSlider.value / 100);
  const beats = parseInt(timeSignatureSel.value, 10);
  const sub = parseInt(subdivisionSel.value, 10);
  metronomeScheduler = new Scheduler({
    onStep: metronomeOnStep,
    stepsPerLoop: beats * sub,
    secondsPerStep: stepDurationForMetronome(),
  });
  metronomeScheduler.start();
  setPlayLabel(metronomePlayBtn, "ストップ");
  metronomePlayBtn.classList.add("playing");
}

function metronomeStop() {
  if (metronomeScheduler) {
    metronomeScheduler.stop();
    metronomeScheduler = null;
  }
  metronomeBeatEls.forEach((el) => el.classList.remove("on"));
  setPlayLabel(metronomePlayBtn, "スタート");
  metronomePlayBtn.classList.remove("playing");
}

let metronomeStarting = false;
metronomePlayBtn.addEventListener("click", async () => {
  if (metronomeScheduler) {
    metronomeStop();
    return;
  }
  if (metronomeStarting) return;
  metronomeStarting = true;
  try {
    await metronomeStart();
  } finally {
    metronomeStarting = false;
  }
});

buildBeatLights();
setBpm(120);

/* ============================================================
   RHYTHM PATTERN GRID
   ============================================================ */
const TRACKS = ["crash", "ride", "hihatOpen", "hihat", "tom", "snare", "floortom", "kick"];
const TRACK_LABELS = {
  crash: "クラッシュ",
  ride: "ライド",
  hihatOpen: "ハイハットO",
  hihat: "ハイハット",
  tom: "タム",
  snare: "スネア",
  floortom: "フロアタム",
  kick: "キック",
};
const TRACK_SOUND = {
  crash: (t) => audioEngine.playCrash(t),
  ride: (t) => audioEngine.playRide(t),
  hihatOpen: (t) => audioEngine.playHihat(t, true),
  hihat: (t) => audioEngine.playHihat(t, false),
  tom: (t) => audioEngine.playTom(t, false),
  snare: (t) => audioEngine.playSnare(t),
  floortom: (t) => audioEngine.playTom(t, true),
  kick: (t) => audioEngine.playKick(t),
};

// One-off sound check for a single instrument — used so clicking a cell/note
// on while editing gives immediate audible feedback, independent of playback.
async function auditionTrack(track) {
  await audioEngine.ensureContext();
  audioEngine.setVolume(volumeSlider.value / 100);
  TRACK_SOUND[track](audioEngine.ctx.currentTime + 0.02);
}

const PRESETS = {
  "8ビート (基本)": {
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  "8ビート (裏打ちキック)": {
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
  },
  "16ビート (基本)": {
    hihat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
  },
  "4つ打ち (ダンスビート)": {
    hihat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  },
  "シャッフル風": {
    hihat: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    kick: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
  },
  "フィル (タム回し)": {
    crash: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0],
    floortom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  "空のパターン": {
    hihat: Array(16).fill(0),
    snare: Array(16).fill(0),
    kick: Array(16).fill(0),
  },
};

// "有名ドラマー風" fills are not transcriptions of any specific recording —
// they're generic patterns built from technique/vocabulary commonly associated
// with each drummer (triplet phrasing, linear funk, hi-hat-heavy syncopation, etc.).
const FILLS = {
  classic_16th_descend: {
    label: "定番16分フィル (テリトリー移動)",
    group: "style",
    description: "スネア→ハイタム→フロアタムと4つずつ移動する、教則本で必ず出てくる基本中の基本形。",
    pattern: {
      snare: [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      tom: [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      kick: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1],
    },
  },
  single_stroke_move: {
    label: "シングルストローク移動 (S→T→F→S)",
    group: "style",
    description: "スネア→タム→フロアタム→スネアと一往復するシングルストロークの基礎フィル。",
    pattern: {
      snare: [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      tom: [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],
    },
  },
  double_stroke_move: {
    label: "ダブルストローク移動 (RRLL)",
    group: "style",
    description: "スネアとタム/フロアタムを2打ずつ行き来する、ダブルストロークの定番運指。",
    pattern: {
      snare: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
      tom: [0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1],
    },
  },
  paradiddle_fill: {
    label: "パラディドルフィル (RLRR LRLL)",
    group: "style",
    description: "シングルパラディドル(RLRR LRLL)をスネア/タムに振り分けた、スティッキング練習にもなる実用フィル。",
    pattern: {
      snare: [1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0],
      tom: [0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1],
    },
  },
  simple_tom: {
    label: "シンプル (タムのみ)",
    group: "style",
    description: "ハイタムとフロアタムを交互に。フィル入門の基本形。",
    pattern: {
      tom: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  snare_roll_8th: {
    label: "8分スネアロール",
    group: "style",
    description: "スネアの8分音符連打。シンプルで実用的な定番フィル。",
    pattern: {
      snare: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  fill_16th: {
    label: "16分埋め (カスケード)",
    group: "style",
    description: "タム→スネア→フロアタムと16分音符で駆け下りる定番フレーズ。",
    pattern: {
      tom: [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      snare: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
      floortom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  triplet_rock: {
    label: "3連風ロックフィル (近似)",
    group: "style",
    description: "16分グリッド上で3連符に近い間隔を再現した力強いロックフィル。",
    pattern: {
      tom: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  funk_linear: {
    label: "ファンク (リニア)",
    group: "style",
    description: "ハイハットを止め、キック/スネア/タムが1つずつ交代するリニアなブレイク。",
    pattern: {
      kick: [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
      tom: [0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0],
      snare: [0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1],
    },
  },
  latin_tom: {
    label: "ラテン風 (タム主体)",
    group: "style",
    description: "タムのシンコペーションとスネアのリムショット風アクセント。",
    pattern: {
      tom: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
      snare: [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
      kick: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  bonham: {
    label: "ボーナム風 (パワートリプレット)",
    group: "drummer",
    description: "キックとタムを連動させた重厚なトリプレット系フィル。パワフルな足さばきが特徴。",
    pattern: {
      kick: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      tom: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
    },
  },
  peart: {
    label: "パート風 (変則グルーピング)",
    group: "drummer",
    description: "均等でないグルーピングと正確なタム移動が特徴の、テクニカルなフィル。",
    pattern: {
      tom: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  copeland: {
    label: "コープランド風 (スネア/タムの変則シンコペーション)",
    group: "drummer",
    description: "ハイハットを止め、細かく跳ねるスネアとタムのアクセントで変則的な動きを出すブレイク。",
    pattern: {
      snare: [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0],
      tom: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
      kick: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    },
  },
  gadd: {
    label: "ギャッド風 (リニアフィル)",
    group: "drummer",
    description: "同時打点なしのリニアフレーズ。キックの細かいシンコペーションが特徴。",
    pattern: {
      kick: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
      snare: [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
      tom: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1],
    },
  },
  buddy_rich: {
    label: "リッチ風 (高速シングルストローク)",
    group: "drummer",
    description: "全16分をタム/スネア/フロアタムで駆け抜ける、速く滑らかなシングルストロークロール。",
    pattern: {
      tom: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      snare: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
      floortom: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  travis_barker: {
    label: "バーカー風 (パンク/ヒップホップ)",
    group: "drummer",
    description: "小刻みなスネアと後半のタムが特徴の、パワフルでキレのあるクロスオーバー系フィル。",
    pattern: {
      snare: [1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1],
      tom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      kick: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  funk_syncopation: {
    label: "ファンク (シンコペーション強め)",
    group: "style",
    description: "ハイハットを止め、キックとスネアの細かいシンコペーションだけで見せるブレイク。",
    pattern: {
      kick: [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
      snare: [0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0],
      tom: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    },
  },
  double_kick_metal: {
    label: "ダブルキック風 (メタル)",
    group: "style",
    description: "キックの16分連打とクラッシュを組み合わせた攻撃的なフィル。",
    pattern: {
      crash: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      kick: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      snare: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  jazz_brush: {
    label: "ジャズ風 (スネアロール→ライド1発)",
    group: "style",
    description: "ライドの刻みを止め、後半にスネアロールを溜めてライドを1発だけ添えるジャズ的なブレイク。",
    pattern: {
      snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ride: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    },
  },
  hiphop_break: {
    label: "ヒップホップ風 (ストップタイム・ブレイク)",
    group: "style",
    description: "ハイハットを止め、間を活かした少ない音数でキメる「ストップタイム」的なブレイク。",
    pattern: {
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      tom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    },
  },
  prog_odd: {
    label: "プログレ風 (変則グルーピング)",
    group: "style",
    description: "5ステップ間隔の移動でポリメトリックな浮遊感を出す、技巧的なフィル。",
    pattern: {
      tom: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    },
  },
  reggae_tom_roll: {
    label: "レゲエ風 (タム回し→ワンドロップ着地)",
    group: "style",
    description: "ハイハットを止め、タムのロールで溜めてから、キック+スネアを揃える「ワンドロップ」で着地するブレイク。",
    pattern: {
      tom: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      kick: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
      snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
    },
  },
  chad_smith: {
    label: "スミス風 (ファンクロック・キックシンコペーション)",
    group: "drummer",
    description: "ハイハットを止め、跳ねるようなキックのシンコペーションとタムのアクセントで見せるファンクロック的ブレイク。",
    pattern: {
      kick: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      tom: [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    },
  },
  mike_portnoy: {
    label: "ポートノイ風 (変拍子テクニカル)",
    group: "drummer",
    description: "不均等なグルーピングでキット全体を移動する、正確さを重視したテクニカルなフィル。",
    pattern: {
      kick: [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
      snare: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],
      tom: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    },
  },
  questlove: {
    label: "クエストラブ風 (ミニマルブレイク)",
    group: "drummer",
    description: "ハイハットを止め、極端に音数を絞ったキック/スネア/タムだけで「間」を聴かせる控えめなブレイク。",
    pattern: {
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      tom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
      snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
    },
  },
  keith_moon: {
    label: "ムーン風 (カオティック)",
    group: "drummer",
    description: "クラッシュ2発とタム/スネア/キックが同時多発的に暴れる、あふれ出すような破天荒フィル。",
    pattern: {
      crash: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      tom: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
      floortom: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      snare: [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
      kick: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    },
  },
  phil_collins: {
    label: "コリンズ風 (ビッグタム)",
    group: "drummer",
    description: "ハイタムとフロアタムの8分音符を交互に鳴らす、ゲートリバーブ的な太いタムサウンドが映る定番フレーズ。",
    pattern: {
      tom: [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  ginger_baker: {
    label: "ベイカー風 (ポリリズム)",
    group: "drummer",
    description: "3ステップごとにハイタムとフロアタムを行き来する、アフロビート由来のポリリズミックなフレーズ。",
    pattern: {
      tom: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      floortom: [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  ringo_starr: {
    label: "リンゴ・スター風 (シンプル)",
    group: "drummer",
    description: "音数を極限まで削った、必要最小限だけのタスティな一打。「引き算のフィル」の好例。",
    pattern: {
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      tom: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  carter_beauford: {
    label: "ボーフォード風 (シンコペーション)",
    group: "drummer",
    description: "キック/スネア/タムが複雑に絡み合う、テクニカルで密度の高いシンコペーションフィル。",
    pattern: {
      kick: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0],
      snare: [0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0],
      tom: [0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1],
    },
  },
  danny_carey: {
    label: "キャリー風 (変拍子ポリリズム)",
    group: "drummer",
    description: "5ステップ間隔のキックを軸に、タムをずらして重ねるプログレメタル的なポリリズムフィル。",
    pattern: {
      kick: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      tom: [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
      floortom: [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    },
  },
  zigaboo_modeliste: {
    label: "モデリステ風 (ニューオーリンズファンク)",
    group: "drummer",
    description: "キックとスネアが裏拍で絡み合う、セカンドライン由来の粘っこいシンコペーション。",
    pattern: {
      kick: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
      snare: [0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],
    },
  },
  clyde_stubblefield: {
    label: "スタブルフィールド風 (ファンクシンコペーション)",
    group: "drummer",
    description: "スネアを密に敷き詰める、ファンクドラミングの手数の多さを感じさせるグルーヴィーなフィル。",
    pattern: {
      kick: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      snare: [0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1],
    },
  },
  akira_jimbo: {
    label: "神保彰風 (テクニカルフュージョン)",
    group: "drummer",
    description: "キット全体を高速で駆け巡る、手数の多い正確無比なフュージョン系テクニカルフィル。",
    pattern: {
      kick: [1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
      snare: [0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1],
      tom: [1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0],
      floortom: [0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0],
    },
  },
  tony_williams: {
    label: "トニー・ウィリアムス風 (ジャズフュージョン)",
    group: "drummer",
    description: "タムの連打から始まり、スネア/フロアタムで畳みかけてクラッシュで着地する、流麗で技巧的なフィル。",
    pattern: {
      tom: [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      floortom: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      crash: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
};

// Normalize every fill so all 8 track keys exist (missing ones default to silence).
Object.keys(FILLS).forEach((key) => {
  FILLS[key].pattern = clonePattern(FILLS[key].pattern);
});

const presetSelect = document.getElementById("presetSelect");
const rhythmGridEl = document.getElementById("rhythmGrid");
const fillGridEl = document.getElementById("fillGrid");
const rhythmBpmSlider = document.getElementById("rhythmBpm");
const rhythmBpmValue = document.getElementById("rhythmBpmValue");
const rhythmPlayBtn = document.getElementById("rhythmPlay");
const rhythmClearBtn = document.getElementById("rhythmClear");
const fillClearBtn = document.getElementById("fillClearBtn");
const groovePreviewPlayBtn = document.getElementById("groovePreviewPlay");
const fillPreviewPlayBtn = document.getElementById("fillPreviewPlay");
const swingTypeSel = document.getElementById("swingType");
const swingAmountSlider = document.getElementById("swingAmount");
const swingAmountValue = document.getElementById("swingAmountValue");
const notationSvg = document.getElementById("notationSvg");
const fillNotationSvg = document.getElementById("fillNotationSvg");
const grooveGridWrapEl = document.getElementById("grooveGridWrap");
const grooveNotationCardEl = document.getElementById("grooveNotationCard");
const fillGridWrapEl = document.getElementById("fillGridWrap");
const fillNotationCardEl = document.getElementById("fillNotationCard");
const fillEnabledCb = document.getElementById("fillEnabled");
const fillBarsSel = document.getElementById("fillBars");
const fillBarIndexSel = document.getElementById("fillBarIndex");
const fillLengthSel = document.getElementById("fillLength");
const fillStyleSel = document.getElementById("fillStyle");
const fillStyleGroupStyle = document.getElementById("fillStyleGroupStyle");
const fillStyleGroupDrummer = document.getElementById("fillStyleGroupDrummer");
const fillDescriptionEl = document.getElementById("fillDescription");
const barProgressEl = document.getElementById("barProgress");
const mixerPanelEl = document.getElementById("mixerPanel");

let rhythmPattern = null;
let fillPattern = null;
let rhythmScheduler = null;
let rhythmBpm = 100;
let swingType = "none";
let swingAmount = 62;
let notationPlayheadTimer = null;
let fillNotationPlayheadTimer = null;
let fillEnabled = false;
let fillBars = 4;
let fillBarIndex = 4;
let fillLengthSteps = 16;
let fillStyleKey = "none";
let prevBarEndedInFill = false;
let trackMixer = {};
TRACKS.forEach((t) => { trackMixer[t] = 100; });

Object.keys(PRESETS).forEach((name) => {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name;
  presetSelect.appendChild(opt);
});

Object.entries(FILLS).forEach(([key, def]) => {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = def.label;
  (def.group === "drummer" ? fillStyleGroupDrummer : fillStyleGroupStyle).appendChild(opt);
});

function buildMixer() {
  if (!mixerPanelEl) return;
  mixerPanelEl.innerHTML = "";
  TRACKS.forEach((track) => {
    const row = document.createElement("div");
    row.className = "mixer-row";

    const dot = document.createElement("span");
    dot.className = "mixer-dot";
    dot.style.background = `var(--${track})`;
    dot.style.color = `var(--${track})`;

    const label = document.createElement("span");
    label.className = "mixer-label";
    label.textContent = TRACK_LABELS[track];

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "150";
    slider.value = trackMixer[track];
    slider.style.setProperty("--slider-color", `var(--${track})`);

    const valueEl = document.createElement("span");
    valueEl.className = "mixer-value";
    valueEl.textContent = `${trackMixer[track]}%`;

    slider.addEventListener("input", () => {
      const v = parseInt(slider.value, 10);
      trackMixer[track] = v;
      valueEl.textContent = `${v}%`;
      audioEngine.setTrackVolume(track, v / 100);
      saveRhythmState();
    });
    bindRangeFill(slider);

    row.append(dot, label, slider, valueEl);
    mixerPanelEl.appendChild(row);
    audioEngine.setTrackVolume(track, trackMixer[track] / 100);
  });
}

function clonePattern(p) {
  const out = {};
  TRACKS.forEach((track) => {
    out[track] = Array.isArray(p && p[track]) ? [...p[track]] : Array(16).fill(0);
  });
  return out;
}

function saveRhythmState() {
  localStorage.setItem(
    "drumapp_rhythm",
    JSON.stringify({
      pattern: rhythmPattern,
      fillPattern,
      preset: presetSelect.value,
      bpm: rhythmBpm,
      swingType,
      swingAmount,
      fillEnabled,
      fillBars,
      fillBarIndex,
      fillLengthSteps,
      fillStyleKey,
      trackMixer,
    })
  );
}

function loadRhythmState() {
  try {
    const raw = localStorage.getItem("drumapp_rhythm");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function renderGridInto(containerEl, pattern, activeFromStep, onCellToggled) {
  containerEl.innerHTML = "";
  TRACKS.forEach((track) => {
    const label = document.createElement("div");
    label.className = "grid-label";
    label.textContent = TRACK_LABELS[track];
    containerEl.appendChild(label);

    for (let step = 0; step < 16; step++) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      if (step % 4 === 0) cell.classList.add("beat-start");
      if (step < activeFromStep) cell.classList.add("grid-cell-inactive");
      cell.dataset.track = track;
      cell.dataset.step = step;
      if (pattern[track][step]) cell.classList.add("active");
      cell.addEventListener("click", () => {
        pattern[track][step] = pattern[track][step] ? 0 : 1;
        cell.classList.toggle("active");
        onCellToggled();
        if (pattern[track][step]) auditionTrack(track);
      });
      containerEl.appendChild(cell);
    }
  });
}

function renderGrooveGrid() {
  renderGridInto(rhythmGridEl, rhythmPattern, 0, () => {
    saveRhythmState();
    renderGrooveNotation();
  });
}

function renderFillGrid() {
  const activeFromStep = fillLengthSteps < 16 ? 16 - fillLengthSteps : 0;
  renderGridInto(fillGridEl, fillPattern, activeFromStep, () => {
    saveRhythmState();
    renderFillNotation();
  });
}

/* ---- Drum notation preview: beams/flags show note value (8th vs 16th etc.),
   not just a plain stem, so busy patterns actually read as rhythm. ---- */
const STAFF_LEFT = 34;
const STAFF_STEP_W = 30;
const STAFF_LINES_Y = [60, 70, 80, 90, 100];
const STAFF_TOP = 2;
const STAFF_BOTTOM = 126;

// Vertical position (and notehead style) for each track on the staff.
// Cymbal voices (x-notehead) share the "above staff" region; pitched voices
// (filled notehead) are placed on/around the 5-line staff.
const TRACK_STAFF = {
  crash: { y: 10, shape: "x" },
  ride: { y: 24, shape: "x" },
  hihatOpen: { y: 38, shape: "x", open: true },
  hihat: { y: 52, shape: "x" },
  tom: { y: 65, shape: "head" },
  snare: { y: 80, shape: "head" },
  floortom: { y: 95, shape: "head" },
  kick: { y: 110, shape: "head" },
};

function noteX(step) {
  return STAFF_LEFT + step * STAFF_STEP_W + STAFF_STEP_W / 2 + swingOffsetSteps(step) * STAFF_STEP_W;
}

// Fraction of a step that a swung "off" note shifts right, in step units (bpm-independent).
function swingOffsetSteps(step) {
  if (swingType === "none") return 0;
  const r = swingAmount / 100;
  if (swingType === "8th" && step % 4 === 2) return 2 * (2 * r - 1);
  if (swingType === "16th" && step % 2 === 1) return 1 * (2 * r - 1);
  return 0;
}

// Number of beams/flags a note gets based on the gap (in steps) to the next
// hit in the same voice: 1 step apart = 16th (2 flags), 2 apart = 8th (1
// flag), 4+ apart = quarter or longer (plain stem, 0 flags).
function flagCountForGap(gap) {
  if (gap <= 1) return 2;
  if (gap === 2) return 1;
  return 0;
}

// Splits one track's active steps into beamed runs (2+ evenly-spaced hits
// within the same beat, drawn with a shared beam bar) and leftover singles
// (drawn with individual flags). Real engraving software infers this from
// context; this is a practical approximation good enough for straight/simple
// syncopated patterns, which covers the vast majority of what a practice
// grid produces.
function computeNoteGroups(activeSteps) {
  const beamed = [];
  const flaggedSet = new Set(activeSteps);
  let i = 0;
  while (i < activeSteps.length) {
    const beat = Math.floor(activeSteps[i] / 4);
    let j = i;
    let gap = null;
    while (j + 1 < activeSteps.length) {
      const next = activeSteps[j + 1];
      if (Math.floor(next / 4) !== beat) break;
      const g = next - activeSteps[j];
      if (g > 2) break;
      if (gap === null) gap = g;
      else if (g !== gap) break;
      j++;
    }
    if (j > i) {
      const steps = activeSteps.slice(i, j + 1);
      beamed.push({ steps, flagCount: gap === 1 ? 2 : 1 });
      steps.forEach((s) => flaggedSet.delete(s));
      i = j + 1;
    } else {
      i++;
    }
  }
  const flagged = [...flaggedSet].map((step) => {
    const idx = activeSteps.indexOf(step);
    const next = activeSteps[idx + 1];
    const gap = next !== undefined ? next - step : 4;
    return { step, flagCount: flagCountForGap(gap) };
  });
  return { beamed, flagged };
}

function noteHeadGlyph(x, y, track, dim) {
  const cls = dim ? "staff-note-head staff-note-dim" : "staff-note-head";
  return `<ellipse class="${cls}" cx="${x}" cy="${y}" rx="5" ry="4" style="fill:var(--${track});stroke:var(--${track})"></ellipse>`;
}

function xMarkGlyph(x, y, track, open, dim) {
  const s = 4.5;
  const dimCls = dim ? " staff-note-dim" : "";
  let html =
    `<line class="staff-note-x${dimCls}" x1="${x - s}" y1="${y - s}" x2="${x + s}" y2="${y + s}" style="stroke:var(--${track})"></line>` +
    `<line class="staff-note-x${dimCls}" x1="${x - s}" y1="${y + s}" x2="${x + s}" y2="${y - s}" style="stroke:var(--${track})"></line>`;
  if (open) {
    html += `<circle class="staff-note-o${dimCls}" cx="${x}" cy="${y - 9}" r="3" style="stroke:var(--${track})"></circle>`;
  }
  return html;
}

function stemGlyph(stemX, y, tipY, track, dim) {
  const cls = dim ? "staff-stem staff-note-dim" : "staff-stem";
  return `<line class="${cls}" x1="${stemX}" y1="${y}" x2="${stemX}" y2="${tipY}" style="stroke:var(--${track})"></line>`;
}

// stemDir: -1 = stem tip above the notehead (flags/beams hook down toward
// it), 1 = stem tip below the notehead (flags/beams hook up toward it).
function flagGlyphs(stemX, tipY, stemDir, flagCount, track, dim) {
  const cls = dim ? "staff-flag staff-note-dim" : "staff-flag";
  let html = "";
  for (let f = 0; f < flagCount; f++) {
    const baseY = tipY - stemDir * f * 6;
    const hookY = baseY - stemDir * 8;
    const midX = stemX + 7;
    const midY = baseY - stemDir * 3;
    html += `<path class="${cls}" d="M${stemX} ${baseY} Q${midX} ${midY} ${stemX + 6} ${hookY}" style="stroke:var(--${track})"></path>`;
  }
  return html;
}

function beamGlyphs(x1, x2, tipY, stemDir, flagCount, track, dim) {
  const cls = dim ? "staff-beam staff-note-dim" : "staff-beam";
  let html = "";
  for (let b = 0; b < flagCount; b++) {
    const beamY = tipY - stemDir * b * 5;
    html += `<line class="${cls}" x1="${x1}" y1="${beamY}" x2="${x2}" y2="${beamY}" style="stroke:var(--${track})"></line>`;
  }
  return html;
}

function renderTrackNotes(pattern, track, cutoff) {
  const spec = TRACK_STAFF[track];
  const stemDir = spec.shape === "x" ? 1 : -1;
  const stemLen = spec.shape === "x" ? 20 : 24;
  const noteOffset = spec.shape === "x" ? 4.5 : 5;
  const tipY = spec.y + stemDir * stemLen;

  const activeSteps = [];
  for (let step = 0; step < 16; step++) {
    if (pattern[track][step]) activeSteps.push(step);
  }
  if (activeSteps.length === 0) return "";

  let html = "";

  activeSteps.forEach((step) => {
    const x = noteX(step);
    const dim = step < cutoff;
    html += spec.shape === "x" ? xMarkGlyph(x, spec.y, track, !!spec.open, dim) : noteHeadGlyph(x, spec.y, track, dim);
  });

  activeSteps.forEach((step) => {
    const stemX = noteX(step) + noteOffset;
    html += stemGlyph(stemX, spec.y, tipY, track, step < cutoff);
  });

  const { beamed, flagged } = computeNoteGroups(activeSteps);

  beamed.forEach((group) => {
    const dim = group.steps.every((s) => s < cutoff);
    const x1 = noteX(group.steps[0]) + noteOffset;
    const x2 = noteX(group.steps[group.steps.length - 1]) + noteOffset;
    html += beamGlyphs(x1, x2, tipY, stemDir, group.flagCount, track, dim);
  });

  flagged.forEach(({ step, flagCount }) => {
    if (flagCount === 0) return;
    const stemX = noteX(step) + noteOffset;
    html += flagGlyphs(stemX, tipY, stemDir, flagCount, track, step < cutoff);
  });

  return html;
}

function buildStaffMarkup(pattern, playheadId, showSwingLabel, activeFromStep) {
  const cutoff = activeFromStep || 0;
  let html = "";
  html += `<rect class="staff-barline" x="${STAFF_LEFT - 18}" y="70" width="5" height="9" rx="1"></rect>`;
  html += `<rect class="staff-barline" x="${STAFF_LEFT - 18}" y="82" width="5" height="9" rx="1"></rect>`;
  STAFF_LINES_Y.forEach((y) => {
    html += `<line class="staff-line" x1="${STAFF_LEFT - 8}" y1="${y}" x2="${STAFF_LEFT + 16 * STAFF_STEP_W}" y2="${y}"></line>`;
  });
  html += `<line class="staff-barline" x1="${STAFF_LEFT - 8}" y1="${STAFF_LINES_Y[0]}" x2="${STAFF_LEFT - 8}" y2="${STAFF_LINES_Y[4]}"></line>`;
  html += `<line class="staff-barline" x1="${STAFF_LEFT + 16 * STAFF_STEP_W}" y1="${STAFF_LINES_Y[0]}" x2="${STAFF_LEFT + 16 * STAFF_STEP_W}" y2="${STAFF_LINES_Y[4]}"></line>`;
  [4, 8, 12].forEach((step) => {
    const x = STAFF_LEFT + step * STAFF_STEP_W;
    html += `<line class="staff-beat-guide" x1="${x}" y1="${STAFF_TOP}" x2="${x}" y2="${STAFF_BOTTOM}"></line>`;
  });
  if (cutoff > 0) {
    const cx = STAFF_LEFT + cutoff * STAFF_STEP_W;
    html += `<line class="staff-fill-cutoff" x1="${cx}" y1="${STAFF_TOP}" x2="${cx}" y2="${STAFF_BOTTOM}"></line>`;
  }

  TRACKS.forEach((track) => {
    html += renderTrackNotes(pattern, track, cutoff);
  });

  if (showSwingLabel && swingType !== "none") {
    html += `<text class="staff-swing-label" x="${STAFF_LEFT}" y="128">ハネ: ${swingType === "8th" ? "8分" : "16分"} (${swingAmount}%)</text>`;
  }

  html += `<line id="${playheadId}" class="staff-playhead" x1="${STAFF_LEFT}" y1="${STAFF_TOP}" x2="${STAFF_LEFT}" y2="${STAFF_BOTTOM}"></line>`;
  return html;
}

function renderGrooveNotation() {
  if (!notationSvg || !rhythmPattern) return;
  const width = STAFF_LEFT + 16 * STAFF_STEP_W + 16;
  notationSvg.setAttribute("viewBox", `0 0 ${width} 132`);
  notationSvg.innerHTML = buildStaffMarkup(rhythmPattern, "notationPlayhead", true, 0);
}

function renderFillNotation() {
  if (!fillNotationSvg || !fillPattern) return;
  const width = STAFF_LEFT + 16 * STAFF_STEP_W + 16;
  fillNotationSvg.setAttribute("viewBox", `0 0 ${width} 132`);
  const activeFromStep = fillLengthSteps < 16 ? 16 - fillLengthSteps : 0;
  let html = buildStaffMarkup(fillPattern, "fillNotationPlayhead", true, activeFromStep);
  if (fillLengthSteps > 16) {
    html += `<text class="staff-swing-label" x="${STAFF_LEFT}" y="118">🔁 ${fillLengthSteps / 16}小節ぶん (このパターンを繰り返します)</text>`;
  }
  fillNotationSvg.innerHTML = html;
}

function svgPointFromEvent(evt, svgEl) {
  const rect = svgEl.getBoundingClientRect();
  const vb = svgEl.viewBox.baseVal;
  return {
    x: ((evt.clientX - rect.left) / rect.width) * vb.width + vb.x,
    y: ((evt.clientY - rect.top) / rect.height) * vb.height + vb.y,
  };
}

function nearestStep(x) {
  let best = 0;
  let bestDist = Infinity;
  for (let step = 0; step < 16; step++) {
    const d = Math.abs(noteX(step) - x);
    if (d < bestDist) {
      bestDist = d;
      best = step;
    }
  }
  return best;
}

function nearestTrack(y) {
  let best = TRACKS[0];
  let bestDist = Infinity;
  TRACKS.forEach((track) => {
    const d = Math.abs(TRACK_STAFF[track].y - y);
    if (d < bestDist) {
      bestDist = d;
      best = track;
    }
  });
  return best;
}

notationSvg.addEventListener("click", (evt) => {
  if (!rhythmPattern) return;
  const pt = svgPointFromEvent(evt, notationSvg);
  const step = nearestStep(pt.x);
  const track = nearestTrack(pt.y);
  rhythmPattern[track][step] = rhythmPattern[track][step] ? 0 : 1;
  renderGrooveGrid();
  renderGrooveNotation();
  saveRhythmState();
  if (rhythmPattern[track][step]) auditionTrack(track);
});

fillNotationSvg.addEventListener("click", (evt) => {
  if (!fillPattern) return;
  const pt = svgPointFromEvent(evt, fillNotationSvg);
  const step = nearestStep(pt.x);
  const track = nearestTrack(pt.y);
  fillPattern[track][step] = fillPattern[track][step] ? 0 : 1;
  renderFillGrid();
  renderFillNotation();
  saveRhythmState();
  if (fillPattern[track][step]) auditionTrack(track);
});

function highlightNotationPlayhead(step) {
  const line = document.getElementById("notationPlayhead");
  if (!line) return;
  const x = noteX(step);
  line.setAttribute("x1", x);
  line.setAttribute("x2", x);
  line.classList.add("on");
  clearTimeout(notationPlayheadTimer);
  const holdMs = Math.max(40, (60 / rhythmBpm / 4) * 1000 * 0.9);
  notationPlayheadTimer = setTimeout(() => line.classList.remove("on"), holdMs);
}

function highlightFillNotationPlayhead(step) {
  const line = document.getElementById("fillNotationPlayhead");
  if (!line) return;
  const x = noteX(step);
  line.setAttribute("x1", x);
  line.setAttribute("x2", x);
  line.classList.add("on");
  clearTimeout(fillNotationPlayheadTimer);
  const holdMs = Math.max(40, (60 / rhythmBpm / 4) * 1000 * 0.9);
  fillNotationPlayheadTimer = setTimeout(() => line.classList.remove("on"), holdMs);
}

function swingDelayForStep(step, stepDur) {
  return swingOffsetSteps(step) * stepDur;
}

function highlightPlayhead(step) {
  rhythmGridEl.querySelectorAll(".grid-cell.playhead").forEach((c) => c.classList.remove("playhead"));
  rhythmGridEl.querySelectorAll(`.grid-cell[data-step="${step}"]`).forEach((c) => c.classList.add("playhead"));
}

function highlightFillGridPlayhead(step) {
  fillGridEl.querySelectorAll(".grid-cell.playhead").forEach((c) => c.classList.remove("playhead"));
  fillGridEl.querySelectorAll(`.grid-cell[data-step="${step}"]`).forEach((c) => c.classList.add("playhead"));
}

function highlightGroovePlayhead(step) {
  highlightPlayhead(step);
  highlightNotationPlayhead(step);
}

function highlightFillPlayhead(step) {
  highlightFillGridPlayhead(step);
  highlightFillNotationPlayhead(step);
}

function clearGroovePlayhead() {
  rhythmGridEl.querySelectorAll(".grid-cell.playhead").forEach((c) => c.classList.remove("playhead"));
  const line = document.getElementById("notationPlayhead");
  if (line) line.classList.remove("on");
}

function clearFillPlayhead() {
  fillGridEl.querySelectorAll(".grid-cell.playhead").forEach((c) => c.classList.remove("playhead"));
  const line = document.getElementById("fillNotationPlayhead");
  if (line) line.classList.remove("on");
}

function populateFillBarIndexOptions() {
  const prev = fillBarIndex;
  fillBarIndexSel.innerHTML = "";
  for (let i = 1; i <= fillBars; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `${i}小節目`;
    fillBarIndexSel.appendChild(opt);
  }
  fillBarIndex = Math.min(prev || fillBars, fillBars);
  fillBarIndexSel.value = fillBarIndex;
}

function updateFillDescription() {
  const def = FILLS[fillStyleKey];
  fillDescriptionEl.textContent = def ? def.description : "スタイルを選択するとフィルの内容がプレビューされます。";
}

function renderBarProgress(currentBar) {
  if (!barProgressEl) return;
  barProgressEl.innerHTML = "";
  const n = fillEnabled ? fillBars : 1;
  for (let i = 1; i <= n; i++) {
    const dot = document.createElement("div");
    dot.className = "bar-dot";
    if (fillEnabled && i === fillBarIndex) dot.classList.add("fill-bar");
    if (i === currentBar) dot.classList.add("current");
    dot.textContent = i;
    barProgressEl.appendChild(dot);
  }
}

function currentStepsPerLoop() {
  return fillEnabled ? fillBars * 16 : 16;
}

function reconfigureRhythmScheduler() {
  if (!rhythmScheduler) return;
  rhythmScheduler.setStepsPerLoop(currentStepsPerLoop());
  rhythmScheduler.currentStep = 0;
  prevBarEndedInFill = false;
}

fillEnabledCb.addEventListener("change", () => {
  fillEnabled = fillEnabledCb.checked;
  renderBarProgress(0);
  reconfigureRhythmScheduler();
  saveRhythmState();
});

fillBarsSel.addEventListener("change", () => {
  fillBars = parseInt(fillBarsSel.value, 10);
  populateFillBarIndexOptions();
  renderBarProgress(0);
  reconfigureRhythmScheduler();
  saveRhythmState();
});

fillBarIndexSel.addEventListener("change", () => {
  fillBarIndex = parseInt(fillBarIndexSel.value, 10);
  renderBarProgress(0);
  reconfigureRhythmScheduler();
  saveRhythmState();
});

fillLengthSel.addEventListener("change", () => {
  fillLengthSteps = parseInt(fillLengthSel.value, 10);
  renderBarProgress(0);
  reconfigureRhythmScheduler();
  saveRhythmState();
  renderFillGrid();
  renderFillNotation();
});

// Selecting a fill style loads it straight into the editable fill pattern —
// the same way choosing a groove preset loads it into rhythmPattern. It's
// always visible below, so this doubles as an instant visual preview.
fillStyleSel.addEventListener("change", () => {
  fillStyleKey = fillStyleSel.value;
  const preset = FILLS[fillStyleKey];
  fillPattern = clonePattern(preset ? preset.pattern : null);
  updateFillDescription();
  renderBarProgress(0);
  reconfigureRhythmScheduler();
  saveRhythmState();
  renderFillGrid();
  renderFillNotation();
});

// Plays a pattern's 16 steps once, on its own — independent of the main
// scheduler/loop — highlighting the given section as it goes.
async function previewPattern(pattern, highlightFn) {
  if (!pattern) return 0;
  await audioEngine.ensureContext();
  audioEngine.setVolume(volumeSlider.value / 100);
  const stepDur = 60 / rhythmBpm / 4;
  const leadIn = 0.05;
  const startTime = audioEngine.ctx.currentTime + leadIn;
  for (let step = 0; step < 16; step++) {
    const t = startTime + step * stepDur + swingDelayForStep(step, stepDur);
    TRACKS.forEach((track) => {
      if (pattern[track][step]) TRACK_SOUND[track](t);
    });
    const delay = Math.max(0, (t - audioEngine.ctx.currentTime) * 1000);
    setTimeout(() => highlightFn(step), delay);
  }
  return (leadIn + 16 * stepDur + 0.15) * 1000;
}

let groovePreviewCleanupTimer = null;
groovePreviewPlayBtn.addEventListener("click", async () => {
  setSectionActive("groove");
  const ms = await previewPattern(rhythmPattern, highlightGroovePlayhead);
  clearTimeout(groovePreviewCleanupTimer);
  groovePreviewCleanupTimer = setTimeout(() => {
    clearGroovePlayhead();
    setSectionActive(null);
  }, ms);
});

let fillPreviewCleanupTimer = null;
fillPreviewPlayBtn.addEventListener("click", async () => {
  setSectionActive("fill");
  const ms = await previewPattern(fillPattern, highlightFillPlayhead);
  clearTimeout(fillPreviewCleanupTimer);
  fillPreviewCleanupTimer = setTimeout(() => {
    clearFillPlayhead();
    setSectionActive(null);
  }, ms);
});

function setSectionActive(section) {
  grooveGridWrapEl.classList.toggle("section-active", section === "groove");
  grooveNotationCardEl.classList.toggle("section-active", section === "groove");
  fillGridWrapEl.classList.toggle("section-active", section === "fill");
  fillNotationCardEl.classList.toggle("section-active", section === "fill");
}

presetSelect.addEventListener("change", () => {
  rhythmPattern = clonePattern(PRESETS[presetSelect.value]);
  saveRhythmState();
  renderGrooveGrid();
  renderGrooveNotation();
});

rhythmClearBtn.addEventListener("click", () => {
  rhythmPattern = clonePattern(PRESETS["空のパターン"]);
  presetSelect.value = "空のパターン";
  renderGrooveGrid();
  renderGrooveNotation();
  saveRhythmState();
});

fillClearBtn.addEventListener("click", () => {
  fillPattern = clonePattern(null);
  fillStyleKey = "none";
  fillStyleSel.value = "none";
  updateFillDescription();
  renderFillGrid();
  renderFillNotation();
  saveRhythmState();
});

rhythmBpmSlider.addEventListener("input", () => {
  rhythmBpm = parseInt(rhythmBpmSlider.value, 10);
  rhythmBpmValue.textContent = rhythmBpm;
  if (rhythmScheduler) rhythmScheduler.setStepDuration(60 / rhythmBpm / 4);
  saveRhythmState();
});

swingTypeSel.addEventListener("change", () => {
  swingType = swingTypeSel.value;
  renderGrooveNotation();
  renderFillNotation();
  saveRhythmState();
});

swingAmountSlider.addEventListener("input", () => {
  swingAmount = parseInt(swingAmountSlider.value, 10);
  swingAmountValue.textContent = `${swingAmount}%`;
  renderGrooveNotation();
  renderFillNotation();
  saveRhythmState();
});

function rhythmOnStep(rawStep, time) {
  const stepDur = 60 / rhythmBpm / 4;
  let stepInBar = rawStep;
  let barIndex = 1;
  let inFillNow = false;
  let pattern = rhythmPattern;
  let patternStepIndex = rawStep;

  if (fillEnabled) {
    stepInBar = rawStep % 16;
    barIndex = Math.floor(rawStep / 16) + 1;
    // Fill always ends exactly at the end of its designated bar; fillLengthSteps
    // controls how far back from that boundary the fill's active range starts.
    const barEndRaw = fillBarIndex * 16;
    const fillStartRaw = Math.max(0, barEndRaw - fillLengthSteps);
    inFillNow = rawStep >= fillStartRaw && rawStep < barEndRaw;
    if (inFillNow) {
      const spanLen = barEndRaw - fillStartRaw;
      const offsetIntoFill = rawStep - fillStartRaw;
      // Spans <=16 steps use the tail of the 16-step fill pattern (most fills
      // build toward the end); longer spans (2-bar fills) repeat the pattern.
      patternStepIndex = spanLen <= 16 ? 16 - spanLen + offsetIntoFill : offsetIntoFill % 16;
      pattern = fillPattern;
    } else {
      patternStepIndex = stepInBar;
      pattern = rhythmPattern;
    }
  }

  const t = time + swingDelayForStep(stepInBar, stepDur);
  TRACKS.forEach((track) => {
    if (pattern[track][patternStepIndex]) TRACK_SOUND[track](t);
  });

  if (stepInBar === 0 && prevBarEndedInFill) TRACK_SOUND.crash(t);
  if (stepInBar === 15) prevBarEndedInFill = inFillNow;

  // Both groove and fill are always visible, so just light up whichever
  // section is actually sounding right now and dim the other.
  const delay = Math.max(0, (t - audioEngine.ctx.currentTime) * 1000);
  setTimeout(() => {
    if (inFillNow) {
      highlightFillPlayhead(patternStepIndex);
      clearGroovePlayhead();
      setSectionActive("fill");
    } else {
      highlightGroovePlayhead(stepInBar);
      clearFillPlayhead();
      setSectionActive("groove");
    }
    renderBarProgress(barIndex);
  }, delay);
}

async function rhythmStart() {
  await audioEngine.ensureContext();
  audioEngine.setVolume(volumeSlider.value / 100);
  prevBarEndedInFill = false;
  rhythmScheduler = new Scheduler({
    onStep: rhythmOnStep,
    stepsPerLoop: currentStepsPerLoop(),
    secondsPerStep: 60 / rhythmBpm / 4,
  });
  rhythmScheduler.start();
  setPlayLabel(rhythmPlayBtn, "ストップ");
  rhythmPlayBtn.classList.add("playing");
}

function rhythmStop() {
  if (rhythmScheduler) {
    rhythmScheduler.stop();
    rhythmScheduler = null;
  }
  clearGroovePlayhead();
  clearFillPlayhead();
  setSectionActive(null);
  renderBarProgress(0);
  setPlayLabel(rhythmPlayBtn, "全体を再生");
  rhythmPlayBtn.classList.remove("playing");
}

let rhythmStarting = false;
rhythmPlayBtn.addEventListener("click", async () => {
  if (rhythmScheduler) {
    rhythmStop();
    return;
  }
  if (rhythmStarting) return;
  rhythmStarting = true;
  try {
    await rhythmStart();
  } finally {
    rhythmStarting = false;
  }
});

(function initRhythm() {
  const saved = loadRhythmState();
  if (saved && saved.pattern) {
    rhythmPattern = clonePattern(saved.pattern);
    if (saved.preset && PRESETS[saved.preset]) presetSelect.value = saved.preset;
    if (saved.bpm) {
      rhythmBpm = saved.bpm;
      rhythmBpmSlider.value = rhythmBpm;
      updateRangeFill(rhythmBpmSlider);
      rhythmBpmValue.textContent = rhythmBpm;
    }
    if (saved.swingType) {
      swingType = saved.swingType;
      swingTypeSel.value = swingType;
    }
    if (saved.swingAmount) {
      swingAmount = saved.swingAmount;
      swingAmountSlider.value = swingAmount;
      updateRangeFill(swingAmountSlider);
      swingAmountValue.textContent = `${swingAmount}%`;
    }
    fillEnabled = !!saved.fillEnabled;
    fillEnabledCb.checked = fillEnabled;
    if (saved.fillBars) {
      fillBars = saved.fillBars;
      fillBarsSel.value = fillBars;
    }
    fillBarIndex = saved.fillBarIndex || fillBars;
    if (saved.fillLengthSteps) {
      fillLengthSteps = saved.fillLengthSteps;
      fillLengthSel.value = fillLengthSteps;
    }
    if (saved.fillStyleKey && (saved.fillStyleKey === "none" || FILLS[saved.fillStyleKey])) {
      fillStyleKey = saved.fillStyleKey;
      fillStyleSel.value = fillStyleKey;
    }
    fillPattern = saved.fillPattern ? clonePattern(saved.fillPattern) : clonePattern(null);
    if (saved.trackMixer) {
      TRACKS.forEach((t) => {
        if (typeof saved.trackMixer[t] === "number") trackMixer[t] = saved.trackMixer[t];
      });
    }
  } else {
    rhythmPattern = clonePattern(PRESETS["8ビート (基本)"]);
    fillPattern = clonePattern(null);
  }
  populateFillBarIndexOptions();
  updateFillDescription();
  renderGrooveGrid();
  renderGrooveNotation();
  renderFillGrid();
  renderFillNotation();
  renderBarProgress(0);
  buildMixer();
})();

/* ============================================================
   STICKING / RUDIMENTS
   ============================================================ */
const RUDIMENTS = {
  "シングルストローク": "R L R L R L R L".split(" "),
  "ダブルストローク": "R R L L R R L L".split(" "),
  "シングルパラディドル": "R L R R L R L L".split(" "),
  "パラディドルディドル": "R L R R L L".split(" "),
  "ダブルパラディドル": "R L R L R R L R L R L L".split(" "),
  "トリプルストローク": "R R R L L L".split(" "),
};

const rudimentSelect = document.getElementById("rudimentSelect");
const noteValueSel = document.getElementById("noteValue");
const stickingBpmSlider = document.getElementById("stickingBpm");
const stickingBpmValue = document.getElementById("stickingBpmValue");
const stickingDisplay = document.getElementById("stickingDisplay");
const stickingPlayBtn = document.getElementById("stickingPlay");

let stickingScheduler = null;
let stickingBpm = 90;
let stickingNoteEls = [];

Object.keys(RUDIMENTS).forEach((name) => {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name;
  rudimentSelect.appendChild(opt);
});

function renderSticking() {
  const pattern = RUDIMENTS[rudimentSelect.value];
  stickingDisplay.innerHTML = "";
  stickingNoteEls = pattern.map((letter) => {
    const el = document.createElement("div");
    el.className = `stick-note ${letter}`;
    el.textContent = letter;
    stickingDisplay.appendChild(el);
    return el;
  });
}

rudimentSelect.addEventListener("change", () => {
  renderSticking();
  if (stickingScheduler) {
    stickingScheduler.setStepsPerLoop(RUDIMENTS[rudimentSelect.value].length);
    stickingScheduler.currentStep = 0;
  }
});

stickingBpmSlider.addEventListener("input", () => {
  stickingBpm = parseInt(stickingBpmSlider.value, 10);
  stickingBpmValue.textContent = stickingBpm;
  if (stickingScheduler) stickingScheduler.setStepDuration(stepDurationForSticking());
});

noteValueSel.addEventListener("change", () => {
  if (stickingScheduler) stickingScheduler.setStepDuration(stepDurationForSticking());
});

function stepDurationForSticking() {
  // note value select: 2 = eighth note (2 steps per beat), 4 = sixteenth (4 steps per beat)
  const stepsPerBeat = parseInt(noteValueSel.value, 10);
  return 60 / stickingBpm / stepsPerBeat;
}

function stickingOnStep(step, time) {
  const pattern = RUDIMENTS[rudimentSelect.value];
  const idx = step % pattern.length;
  const letter = pattern[idx];
  audioEngine.playStick(time, letter === "R");
  const delay = Math.max(0, (time - audioEngine.ctx.currentTime) * 1000);
  setTimeout(() => {
    stickingNoteEls.forEach((el) => el.classList.remove("current"));
    if (stickingNoteEls[idx]) stickingNoteEls[idx].classList.add("current");
  }, delay);
}

async function stickingStart() {
  await audioEngine.ensureContext();
  audioEngine.setVolume(volumeSlider.value / 100);
  const pattern = RUDIMENTS[rudimentSelect.value];
  stickingScheduler = new Scheduler({
    onStep: stickingOnStep,
    stepsPerLoop: pattern.length,
    secondsPerStep: stepDurationForSticking(),
  });
  stickingScheduler.start();
  setPlayLabel(stickingPlayBtn, "ストップ");
  stickingPlayBtn.classList.add("playing");
}

function stickingStop() {
  if (stickingScheduler) {
    stickingScheduler.stop();
    stickingScheduler = null;
  }
  stickingNoteEls.forEach((el) => el.classList.remove("current"));
  setPlayLabel(stickingPlayBtn, "スタート");
  stickingPlayBtn.classList.remove("playing");
}

let stickingStarting = false;
stickingPlayBtn.addEventListener("click", async () => {
  if (stickingScheduler) {
    stickingStop();
    return;
  }
  if (stickingStarting) return;
  stickingStarting = true;
  try {
    await stickingStart();
  } finally {
    stickingStarting = false;
  }
});

renderSticking();
