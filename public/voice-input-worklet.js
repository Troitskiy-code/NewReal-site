/* global AudioWorkletProcessor, registerProcessor, sampleRate */

registerProcessor("newverse-voice-input", class extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.maxSamples = processorOptions.maxSamples;
    this.samples = new DataView(new ArrayBuffer(this.maxSamples * 2));
    this.length = 0;
    this.targetRate = processorOptions.targetRate;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.finished = false;
    this.port.onmessage = () => this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    const pcm = this.samples.buffer.slice(0, this.length * 2);
    this.port.postMessage(pcm, [pcm]);
  }

  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length && this.length < this.maxSamples; i++) {
      this.sum += input[i];
      this.count++;
      this.phase += this.targetRate;
      if (this.phase >= sampleRate) {
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        this.samples.setInt16(this.length++ * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
        this.phase -= sampleRate;
        this.sum = 0;
        this.count = 0;
      }
    }
    if (this.length === this.maxSamples) this.finish();
    return !this.finished;
  }
});
