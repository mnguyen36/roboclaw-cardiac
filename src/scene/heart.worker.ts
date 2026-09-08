/// <reference lib="webworker" />
import { computeHeartData } from './heartCompute';

self.onmessage = (e: MessageEvent<{ resolution: number }>) => {
  try {
    const data = computeHeartData(e.data.resolution, (label, fraction) => {
      (self as unknown as Worker).postMessage({ type: 'progress', label, fraction });
    });
    const transfer = [
      data.positions.buffer, data.normals.buffer, data.colors.buffer,
      data.beatWeights.buffer, data.fat.buffer, data.indices.buffer,
    ];
    (self as unknown as Worker).postMessage({ type: 'done', data }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: (err as Error).message });
  }
};
