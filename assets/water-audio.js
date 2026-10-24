/** A small, entirely local water-pouring synthesizer. No audio downloads needed. */
export function createWaterAudio() {
  let context = null;
  let master = null;
  let noiseBuffer = null;
  let current = null;
  let volume = 0.65;
  let disposed = false;
  const groups = new Set();
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function makeNoise() {
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 2), context.sampleRate);
    const samples = buffer.getChannelData(0);
    let lowNoise = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const white = Math.random() * 2 - 1;
      lowNoise = lowNoise * 0.98 + white * 0.02;
      samples[index] = white * 0.68 + lowNoise * 1.6;
    }
    return buffer;
  }

  function disconnectGroup(group) {
    if (group.closed) return;
    group.closed = true;
    clearTimeout(group.timer);
    for (const source of group.sources) {
      try { source.stop(); } catch { /* Already stopped sources need no further action. */ }
    }
    for (const node of group.nodes) {
      try { node.disconnect(); } catch { /* A previously disconnected node is harmless. */ }
    }
    groups.delete(group);
    if (current === group) current = null;
  }

  function releaseGroup(group) {
    if (!group || group.closed || group.releasing) return;
    group.releasing = true;
    clearTimeout(group.timer);
    if (current === group) current = null;
    try {
      const time = context.currentTime;
      const envelope = group.output.gain;
      // Use the current instantaneous envelope value to avoid a click on interruption.
      if (typeof envelope.cancelAndHoldAtTime === 'function') envelope.cancelAndHoldAtTime(time);
      else {
        const value = envelope.value;
        envelope.cancelScheduledValues(time);
        envelope.setValueAtTime(value, time);
      }
      envelope.linearRampToValueAtTime(0, time + 0.04);
      for (const source of group.sources) {
        try { source.stop(time + 0.05); } catch { /* It may have ended naturally. */ }
      }
      group.timer = setTimeout(() => disconnectGroup(group), 80);
    } catch {
      disconnectGroup(group);
    }
  }

  async function unlock() {
    if (disposed) return false;
    try {
      if (!context || context.state === 'closed') {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return false;
        // Both construction and resume are invoked before the first await, inside
        // the caller's click handler, so browser autoplay rules are respected.
        context = new AudioContextClass({ latencyHint: 'interactive' });
        master = context.createGain();
        master.gain.value = Math.pow(volume, 1.5) * 0.85;
        master.connect(context.destination);
        noiseBuffer = makeNoise();
      }
      const resumed = context.resume();
      await resumed;
      return context.state === 'running';
    } catch {
      return false;
    }
  }

  function setVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    volume = clamp(number, 0, 1);
    try {
      if (master && context?.state !== 'closed') {
        const time = context.currentTime;
        master.gain.cancelScheduledValues(time);
        master.gain.setTargetAtTime(Math.pow(volume, 1.5) * 0.85, time, 0.02);
      }
    } catch { /* Audio settings never interrupt gameplay. */ }
  }

  function start(durationMs, progress = 0) {
    releaseGroup(current);
    if (disposed || !context || context.state !== 'running' || !noiseBuffer) return;
    const milliseconds = Number(durationMs);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    const duration = clamp(milliseconds / 1000, 0.05, 15);
    const initialProgress = Number.isFinite(progress) ? clamp(progress, 0, 1) : 0;
    let group;
    try {
      const time = context.currentTime + 0.008;
      const end = time + duration;
      const output = context.createGain();
      group = { output, nodes: [output], sources: [], timer: null, closed: false, releasing: false };
      groups.add(group);
      current = group;
      output.connect(master);
      output.gain.setValueAtTime(0, time);
      output.gain.linearRampToValueAtTime(0.85, time + Math.min(0.1, duration * 0.2));
      output.gain.setValueAtTime(0.85, time + duration * 0.82);
      output.gain.linearRampToValueAtTime(0, end);

      const own = (node) => { group.nodes.push(node); return node; };
      const source = () => {
        const node = own(context.createBufferSource());
        node.buffer = noiseBuffer;
        group.sources.push(node);
        return node;
      };

      // Broad, soft liquid hiss is the continuous stream. A slowly moving
      // resonant layer suggests the shrinking air cavity as the cup fills.
      const stream = source();
      stream.loop = true;
      const highpass = own(context.createBiquadFilter());
      highpass.type = 'highpass';
      highpass.frequency.value = 380;
      const lowpass = own(context.createBiquadFilter());
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(2700, time);
      lowpass.frequency.linearRampToValueAtTime(3900, end);
      lowpass.Q.value = 0.3;
      const streamGain = own(context.createGain());
      streamGain.gain.value = 0.32;
      stream.connect(highpass).connect(lowpass).connect(streamGain).connect(output);
      stream.start(time, Math.random());
      stream.stop(end);

      const gurgle = source();
      gurgle.loop = true;
      const resonance = own(context.createBiquadFilter());
      resonance.type = 'bandpass';
      resonance.Q.value = 3.6;
      resonance.frequency.setValueAtTime(330 + initialProgress * 480, time);
      resonance.frequency.exponentialRampToValueAtTime(880, end);
      const gurgleGain = own(context.createGain());
      gurgleGain.gain.value = 0.4;
      gurgle.connect(resonance).connect(gurgleGain).connect(output);
      gurgle.start(time, Math.random());
      gurgle.stop(end);

      // Irregular, tiny pitched bubbles make the sound read as water rather
      // than static. Pitch rises with fill; individual bubbles fall in pitch.
      for (let offset = 0.025; offset < duration - 0.06; offset += 0.045 + Math.random() * 0.075) {
        const fill = initialProgress + (1 - initialProgress) * (offset / duration);
        const bubble = own(context.createOscillator());
        bubble.type = 'sine';
        group.sources.push(bubble);
        const envelope = own(context.createGain());
        const begin = time + offset;
        const length = Math.min(0.04 + Math.random() * 0.065, end - begin);
        const frequency = 350 + fill * 760 + Math.random() * 650;
        bubble.frequency.setValueAtTime(frequency * 1.45, begin);
        bubble.frequency.exponentialRampToValueAtTime(frequency * 0.66, begin + length);
        envelope.gain.setValueAtTime(0, begin);
        envelope.gain.linearRampToValueAtTime(0.025 + Math.random() * 0.045, begin + 0.004);
        envelope.gain.exponentialRampToValueAtTime(0.0001, begin + length);
        bubble.connect(envelope).connect(output);
        bubble.start(begin);
        bubble.stop(begin + length);
      }

      // Short high-frequency noise bursts add the small splashes at impact.
      for (let offset = 0.07; offset < duration - 0.08; offset += 0.13 + Math.random() * 0.14) {
        const splash = source();
        const filter = own(context.createBiquadFilter());
        filter.type = 'bandpass';
        filter.frequency.value = 1700 + Math.random() * 2800;
        filter.Q.value = 0.65;
        const envelope = own(context.createGain());
        const begin = time + offset;
        const length = Math.min(0.07, end - begin);
        envelope.gain.setValueAtTime(0, begin);
        envelope.gain.linearRampToValueAtTime(0.09 + Math.random() * 0.05, begin + 0.004);
        envelope.gain.exponentialRampToValueAtTime(0.0001, begin + length);
        splash.connect(filter).connect(envelope).connect(output);
        splash.start(begin, Math.random());
        splash.stop(begin + length);
      }

      group.timer = setTimeout(() => disconnectGroup(group), duration * 1000 + 100);
    } catch {
      if (group) disconnectGroup(group);
    }
  }

  function stop() {
    releaseGroup(current);
  }

  async function dispose() {
    disposed = true;
    for (const group of [...groups]) disconnectGroup(group);
    current = null;
    try {
      master?.disconnect();
      if (context && context.state !== 'closed') await context.close();
    } catch { /* A closing or unsupported audio context needs no recovery. */ }
    context = null;
    master = null;
    noiseBuffer = null;
  }

  return { unlock, start, stop, setVolume, isPlaying: () => Boolean(current && !current.closed && !current.releasing), dispose };
}
