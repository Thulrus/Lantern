// Music analysis worker: receives decoded channel data, returns a MusicAnalysis.
import { analyzeMusic } from "$lib/audio/analyze";

self.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[]; sampleRate: number }>) => {
  const { id, channels, sampleRate } = e.data;
  try {
    const result = analyzeMusic(channels, sampleRate, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
