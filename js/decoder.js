// WebCodecs 解码:从 .vrs 中逐帧取出画面
import { b64ToBytes } from './util.js';

export async function decodeFrames(vrs, { skip = 1, onFrame, onProgress } = {}) {
  const { meta, chunks } = vrs;
  const config = { codec: meta.codec };
  if (meta.description) config.description = b64ToBytes(meta.description);
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error('无法解码 ' + meta.codec);

  let idx = 0, error = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const i = idx++;
      if (i % skip === 0) {
        try { onFrame(frame, i); } finally { frame.close(); }
      } else {
        frame.close();
      }
      if (onProgress && i % 300 === 0) onProgress(i / chunks.length);
    },
    error: (e) => { error = e; },
  });
  decoder.configure(config);
  for (const c of chunks) {
    if (error) throw error;
    decoder.decode(new EncodedVideoChunk({
      type: c.key ? 'key' : 'delta',
      timestamp: c.ts,
      duration: c.dur,
      data: c.data,
    }));
    while (decoder.decodeQueueSize > 16 && !error) {
      await new Promise(r => setTimeout(r, 1));
    }
  }
  await decoder.flush();
  decoder.close();
  if (error) throw error;
  return idx;
}
