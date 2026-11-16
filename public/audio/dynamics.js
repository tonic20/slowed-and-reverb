// Stereo-linked peak protection and reverb ducking, shared by live and offline graphs.
class Dynamics extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'duck', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'safe', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'volume', defaultValue: 0.75, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.envelope = 0;
    this.gain = 1;
    this.attack = Math.exp(-1 / (sampleRate * 0.008));
    this.release = Math.exp(-1 / (sampleRate * 0.18));
    this.limitRelease = Math.exp(-1 / (sampleRate * 0.06));
  }
  process(inputs, outputs, parameters) {
    const out = outputs[0],
      dry = inputs[0],
      wet = inputs[1];
    for (let i = 0; i < out[0].length; i++) {
      let detector = 0;
      for (let c = 0; c < out.length; c++) detector = Math.max(detector, Math.abs(dry[c]?.[i] || 0));
      const coefficient = detector > this.envelope ? this.attack : this.release;
      this.envelope = coefficient * this.envelope + (1 - coefficient) * detector;
      const duck = parameters.duck[0] ? 1 / (1 + this.envelope * 10) : 1;
      const volume = parameters.volume.length === 1 ? parameters.volume[0] : parameters.volume[i];
      let peak = 0;
      for (let c = 0; c < out.length; c++) {
        out[c][i] = ((dry[c]?.[i] || 0) + (wet[c]?.[i] || 0) * duck) * volume;
        peak = Math.max(peak, Math.abs(out[c][i]));
      }
      const ceiling = peak > 0.98 ? 0.98 / peak : 1;
      this.gain = Math.min(ceiling, 1 - (1 - this.gain) * this.limitRelease);
      if (parameters.safe[0]) for (const channel of out) channel[i] *= this.gain;
    }
    return true;
  }
}
registerProcessor('sr-dynamics', Dynamics);
