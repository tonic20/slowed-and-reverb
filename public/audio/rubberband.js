import { RubberBandInterface, RubberBandOption as Option } from '../vendor/rubberband/index.esm.js';

class RubberBandProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.disposed = false;
    this.underrunFrames = 0;
    this.overflowFrames = 0;
    this.queuedFrames = 0;
    this.minQueuedFrames = Infinity;
    this.readOffset = 0;
    this.writeOffset = 0;
    this.inputFrames = 0;
    this.started = false;
    this.capacity = 65536;
    this.prefill = 4096;
    this.queue = [new Float32Array(this.capacity), new Float32Array(this.capacity)];
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'dispose') this.dispose();
    };
    this.initialize(options.processorOptions).catch((error) => {
      this.port.postMessage({ type: 'error', message: error.message });
      this.dispose();
    });
  }
  async initialize({ module, pitchScale, formantScale, shortWindow }) {
    this.api = await RubberBandInterface.initialize(module);
    if (this.disposed) return;
    const options =
      Option.RubberBandOptionProcessRealTime |
      Option.RubberBandOptionEngineFiner |
      Option.RubberBandOptionChannelsTogether |
      Option.RubberBandOptionThreadingNever |
      Option.RubberBandOptionPitchHighQuality |
      (shortWindow ? Option.RubberBandOptionWindowShort : 0);
    this.state = this.api.rubberband_new(sampleRate, 2, options, 1, pitchScale);
    this.api.rubberband_set_formant_scale(this.state, formantScale);
    this.block = 128;
    this.api.rubberband_set_max_process_size(this.state, this.block);
    this.channelPointer = this.api.malloc(8);
    this.pointers = [this.api.malloc(this.block * 4), this.api.malloc(this.block * 4)];
    this.pointers.forEach((pointer, channel) => this.api.memWritePtr(this.channelPointer + channel * 4, pointer));
    this.zero = new Float32Array(this.block);
    this.discard = this.api.rubberband_get_start_delay(this.state);
    const pad = this.api.rubberband_get_preferred_start_pad(this.state);
    for (let remaining = pad; remaining > 0; remaining -= this.block) {
      this.pointers.forEach((pointer) => this.api.memWrite(pointer, this.zero));
      this.api.rubberband_process(this.state, this.channelPointer, Math.min(this.block, remaining), 0);
      this.retrieve();
    }
    this.ready = true;
    this.port.postMessage({ type: 'ready' });
  }
  retrieve() {
    let available;
    while ((available = this.api.rubberband_available(this.state)) > 0) {
      const count = this.api.rubberband_retrieve(this.state, this.channelPointer, Math.min(this.block, available));
      if (!count) throw Error('Rubber Band returned no samples');
      const skip = Math.min(this.discard, count);
      this.discard -= skip;
      const frames = count - skip;
      if (this.queuedFrames + frames > this.capacity) {
        this.overflowFrames += frames;
        throw Error('Rubber Band output queue overflow');
      }
      this.pointers.forEach((pointer, channel) => {
        const data = this.api.memReadF32(pointer, count);
        for (let i = 0; i < frames; i++) this.queue[channel][(this.writeOffset + i) % this.capacity] = data[skip + i];
      });
      this.writeOffset = (this.writeOffset + frames) % this.capacity;
      this.queuedFrames += frames;
    }
  }
  dispose() {
    this.disposed = true;
    if (this.state) this.api.rubberband_delete(this.state);
    this.state = null;
    for (const pointer of this.pointers || []) this.api.free(pointer);
    this.pointers = [];
    if (this.channelPointer) this.api.free(this.channelPointer);
    this.channelPointer = null;
  }
  process(inputs, outputs) {
    if (this.disposed) return false;
    if (!this.ready) return true;
    const output = outputs[0],
      frames = output[0].length;
    try {
      if (frames !== this.block) throw Error('Unsupported audio render quantum');
      this.pointers.forEach((pointer, channel) =>
        this.api.memWrite(pointer, inputs[0]?.[channel] || inputs[0]?.[0] || this.zero),
      );
      this.api.rubberband_process(this.state, this.channelPointer, frames, 0);
      this.inputFrames += frames;
      this.retrieve();
      if (!this.started) {
        if (this.queuedFrames < this.prefill) return true;
        this.started = true;
        this.streamLatencyFrames = this.inputFrames - frames;
        this.port.postMessage({ type: 'started', latency: this.streamLatencyFrames / sampleRate });
      }
      this.minQueuedFrames = Math.min(this.minQueuedFrames, this.queuedFrames);
      const count = Math.min(frames, this.queuedFrames);
      for (let channel = 0; channel < output.length; channel++)
        for (let i = 0; i < count; i++) output[channel][i] = this.queue[channel][(this.readOffset + i) % this.capacity];
      this.readOffset = (this.readOffset + count) % this.capacity;
      this.queuedFrames -= count;
      this.underrunFrames += frames - count;
      if (this.inputFrames % (this.block * 375) === 0)
        this.port.postMessage({
          type: 'statistics',
          underrunFrames: this.underrunFrames,
          overflowFrames: this.overflowFrames,
          queuedFrames: this.queuedFrames,
          seconds: this.inputFrames / sampleRate,
        });
      return true;
    } catch (error) {
      this.port.postMessage({ type: 'error', message: error.message });
      this.dispose();
      return false;
    }
  }
}
registerProcessor('sr-rubberband', RubberBandProcessor);
