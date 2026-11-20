// 会话录制:渲染合成场景 → WebCodecs 编码 → 打包 .vrs
import { buildSession } from './trajectory.js';
import { pathPoint, PATH_LENGTH } from './trajectory.js';
import { SceneRenderer } from './scene.js';
import { encodeVRS } from './vrs.js';
import { bytesToB64 } from './util.js';

const CODEC_CANDIDATES = ['vp8', 'vp09.00.10.08', 'avc1.42001f'];

async function pickCodec(width, height, fps) {
  for (const codec of CODEC_CANDIDATES) {
    const cfg = { codec, width, height, bitrate: Math.round(width * height * fps * 0.12), framerate: fps, latencyMode: 'realtime' };
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return cfg;
    } catch (e) { /* 尝试下一个 */ }
  }
  throw new Error('当前浏览器没有可用的视频编码器 (vp8/vp9/avc)');
}

export async function generateSession(opts = {}, onProgress = () => {}) {
  const { duration = 120, fps = 90, width = 1280, height = 720, seed = 1, aggressiveness = 0.7 } = opts;
  const session = buildSession({ duration, fps, seed, aggressiveness });
  const cfg = await pickCodec(width, height, fps);

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const scene = new SceneRenderer(canvas, session.level, pathPoint, PATH_LENGTH);

  const chunks = [];
  let decoderConfig = null;
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ key: chunk.type === 'key', ts: chunk.timestamp, dur: chunk.duration ?? Math.round(1e6 / fps), data });
      if (meta && meta.decoderConfig) {
        decoderConfig = { codec: meta.decoderConfig.codec };
        if (meta.decoderConfig.description) {
          decoderConfig.description = bytesToB64(new Uint8Array(meta.decoderConfig.description));
        }
      }
    },
    error: (e) => { encErr = e; },
  });
  encoder.configure(cfg);

  const n = session.n;
  const keyInterval = Math.max(1, Math.round(fps * 2));
  for (let k = 0; k < n; k++) {
    if (encErr) throw encErr;
    const camPose = session.cam.subarray(k * 7, k * 7 + 7);
    scene.render(camPose, session.starAlpha[k]);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: k % keyInterval === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 4 && !encErr) {
      await new Promise(r => setTimeout(r, 1));
    }
    if (k % 30 === 0) onProgress(k / n, `渲染+编码 ${k}/${n} 帧`);
  }
  await encoder.flush();
  encoder.close();
  if (encErr) throw encErr;

  const meta = {
    version: 1,
    width, height, fps, duration,
    codec: decoderConfig?.codec || cfg.codec,
    description: decoderConfig?.description || null,
    frameCount: n,
    poseFps: fps,
    fovX: 100,
    seed, aggressiveness,
    level: session.level,
    events: session.events,
    trueRisk: session.trueRisk,
    camPosPerSec: session.camPosPerSec,
  };
  const blob = encodeVRS(meta, session.head, chunks);
  onProgress(1, '完成');
  return { blob, meta, session };
}
