// 试玩数据生成管线（浏览器端）：
//   scene.mjs 运动学模型 → Canvas 逐帧渲染 → VideoEncoder(90fps) → VrdWriter 打包
//
// 编码优先 H.264 Baseline（兼容性最好），失败回退 VP9；
// 编码队列背压时让出主线程，UI 通过 onProgress 显示进度。
import { createSceneModel, FPS, VIDEO_W, VIDEO_H } from '../shared/scene.mjs';
import { VrdWriter } from '../shared/vrd.mjs';
import { createCorridorRenderer } from './corridor-render.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODEC_CANDIDATES = [
  // Chrome 的硬件/软件 AVC 编码器普遍输出 Annex-B（无 avcC description），
  // 显式指定 annexb 格式，解码器端无需 description 即可从起始码解析 SPS/PPS
  { codec: 'avc1.42E01E', label: 'H.264 Baseline', avc: { format: 'annexb' } },
  { codec: 'avc1.4D401E', label: 'H.264 Main', avc: { format: 'annexb' } },
  { codec: 'vp09.00.10.08', label: 'VP9' },
];

async function selectEncoder() {
  for (const cand of CODEC_CANDIDATES) {
    const config = {
      codec: cand.codec,
      width: VIDEO_W,
      height: VIDEO_H,
      bitrate: 1_200_000,
      framerate: FPS,
      latencyMode: 'realtime',
    };
    if (cand.avc) config.avc = cand.avc;
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return { cand, config };
    } catch {
      /* 探测下一个 */
    }
  }
  throw new Error('没有可用的编码器配置（H.264/VP9 均不支持）');
}

export async function generateSession({
  duration = 120,
  seed = 42,
  profile,
  onProgress = () => {},
  signal,
} = {}) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs VideoEncoder');
  }
  const model = createSceneModel({ duration, seed, profile });
  const canvas = document.createElement('canvas');
  const renderer = createCorridorRenderer(canvas);
  const writer = new VrdWriter({ ...model.meta, events: model.events });

  const { cand, config } = await selectEncoder();
  const chunks = [];
  let description = null;
  const encoder = new VideoEncoder({
    output: (chunk, dec) => {
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      // AVC 的 avcC / VP9 的 codec config 随首个关键帧在 decoderConfig.description 给出
      if (dec?.description && !description) {
        const src = new Uint8Array(dec.description.buffer ?? dec.description,
          dec.description.byteOffset ?? 0, dec.description.byteLength);
        description = src.slice(); // 独立拷贝，避免底层缓冲被回收
      }
      chunks.push({
        data: new Uint8Array(buf),
        timestamp: chunk.timestamp,
        isKey: chunk.type === 'key',
      });
    },
    error: (e) => { throw e; },
  });
  encoder.configure(config);

  const frameDuration = 1_000_000 / FPS; // 微秒
  const total = model.frames.length;
  const keyEvery = FPS * 2; // 每 2 秒一个关键帧

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) {
      encoder.close();
      throw new DOMException('已取消', 'AbortError');
    }
    const state = model.frames[i];
    renderer.render(model, state);
    writer.addFrame(state);

    const frame = new VideoFrame(canvas, {
      timestamp: i * frameDuration,
      duration: frameDuration,
    });
    encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();

    // 背压控制：队列过长时等编码器排空，防止内存膨胀
    if (encoder.encodeQueueSize > 24) {
      while (encoder.encodeQueueSize > 8) await sleep(2);
    }
    if (i % Math.round(FPS / 3) === 0) {
      onProgress(i / total);
      await sleep(0); // 让出主线程给 UI
    }
  }
  await encoder.flush();
  encoder.close();

  for (const c of chunks) writer.addVideoChunk(c.data, c.timestamp, c.isKey);
  const bytes = writer.finalize(cand.codec, description);

  onProgress(1);
  return {
    bytes,
    meta: writer.meta,
    codec: cand.label,
    events: model.events,
    model, // 内存模式可直接复用，免去重新解码
  };
}
