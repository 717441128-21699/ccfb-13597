// 浏览器分析管线：VRD → VideoDecoder 解码 → WebGL2 LK 光流 → 共享分析器
//
// 时间对齐：视频帧与姿态帧同为 90Hz 等间隔，按帧号对齐；
// 头动预期光流（hx/hy）由姿态流的 headYawRate/headPitchRate 解析计算，
// 与 scene.mjs 中“仅头部转动”公式一致，用于“画面动头没动”对照。
import { createFlowGL, glFlowSupported } from './flow-gl.mjs';
import { createFlowCPU } from './flow-cpu.mjs';
import { createAnalyzer } from '../shared/analyzer.mjs';
import { VIDEO_W, VIDEO_H, FPS, GRID_COLS, GRID_ROWS, FOCAL } from '../shared/scene.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 由头动角速度算预期旋转光流（像素/秒），与解析模型同公式
function headFlow(grid, headYawRate, headPitchRate) {
  const hx = new Float32Array(grid.length);
  const hy = new Float32Array(grid.length);
  for (let c = 0; c < grid.length; c++) {
    const { x, y } = grid[c];
    hx[c] = FOCAL * (-headYawRate * (1 + x * x) - headPitchRate * x * y);
    hy[c] = FOCAL * (-headYawRate * x * y - headPitchRate * (1 + y * y));
  }
  return { hx, hy };
}

// 构造与 scene.mjs 同构的 16×9 网格（GL 读回结果按这个索引解释）
function buildGrid() {
  const grid = [];
  for (let j = 0; j < GRID_ROWS; j++) {
    for (let i = 0; i < GRID_COLS; i++) {
      const u = (i + 0.5) * VIDEO_W / GRID_COLS;
      const v = (j + 0.5) * VIDEO_H / GRID_ROWS;
      const x = (u - VIDEO_W / 2) / FOCAL;
      const y = (VIDEO_H / 2 - v) / FOCAL;
      const r = Math.hypot(x, y);
      grid.push({
        i,
        j,
        u,
        v,
        x,
        y,
        ring: r > 0.62 ? 'periphery' : r < 0.4 ? 'center' : 'middle',
      });
    }
  }
  return grid;
}

export async function analyzeVrd(parsed, {
  canvas,
  weights,
  onProgress = () => {},
  onFrameStats = null,
  signal,
} = {}) {
  const { meta, frames, video, description } = parsed;
  if (typeof VideoDecoder === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs VideoDecoder');
  }
  const grid = buildGrid();
  // GPU 浮点 FBO 可用时走 WebGL2，否则回退 CPU LK（输出契约一致）
  const useGL = glFlowSupported();
  const flowEngine = useGL ? createFlowGL(canvas) : createFlowCPU();
  const analyzer = createAnalyzer({
    grid,
    events: meta.events || [],
    weights,
  });

  // annexb 流无需 description；若 VRD 带了 avcC（其他编码器产出）则照常传入
  const decoderConfig = {
    codec: meta.codec,
    codedWidth: meta.width,
    codedHeight: meta.height,
    optimizeLatency: false,
  };
  if (meta.codec.startsWith('avc') && description) {
    decoderConfig.description = description;
    decoderConfig.avc = { format: 'avc' };
  } else if (meta.codec.startsWith('avc')) {
    decoderConfig.avc = { format: 'annexb' };
  }
  if (description && !meta.codec.startsWith('avc')) decoderConfig.description = description;
  const support = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!support.supported) throw new Error(`解码器不支持配置: ${meta.codec}`);

  // 解码出的 VideoFrame 按时间戳排队，GL 按帧号顺序消费
  const decoded = new Map();
  let nextDecodeIndex = 0;
  let decodeDone = false;

  const decoder = new VideoDecoder({
    output: (frame) => {
      const idx = Math.round(frame.timestamp / (1_000_000 / FPS));
      decoded.set(idx, frame);
    },
    error: (e) => { throw e; },
  });
  decoder.configure(decoderConfig);

  // 喂入编码块：从第一个关键帧开始（解码器 configure 后必须先收到 key frame）
  const firstKey = video.findIndex((c) => c.isKey);
  const startChunk = firstKey >= 0 ? firstKey : 0;
  for (let ci = startChunk; ci < video.length; ci++) {
    const chunk = video[ci];
    if (signal?.aborted) {
      decoder.close();
      throw new DOMException('已取消', 'AbortError');
    }
    decoder.decode(new EncodedVideoChunk({
      type: chunk.isKey ? 'key' : 'delta',
      timestamp: chunk.timestamp,
      data: chunk.data,
    }));
    if (decoder.decodeQueueSize > 48) {
      while (decoder.decodeQueueSize > 16) await sleep(2);
    }
  }
  decodeDone = true;
  decoder.flush().catch(() => {});

  // 按帧号消费：GL 光流 → 头动光流 → 分析器
  const total = frames.length;
  let consumed = 0;
  const t0 = performance.now();

  while (consumed < total) {
    if (signal?.aborted) {
      decoder.close();
      throw new DOMException('已取消', 'AbortError');
    }
    const frame = decoded.get(consumed);
    if (!frame) {
      if (decoder.state === 'closed' && decodeDone) break;
      await sleep(2);
      continue;
    }
    decoded.delete(consumed);

    const pose = frames[consumed];
    const { fx, fy } = flowEngine.process(frame);
    const { hx, hy } = headFlow(grid, pose.headYawRate, pose.headPitchRate);
    analyzer.pushFrame(
      {
        i: pose.i,
        t: pose.t,
        headYawRate: pose.headYawRate,
        headPitchRate: pose.headPitchRate,
        worldV: pose.worldV,
        tunnel: pose.tunnel,
      },
      { fx, fy, hx, hy },
    );
    frame.close();
    consumed++;

    if (onFrameStats && consumed % FPS === 0) {
      onFrameStats({ consumed, total, fx, fy });
    }
    if (consumed % (FPS * 2) === 0) {
      onProgress(consumed / total);
      await sleep(0);
    }
  }
  decoder.close();

  const elapsedMs = performance.now() - t0;
  const result = analyzer.finalize();
  result.timing = {
    elapsedMs,
    frames: total,
    fps: total / (elapsedMs / 1000),
    realtimeRatio: total / FPS / (elapsedMs / 1000),
    backend: flowEngine.backend === 'cpu-phasecorr' ? 'cpu-phasecorr' : 'webgl2-lk',
  };
  onProgress(1);
  return result;
}
