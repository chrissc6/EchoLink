const SAMPLE_RATE = 24000;
export const HIGH_FREQUENCY_RMS_LIMIT = 0.35;

/** Detects gross high-frequency hiss/corruption; it cannot judge pronunciation or naturalness. */
export function measureAudioQuality(samples, sampleRate = SAMPLE_RATE) {
  const frameSize = 1024;
  const hopSize = frameSize / 2;
  const real = new Float64Array(frameSize);
  const imaginary = new Float64Array(frameSize);
  let highEnergy = 0;
  let totalEnergy = 0;
  let frames = 0;
  const highStart = Math.ceil((6000 * frameSize) / sampleRate);

  for (let start = 0; start < samples.length; start += hopSize) {
    real.fill(0);
    imaginary.fill(0);
    const count = Math.min(frameSize, samples.length - start);
    if (count < frameSize / 4) break;
    for (let index = 0; index < count; index += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (frameSize - 1));
      real[index] = samples[start + index] * window;
    }
    for (let index = 1, reversed = 0; index < frameSize; index += 1) {
      let bit = frameSize >> 1;
      while (reversed & bit) { reversed ^= bit; bit >>= 1; }
      reversed ^= bit;
      if (index < reversed) [real[index], real[reversed]] = [real[reversed], real[index]];
    }
    for (let size = 2; size <= frameSize; size <<= 1) {
      const half = size >> 1;
      const angle = (-2 * Math.PI) / size;
      const stepReal = Math.cos(angle);
      const stepImaginary = Math.sin(angle);
      for (let offset = 0; offset < frameSize; offset += size) {
        let weightReal = 1;
        let weightImaginary = 0;
        for (let index = 0; index < half; index += 1) {
          const even = offset + index;
          const odd = even + half;
          const oddReal = real[odd] * weightReal - imaginary[odd] * weightImaginary;
          const oddImaginary = real[odd] * weightImaginary + imaginary[odd] * weightReal;
          real[odd] = real[even] - oddReal;
          imaginary[odd] = imaginary[even] - oddImaginary;
          real[even] += oddReal;
          imaginary[even] += oddImaginary;
          const nextReal = weightReal * stepReal - weightImaginary * stepImaginary;
          weightImaginary = weightReal * stepImaginary + weightImaginary * stepReal;
          weightReal = nextReal;
        }
      }
    }
    for (let bin = 1; bin <= frameSize / 2; bin += 1) {
      const energy = real[bin] ** 2 + imaginary[bin] ** 2;
      totalEnergy += energy;
      if (bin >= highStart) highEnergy += energy;
    }
    frames += 1;
    if (start + frameSize >= samples.length) break;
  }
  return { highFrequencyRmsShare: totalEnergy > 0 ? Math.sqrt(highEnergy / totalEnergy) : 0, frames };
}

export function validateEchoLinkAudioQuality(samples, label = 'Kokoro speech') {
  let peak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error(`${label} produced invalid audio samples.`);
    peak = Math.max(peak, Math.abs(sample));
  }
  if (!samples.length || peak < 0.001) throw new Error(`${label} produced silent audio.`);
  const result = measureAudioQuality(samples);
  if (!result.frames) throw new Error(`${label} was too short for the audio-quality check.`);
  if (result.highFrequencyRmsShare > HIGH_FREQUENCY_RMS_LIMIT) {
    throw new Error(`${label} failed the audio-quality check (${(result.highFrequencyRmsShare * 100).toFixed(1)}% high-frequency noise; limit ${(HIGH_FREQUENCY_RMS_LIMIT * 100).toFixed(0)}%).`);
  }
  return { ...result, peak };
}
