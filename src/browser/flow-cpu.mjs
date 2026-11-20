// CPU 鲁棒光流（WebGL2 浮点 FBO 不可用时的回退实现）。
//
// 【定位与局限】这是无 GPU 环境（远程桌面/精简 VM 的 SwiftShader 桩、FBO 不可渲染）
// 的降级路径，不是主算法。主路径 flow-gl.mjs 的 WebGL2 金字塔 LK 精度由 Node 校验
// （解析光流对照，角速度误差 <1°/s）保证。相位相关只恢复主导全局运动，
// 无法分离旋转/平移、不输出逐格空间差异，因此周边放大、径向散度等特征在回退模式
// 下精度下降，评分仅反映整体运动强度。带 GPU 的真实浏览器始终走 WebGL2。
//
// 64×64 粗层 radix-2 FFT 相位相关求帧间全局亚像素位移（无局部极小值、对低纹理
// 鲁棒，O(N log N)）；隔帧估计（45Hz）+ 时序指数平滑控制 CPU 开销。
// 由全局位移按自运动投影模型合成 16×9 格点速度场，输出契约与 GL 版一致。
import { VIDEO_W, VIDEO_H, GRID_COLS, GRID_ROWS, FOCAL } from '../shared/scene.mjs';

const N = 64;
const STRIDE = 2; // 隔帧估计

// 复用的离屏 canvas / 图像缓冲，避免每帧分配
const off = typeof document !== 'undefined' ? document.createElement('canvas') : null;
if (off) { off.width = N; off.height = N; }
const offCtx = off?.getContext('2d', { willReadFrequently: true });
const imgData = offCtx?.createImageData(N, N);

function toCoarseGray(frame) {
  offCtx.drawImage(frame, 0, 0, N, N);
  const img = offCtx.getImageData(0, 0, N, N).data;
  const re = new Float32Array(N * N);
  const im = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (N - 1));
    for (let x = 0; x < N; x++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (N - 1));
      const o = (y * N + x) * 4;
      re[y * N + x] = (0.299 * img[o] + 0.587 * img[o + 1] + 0.114 * img[o + 2]) / 255 * wx * wy;
    }
  }
  return { re, im };
}

// 原地 radix-2 迭代 FFT
function fft(re, im, inverse) {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = curR * re[b] - curI * im[b];
        const ti = curR * im[b] + curI * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
      }
    }
  }
  if (inverse) {
    const nn = N * N;
    for (let i = 0; i < nn; i++) { re[i] /= nn; im[i] /= nn; }
  }
}

const rowR = new Float32Array(N);
const rowI = new Float32Array(N);
const colR = new Float32Array(N);
const colI = new Float32Array(N);
function fft2(re, im, inverse) {
  for (let y = 0; y < N; y++) {
    rowR.set(re.subarray(y * N, y * N + N));
    rowI.set(im.subarray(y * N, y * N + N));
    fft(rowR, rowI, inverse);
    re.set(rowR, y * N);
    im.set(rowI, y * N);
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { colR[y] = re[y * N + x]; colI[y] = im[y * N + x]; }
    fft(colR, colI, inverse);
    for (let y = 0; y < N; y++) { re[y * N + x] = colR[y]; im[y * N + x] = colI[y]; }
  }
}

// 相位相关：返回粗层像素位移（屏幕右/下为正）
function phaseCorrelation(prev, cur) {
  const R1 = prev.re.slice();
  const I1 = prev.im.slice();
  const R2 = cur.re.slice();
  const I2 = cur.im.slice();
  fft2(R1, I1, false);
  fft2(R2, I2, false);
  const cr = new Float32Array(N * N);
  const ci = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const rr = R2[i] * R1[i] - I2[i] * (-I1[i]);
    const ri = R2[i] * (-I1[i]) + I2[i] * R1[i];
    const mag = Math.hypot(rr, ri) + 1e-12;
    cr[i] = rr / mag;
    ci[i] = ri / mag;
  }
  fft2(cr, ci, true);
  let peak = -Infinity;
  let px = 0;
  let py = 0;
  const LIM = 16;
  for (let y = 0; y < N; y++) {
    const sy = y > N / 2 ? y - N : y;
    if (Math.abs(sy) > LIM) continue;
    for (let x = 0; x < N; x++) {
      const sx = x > N / 2 ? x - N : x;
      if (Math.abs(sx) > LIM) continue;
      if (cr[y * N + x] > peak) { peak = cr[y * N + x]; px = sx; py = sy; }
    }
  }
  // 邻域质心亚像素细化
  const cy = (py + N) % N;
  const cx = (px + N) % N;
  let numX = 0;
  let numY = 0;
  let den = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const w = Math.max(0, cr[((cy + dy + N) % N) * N + ((cx + dx + N) % N)]);
      numX += dx * w;
      numY += dy * w;
      den += w;
    }
  }
  if (den > 0) { px += numX / den; py += numY / den; }
  return { shiftX: px, shiftY: py };
}

export function createFlowCPU() {
  let prev = null;
  let smX = 0;
  let smY = 0;
  let frameIdx = 0;
  let lastFx = new Float32Array(GRID_COLS * GRID_ROWS);
  let lastFy = new Float32Array(GRID_COLS * GRID_ROWS);

  return {
    backend: 'cpu-phasecorr',
    process(frame) {
      // 隔帧：偶数帧做相位相关，奇数帧复用上一次速度
      if (frameIdx % STRIDE !== 0 && prev) {
        frameIdx++;
        return { fx: lastFx, fy: lastFy };
      }
      const cur = toCoarseGray(frame);
      const fx = new Float32Array(GRID_COLS * GRID_ROWS);
      const fy = new Float32Array(GRID_COLS * GRID_ROWS);
      if (prev) {
        const { shiftX, shiftY } = phaseCorrelation(prev, cur);
        // 粗层（64 对应原 256 宽）→ 原分辨率 → 像素/秒
        const scale = VIDEO_W / N;
        const velX = shiftX * scale * 90;
        const velY = shiftY * scale * 90;
        const alpha = 0.6;
        smX = frameIdx === 0 ? velX : alpha * velX + (1 - alpha) * smX;
        smY = frameIdx === 0 ? velY : alpha * velY + (1 - alpha) * smY;
        // 屏幕平移 → 相机系（与 scene.mjs 解析公式同构）：fx=-tx, fy=-ty
        const tx = -smX;
        const ty = smY;
        for (let row = 0; row < GRID_ROWS; row++) {
          for (let col = 0; col < GRID_COLS; col++) {
            const idx = row * GRID_COLS + col;
            fx[idx] = -tx;
            fy[idx] = -ty;
          }
        }
        lastFx = fx;
        lastFy = fy;
      }
      prev = cur;
      frameIdx++;
      this.lastParams = { shiftX: smX, shiftY: smY };
      return { fx, fy };
    },
  };
}
