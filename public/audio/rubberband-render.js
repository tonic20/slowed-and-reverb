import { RubberBandInterface, RubberBandOption as Option } from '../vendor/rubberband/index.esm.js';

self.onmessage = async ({ data }) => {
  let api,
    state,
    pointers = [],
    channelPointer;
  try {
    const { channels, sampleRate, pitchScale, formantScale, shortWindow } = data;
    const module = await WebAssembly.compileStreaming(fetch('/vendor/rubberband/rubberband.wasm'));
    api = await RubberBandInterface.initialize(module);
    const options =
      Option.RubberBandOptionEngineFiner |
      Option.RubberBandOptionChannelsTogether |
      Option.RubberBandOptionThreadingNever |
      Option.RubberBandOptionPitchHighQuality |
      (shortWindow ? Option.RubberBandOptionWindowShort : 0) |
      Option.RubberBandOptionProcessRealTime;
    state = api.rubberband_new(sampleRate, channels.length, options, 1, pitchScale);
    api.rubberband_set_formant_scale(state, formantScale);
    const block = 1024;
    api.rubberband_set_max_process_size(state, block);
    const inputLength = channels[0].length;
    const outputLength = inputLength;
    const outputs = channels.map(() => new Float32Array(outputLength));
    channelPointer = api.malloc(channels.length * 4);
    pointers = channels.map((_, channel) => {
      const pointer = api.malloc(block * 4);
      api.memWritePtr(channelPointer + channel * 4, pointer);
      return pointer;
    });
    const zeros = new Float32Array(block);
    function write(offset, count) {
      pointers.forEach((pointer, channel) => api.memWrite(pointer, channels[channel].subarray(offset, offset + count)));
    }
    let discard = api.rubberband_get_start_delay(state);
    let written = 0;
    function retrieve() {
      let available;
      while ((available = api.rubberband_available(state)) > 0) {
        const count = api.rubberband_retrieve(state, channelPointer, Math.min(block, available));
        if (!count) throw Error('Rubber Band stopped producing samples');
        const skip = Math.min(discard, count);
        discard -= skip;
        const take = Math.min(count - skip, outputLength - written);
        pointers.forEach((pointer, channel) =>
          outputs[channel].set(api.memReadF32(pointer, count).subarray(skip, skip + take), written),
        );
        written += take;
      }
    }
    let padding = api.rubberband_get_preferred_start_pad(state);
    while (padding > 0) {
      const count = Math.min(block, padding);
      pointers.forEach((pointer) => api.memWrite(pointer, zeros));
      api.rubberband_process(state, channelPointer, count, 0);
      retrieve();
      padding -= count;
    }
    for (let offset = 0; offset < inputLength; offset += block) {
      const count = Math.min(block, inputLength - offset);
      write(offset, count);
      api.rubberband_process(state, channelPointer, count, Number(offset + count === inputLength));
      retrieve();
    }
    retrieve();
    if (written < outputLength - 128) throw Error(`Rubber Band returned ${written} of ${outputLength} frames`);
    for (const channel of outputs) if (!channel.every(Number.isFinite)) throw Error('Invalid Rubber Band samples');
    self.postMessage(
      { channels: outputs, written },
      outputs.map((channel) => channel.buffer),
    );
  } catch (error) {
    self.postMessage({ error: error.message });
  } finally {
    for (const pointer of pointers) api.free(pointer);
    if (channelPointer) api.free(channelPointer);
    if (state) api.rubberband_delete(state);
  }
};
