// Instrument only this lab's processors. Extension DSP files are loaded unchanged.
const register = globalThis.registerProcessor;
const highResolution = typeof performance !== 'undefined' && typeof performance.now === 'function';
const now = highResolution ? () => performance.now() : () => Date.now();
globalThis.registerProcessor = (name, Processor) => {
  class MeasuredProcessor extends Processor {
    constructor(options) {
      super(options);
      this.measurement = null;
      this.port.addEventListener('message', ({ data }) => {
        if (data?.type === 'measure-start') {
          this.measurement = {
            blocks: 0,
            frames: 0,
            totalMs: 0,
            maxMs: 0,
            overBudget: 0,
            zeroBlocks: 0,
            histogram: new Uint32Array(401),
            underrunsAtStart: this.underrunFrames || 0,
            overflowsAtStart: this.overflowFrames || 0,
          };
        }
        if (data?.type === 'measure-snapshot') this.report(data.id);
      });
      this.port.start();
    }
    report(id) {
      const measurement = this.measurement;
      if (!measurement?.blocks) return;
      let cumulative = 0,
        p99Ms = 0;
      for (let index = 0; index < measurement.histogram.length; index++) {
        cumulative += measurement.histogram[index];
        if (cumulative >= measurement.blocks * 0.99) {
          p99Ms = index / 10;
          break;
        }
      }
      this.port.postMessage({
        type: 'dsp-metrics',
        id,
        blocks: measurement.blocks,
        seconds: measurement.frames / sampleRate,
        meanMs: measurement.totalMs / measurement.blocks,
        maxMs: measurement.maxMs,
        p99Ms,
        workPercent: (measurement.totalMs / ((measurement.frames / sampleRate) * 1000)) * 100,
        overBudget: measurement.overBudget,
        zeroBlocks: measurement.zeroBlocks,
        underrunFrames: (this.underrunFrames || 0) - measurement.underrunsAtStart,
        overflowFrames: (this.overflowFrames || 0) - measurement.overflowsAtStart,
        fifoFrames: this.queuedFrames ?? null,
        minFifoFrames: this.minQueuedFrames ?? null,
        latencyFrames: this.streamLatencyFrames ?? null,
        timer: highResolution ? 'performance.now' : 'Date.now (1 ms)',
      });
    }
    process(inputs, outputs, parameters) {
      const began = now();
      const active = super.process(inputs, outputs, parameters);
      const elapsed = Math.max(0, now() - began);
      const measurement = this.measurement;
      if (!measurement || !active) return active;
      const frames = outputs[0]?.[0]?.length || 128;
      measurement.blocks++;
      measurement.frames += frames;
      measurement.totalMs += elapsed;
      measurement.maxMs = Math.max(measurement.maxMs, elapsed);
      measurement.histogram[Math.min(400, Math.ceil(elapsed * 10))]++;
      if (elapsed > (frames / sampleRate) * 1000) measurement.overBudget++;
      let inputEnergy = 0,
        outputEnergy = 0;
      for (let i = 0; i < frames; i++) {
        inputEnergy += (inputs[0]?.[0]?.[i] || 0) ** 2;
        outputEnergy += (outputs[0]?.[0]?.[i] || 0) ** 2;
      }
      if (inputEnergy > 1e-6 && outputEnergy === 0) measurement.zeroBlocks++;
      if (measurement.blocks % 375 === 0) this.report();
      return active;
    }
  }
  register(name, MeasuredProcessor);
};

class Passthrough extends AudioWorkletProcessor {
  process(inputs, outputs) {
    outputs[0].forEach((channel, index) => channel.set(inputs[0]?.[index] || new Float32Array(channel.length)));
    return true;
  }
}
registerProcessor('comparison-passthrough', Passthrough);
