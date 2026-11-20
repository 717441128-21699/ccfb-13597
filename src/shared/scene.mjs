// 场景运动学模型（浏览器 / Node 共用，无 DOM 依赖）
//
// 职责：
//  1. 生成脚本化的 VR 移动事件时间轴（匀速移动、加减速、平滑转、瞬切转、侧移、上下起伏）
//  2. 生成自然的头部姿态（慢速探索 + 扫视 + 8Hz 微抖动），输出四元数姿态流
//  3. 由虚拟相机状态 + 走廊几何，逐像素格点求【解析光流】，作为地面真值
//  4. 暴露每帧的物理量（角速度、线加速度、隧道遮罩强度），供潜在风险建模
//
// 坐标系：x 右、y 上、z 前进（走廊沿 +z 延伸），角度均为弧度。

import { makeRng, gaussian, makeNoise1D } from './rng.mjs';
import { clamp, lerp, wrapAngle, eulerToQuat, TAU } from './math.mjs';

export const FPS = 90;
export const VIDEO_W = 256;
export const VIDEO_H = 144;
export const FOV_H = 90 * Math.PI / 180; // 水平视场角
export const FOCAL = (VIDEO_W / 2) / Math.tan(FOV_H / 2); // 像素焦距 = 128
export const GRID_COLS = 16;
export const GRID_ROWS = 9;

const CORRIDOR = { a: 2, h: 3, length: 45, repeat: true }; // 半宽 2m、高 3m；45m 重复段，端墙视觉接续
const LAG_TAU = 0.3; // 移动一阶惯性时间常数（模拟加减速手感）

// ---------------------------------------------------------------------------
// 事件时间轴
// ---------------------------------------------------------------------------
export function buildEvents(rng, duration, profile) {
  const k = profile.aggressiveness;
  const events = [];
  let t = rng() * 1.5;
  const sign = () => (rng() < 0.5 ? -1 : 1);

  while (t < duration - 2) {
    // 事件之间的静止/慢看间隔
    t += 1 + rng() * 3;
    if (t >= duration - 2) break;
    const roll = rng();
    let ev;
    if (roll < 0.34) {
      // 前进/后退匀速段，两端带加减速
      const d = 4 + rng() * 9;
      ev = {
        type: 'forward',
        t0: t,
        t1: Math.min(duration, t + d),
        speed: k * (1.2 + rng() * 3.4) * (rng() < 0.08 ? -0.6 : 1),
        ramp: 0.5 + rng() * 1.6,
      };
    } else if (roll < 0.55) {
      // 平滑持续旋转
      const d = 2 + rng() * 4.5;
      ev = {
        type: 'smoothTurn',
        t0: t,
        t1: Math.min(duration, t + d),
        yawRate: sign() * k * (12 + rng() * 48) * Math.PI / 180,
      };
    } else if (roll < 0.68) {
      // 瞬切转：0.12s 内完成 30~75°，产生 250~625 °/s 尖峰
      const deg = clamp(k * (30 + rng() * 45), 25, 90);
      ev = {
        type: 'snapTurn',
        t0: t,
        t1: Math.min(duration, t + 0.12),
        deltaYaw: sign() * deg * Math.PI / 180,
      };
    } else if (roll < 0.82) {
      // 侧向平移
      const d = 2 + rng() * 3.5;
      ev = {
        type: 'strafe',
        t0: t,
        t1: Math.min(duration, t + d),
        speed: sign() * k * (0.7 + rng() * 1.6),
      };
    } else {
      // 上下起伏（台阶/颠簸/漂浮）
      const d = 3 + rng() * 5;
      ev = {
        type: 'bob',
        t0: t,
        t1: Math.min(duration, t + d),
        amp: k * (0.05 + rng() * 0.12),
        freq: 0.7 + rng() * 0.9,
      };
    }
    // 部分高动态事件叠加隧道视野遮罩
    const dynamic = ev.type !== 'forward' || Math.abs(ev.speed) > 2.5;
    ev.tunnel = dynamic && rng() < profile.tunnelFraction ? 0.65 + rng() * 0.25 : 0;
    events.push(ev);
    t = ev.t1;
  }
  return events;
}

function eventTargets(events, t) {
  let vF = 0;
  let vS = 0;
  let vUp = 0;
  let yawRate = 0;
  let tunnel = 0;
  let snap = null;
  for (const e of events) {
    if (t < e.t0 || t >= e.t1) continue;
    tunnel = Math.max(tunnel, e.tunnel);
    if (e.type === 'forward') {
      const s = rampEnvelope(t, e.t0, e.t1, e.ramp);
      vF += e.speed * s;
    } else if (e.type === 'smoothTurn') {
      const s = rampEnvelope(t, e.t0, e.t1, 0.4);
      yawRate += e.yawRate * s;
    } else if (e.type === 'snapTurn') {
      // 硬斜坡：0.12s 内匀速扫过 deltaYaw
      const s = clamp((t - e.t0) / (e.t1 - e.t0), 0, 1);
      snap = { rate: e.deltaYaw / (e.t1 - e.t0), progress: s, ev: e };
      yawRate += e.deltaYaw / (e.t1 - e.t0);
    } else if (e.type === 'strafe') {
      const s = rampEnvelope(t, e.t0, e.t1, 0.5);
      vS += e.speed * s;
    } else if (e.type === 'bob') {
      const local = t - e.t0;
      const env = rampEnvelope(t, e.t0, e.t1, 0.8);
      vUp += e.amp * e.freq * TAU * Math.cos(e.freq * TAU * local) * env;
    }
  }
  return { vF, vS, vUp, yawRate, tunnel, snap };
}

// 两端线性斜坡包络，中段为 1
function rampEnvelope(t, t0, t1, ramp) {
  const up = clamp((t - t0) / ramp, 0, 1);
  const down = clamp((t1 - t) / ramp, 0, 1);
  return Math.min(up, down);
}

// ---------------------------------------------------------------------------
// 场景模型：逐帧状态 + 解析光流
// ---------------------------------------------------------------------------
export function createSceneModel(opts = {}) {
  const duration = opts.duration ?? 120;
  const seed = opts.seed ?? 1;
  const rng = makeRng(seed);
  const profile = opts.profile ?? {
    aggressiveness: 0.6 + rng() * 0.9,
    tunnelFraction: 0.25 + rng() * 0.4,
  };
  const events = opts.events ?? buildEvents(rng, duration, profile);

  // 头部运动：平滑噪声 + 计划扫视 + 微抖动
  const noiseYaw = makeNoise1D(rng);
  const noisePitch = makeNoise1D(rng, { baseHz: 0.4 });
  const saccades = [];
  const saccadeCount = 4 + Math.floor(rng() * 6);
  for (let i = 0; i < saccadeCount; i++) {
    saccades.push({
      tau: 2 + rng() * (duration - 4),
      amp: (rng() < 0.5 ? -1 : 1) * (12 + rng() * 26) * Math.PI / 180,
      width: 0.09 + rng() * 0.12,
    });
  }
  const jitterPhase = rng() * TAU;

  function headAngles(t) {
    let yaw = 0.3 * noiseYaw(t); // 振幅约 ±17°
    let pitch = 0.18 * noisePitch(t) - 0.04;
    for (const s of saccades) {
      // tanh 平滑阶跃：快速扫过去，1.2s 后部分回正
      const jump = 0.5 * (1 + Math.tanh((t - s.tau) / s.width));
      const settle = 0.6 + 0.4 * Math.exp(-Math.max(0, t - s.tau - 0.3) / 0.9);
      yaw += s.amp * jump * settle;
    }
    // 玩家对载具旋转会有小幅反向头部补偿（真实测量中常见）
    yaw += 0.1 * Math.sin(t * 0.5 + 1.3);
    // 8Hz 微抖动（IMU 噪声量级 ~0.06°）
    yaw += 0.001 * Math.sin(TAU * 8 * t + jitterPhase);
    pitch += 0.0008 * Math.sin(TAU * 8.3 * t + jitterPhase * 2);
    return {
      yaw: clamp(yaw, -1.05, 1.05),
      pitch: clamp(pitch, -0.6, 0.6),
    };
  }

  // 惯性滤波后的载具状态积分
  const nFrames = Math.round(duration * FPS);
  const dt = 1 / FPS;
  const frames = [];
  let px = 0;
  let py = 1.6; // 眼高 1.6m
  let pz = 2;
  let locoYaw = 0;
  let locoPitch = 0;
  let aF = 0;
  let aS = 0;
  let aUp = 0;
  let aW = 0; // 实际载具偏航角速度
  let prevCam = null;
  let prevHead = headAngles(0);

  for (let i = 0; i < nFrames; i++) {
    const t = i * dt;
    const tg = eventTargets(events, t);
    // 一阶滞后滤波 → 自然加减速
    const alpha = 1 - Math.exp(-dt / LAG_TAU);
    aF += (tg.vF - aF) * alpha;
    aS += (tg.vS - aS) * alpha;
    aUp += (tg.vUp - aUp) * alpha;
    if (tg.snap) {
      aW = tg.snap.rate; // 瞬切不滤波
    } else {
      aW += (tg.yawRate - aW) * alpha;
    }
    locoYaw = wrapAngle(locoYaw + aW * dt);
    locoPitch = clamp(aUp * 0.25 + (tg.snap ? 0 : 0), -0.2, 0.2);
    px = clamp(px + (Math.sin(locoYaw) * aF + Math.cos(locoYaw) * aS) * dt, -CORRIDOR.a + 0.3, CORRIDOR.a - 0.3);
    pz += (Math.cos(locoYaw) * aF - Math.sin(locoYaw) * aS) * dt;
    py = clamp(py + aUp * dt, 0.6, 2.6);

    const head = headAngles(t);
    const headYawRate = wrapAngle(head.yaw - prevHead.yaw) / dt;
    const headPitchRate = (head.pitch - prevHead.pitch) / dt;
    prevHead = head;

    const camYaw = wrapAngle(locoYaw + head.yaw);
    const camPitch = clamp(locoPitch + head.pitch, -1.2, 1.2);
    let camYawRate = aW + headYawRate;
    let camPitchRate = headPitchRate;
    if (prevCam) {
      // 用实际相机角微分兜底，保证与姿态流严格一致
      camYawRate = wrapAngle(camYaw - prevCam.yaw) / dt;
      camPitchRate = (camPitch - prevCam.pitch) / dt;
    }
    prevCam = { yaw: camYaw, pitch: camPitch };

    // 隧道遮罩强度也做斜坡
    const tv = tg.tunnel;

    // 载具世界速度（头旋不贡献平移），数组形式 [vx,vy,vz]
    const worldV = [
      Math.sin(locoYaw) * aF + Math.cos(locoYaw) * aS,
      aUp,
      Math.cos(locoYaw) * aF - Math.sin(locoYaw) * aS,
    ];

    frames.push({
      i,
      t,
      pos: [px, py, pz],
      locoYaw,
      locoPitch,
      headYaw: head.yaw,
      headPitch: head.pitch,
      headYawRate,
      headPitchRate,
      camYaw,
      camPitch,
      camYawRate,
      camPitchRate,
      quat: eulerToQuat(camYaw, camPitch),
      worldV,
      locoForward: aF,
      locoStrafe: aS,
      locoYawRate: aW,
      tunnel: tv,
      isSnap: !!tg.snap,
    });
  }

  // 相机基向量
  function basis(yaw, pitch) {
    const cp = Math.cos(pitch);
    const F = [cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw)];
    const R = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const U = [-Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.cos(yaw)];
    return { F, R, U };
  }

  // 光线与走廊盒体求交，返回相机坐标系下的 (X,Y,Z)。
  // repeat=true 时 z 方向按 45m 折叠（端墙贴图无缝接续，几何上等价于无限走廊），
  // 保证 Vz/Z 散度量级不随关卡推进而消失。
  function intersectCorridor(state, dir) {
    const [cx, cy, cz] = state.pos;
    const czMod = CORRIDOR.repeat ? cz % CORRIDOR.length : cz;
    const candidates = [];
    const push = (tt) => {
      if (Number.isFinite(tt) && tt > 0.05) candidates.push(tt);
    };
    if (Math.abs(dir.x) > 1e-9) {
      push((CORRIDOR.a - cx) / dir.x);
      push((-CORRIDOR.a - cx) / dir.x);
    }
    if (Math.abs(dir.y) > 1e-9) {
      push((0 - cy) / dir.y);
      push((CORRIDOR.h - cy) / dir.y);
    }
    if (dir.z > 1e-9) push((CORRIDOR.length - czMod) / dir.z);
    if (dir.z < -1e-9) push(-czMod / dir.z);
    if (!candidates.length) return null;
    const tt = Math.min(...candidates);
    const q = [cx + dir[0] * tt, cy + dir[1] * tt, cz + dir[2] * tt];
    const { F, R, U } = basis(state.camYaw, state.camPitch);
    const rel = [q[0] - cx, q[1] - cy, q[2] - cz];
    return {
      X: rel[0] * R[0] + rel[1] * R[1] + rel[2] * R[2],
      Y: rel[0] * U[0] + rel[1] * U[1] + rel[2] * U[2],
      Z: rel[0] * F[0] + rel[1] * F[1] + rel[2] * F[2],
      world: q,
    };
  }

  // 预计算 16×9 格点的归一化坐标与周边/中心分区
  const grid = [];
  for (let j = 0; j < GRID_ROWS; j++) {
    for (let i = 0; i < GRID_COLS; i++) {
      const u = (i + 0.5) * VIDEO_W / GRID_COLS;
      const v = (j + 0.5) * VIDEO_H / GRID_ROWS;
      const x = (u - VIDEO_W / 2) / FOCAL;
      const y = (VIDEO_H / 2 - v) / FOCAL; // 画布 y 向下，转相机向上
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

  // 单帧解析光流：返回格点像素速度 fx/fy（px/s）与头动预期光流
  function flowAt(state) {
    const { F, R, U } = basis(state.camYaw, state.camPitch);
    const V = state.worldV;
    const Vc = [
      V[0] * R[0] + V[1] * R[1] + V[2] * R[2],
      V[0] * U[0] + V[1] * U[1] + V[2] * U[2],
      V[0] * F[0] + V[1] * F[1] + V[2] * F[2],
    ];
    const w = state.camYawRate;
    const q = state.camPitchRate;
    const fx = new Float32Array(grid.length);
    const fy = new Float32Array(grid.length);
    const hx = new Float32Array(grid.length);
    const hy = new Float32Array(grid.length);
    const depth = new Float32Array(grid.length);

    for (let c = 0; c < grid.length; c++) {
      const g = grid[c];
      // 像素视线方向（世界系）
      const dirCam = [g.x, g.y, 1];
      const dir = [
        dirCam[0] * R[0] + dirCam[1] * U[0] + dirCam[2] * F[0],
        dirCam[0] * R[1] + dirCam[1] * U[1] + dirCam[2] * F[1],
        dirCam[0] * R[2] + dirCam[1] * U[2] + dirCam[2] * F[2],
      ];
      const hit = intersectCorridor(state, dir);
      const Z = hit ? hit.Z : 8;
      depth[c] = Z;
      // 旋转分量（归一化坐标 /s）
      const rotX = -w * (1 + g.x * g.x) - q * g.x * g.y;
      const rotY = -w * g.x * g.y - q * (1 + g.y * g.y);
      // 平移分量
      const trX = (g.x * Vc[2] - Vc[0]) / Z;
      const trY = (g.y * Vc[2] - Vc[1]) / Z;
      fx[c] = FOCAL * (rotX + trX);
      fy[c] = FOCAL * (rotY + trY);
      // 仅头部转动应产生的光流（载具静止假设）——用于“画面动头没动”对照
      const hw = state.headYawRate;
      const hq = state.headPitchRate;
      hx[c] = FOCAL * (-hw * (1 + g.x * g.x) - hq * g.x * g.y);
      hy[c] = FOCAL * (-hw * g.x * g.y - hq * (1 + g.y * g.y));
    }
    return { fx, fy, hx, hy, depth };
  }

  return {
    meta: {
      seed,
      duration,
      fps: FPS,
      width: VIDEO_W,
      height: VIDEO_H,
      fovHDeg: 90,
      profile,
      corridor: CORRIDOR,
      eventCount: events.length,
      generatedAt: new Date().toISOString(),
    },
    profile,
    events,
    frames,
    grid,
    flowAt,
    headAngles,
    // 世界点 → 画布像素坐标（与 flowAt 同一套相机几何，渲染器共用）。
    // 返回 null 表示点在相机后方/视锥外。
    project(state, worldPoint) {
      const { F, R, U } = basis(state.camYaw, state.camPitch);
      const [cx, cy, cz] = state.pos;
      const rel = [worldPoint[0] - cx, worldPoint[1] - cy, worldPoint[2] - cz];
      const X = rel[0] * R[0] + rel[1] * R[1] + rel[2] * R[2];
      const Y = rel[0] * U[0] + rel[1] * U[1] + rel[2] * U[2];
      const Z = rel[0] * F[0] + rel[1] * F[1] + rel[2] * F[2];
      if (Z <= 0.05) return null;
      const u = VIDEO_W / 2 + FOCAL * X / Z;
      const v = VIDEO_H / 2 - FOCAL * Y / Z;
      if (u < -20 || u > VIDEO_W + 20 || v < -20 || v > VIDEO_H + 20) return null;
      return { u, v, depth: Z };
    },
  };
}

// 由格点光流最小二乘估计全局自运动（deg 前的弧度/秒），GL 与解析路径共用。
// 5 参数联合模型，避免平移光流污染旋转估计：
//   u̇ = -ω(1+x²) - qxy + (x·Vc_z − Vc_x)/Z
//   v̇ = -ωxy - q(1+y²) + (y·Vc_z − Vc_y)/Z
// 令 t_i = Vc_i/Z 的格点有效均值，设计矩阵 5 列 [ω, q, tx, ty, tz]。
export function estimateSelfMotion(grid, fx, fy) {
  // 法方程 A^T·A（5×5）与 A^T·b（5）
  const ATA = Array.from({ length: 5 }, () => new Float64Array(5));
  const ATb = new Float64Array(5);
  for (let c = 0; c < grid.length; c++) {
    const { x, y } = grid[c];
    // 深度提示：由格点视线角估计走廊墙面距离（正面视线远、周边近）
    const r = Math.hypot(grid[c].x, grid[c].y);
    const Z = 4.5 / (1 + 0.9 * r);
    const nfx = fx[c] / FOCAL;
    const nfy = fy[c] / FOCAL;
    // 两行设计矩阵：u 行与 v 行
    const rows = [
      [-(1 + x * x), -x * y, -1 / Z, 0, x / Z, nfx],
      [-x * y, -(1 + y * y), 0, -1 / Z, y / Z, nfy],
    ];
    for (const r of rows) {
      for (let i = 0; i < 5; i++) {
        ATb[i] += r[i] * r[5];
        for (let j = 0; j < 5; j++) ATA[i][j] += r[i] * r[j];
      }
    }
  }
  // 高斯消元（带小岭项防奇异）
  for (let i = 0; i < 5; i++) ATA[i][i] += 1e-6;
  const sol = gaussian5(ATA, ATb);
  return {
    yawRate: sol[0],
    pitchRate: sol[1],
    transl: { tx: sol[2], ty: sol[3], tz: sol[4] },
  };
}

// 5×5 高斯消元（带小岭项防奇异）
function gaussian5(A, b) {
  const M = Array.from({ length: 5 }, (_, i) => [...A[i], b[i]]);
  for (let col = 0; col < 5; col++) {
    let piv = col;
    for (let r = col + 1; r < 5; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < 5; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let k = col; k <= 5; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[5] / (row[i] || 1e-12));
}

// 把一帧格点光流汇总为分析器使用的 FlowFrame（GL 读回与解析真值同构）
export function summarizeFlow(grid, fx, fy, hx, hy) {
  let sumMag = 0;
  let sumCenter = 0;
  let sumPeriph = 0;
  let nCenter = 0;
  let nPeriph = 0;
  let sumMis = 0;
  let div = 0;
  let divW = 0;
  let cohX = 0;
  let cohY = 0;
  let cohW = 0;
  const mags = new Float32Array(grid.length);

  for (let c = 0; c < grid.length; c++) {
    const g = grid[c];
    const mag = Math.hypot(fx[c], fy[c]);
    mags[c] = mag;
    sumMag += mag;
    const dx = fx[c] - hx[c];
    const dy = fy[c] - hy[c];
    sumMis += dx * dx + dy * dy;
    if (g.ring === 'center') {
      sumCenter += mag;
      nCenter++;
    } else if (g.ring === 'periphery') {
      sumPeriph += mag;
      nPeriph++;
    }
    // 径向散度：前进/后退产生的扩张/收缩。
    // 平移光流 f_px=FOCAL·(x·Vz−Vz_ax)/Z，其径向投影
    // (f·r̂)/FOCAL 在 r 方向 ≈ Vz·r/(Z·(1+r²))，故按 (1+r²) 加权还原 Vz/Z（/s）。
    const r2 = g.x * g.x + g.y * g.y;
    const wgt = 1 / (1 + r2);
    div += wgt * (fx[c] * g.x + fy[c] * g.y) / (FOCAL * Math.sqrt(r2 || 1e-6));
    divW += wgt;
    if (mag > 1) {
      cohX += fx[c] / mag;
      cohY += fy[c] / mag;
      cohW++;
    }
  }
  const coherence = cohW ? Math.hypot(cohX, cohY) / cohW : 0;
  const meanMag = sumMag / grid.length;
  return {
    mags,
    meanMagPx: meanMag,
    centerPx: nCenter ? sumCenter / nCenter : 0,
    peripheryPx: nPeriph ? sumPeriph / nPeriph : 0,
    peripheryRatio: nPeriph && meanMag > 1 ? sumPeriph / nPeriph / (meanMag || 1e-9) : 1,
    mismatchPx: Math.sqrt(sumMis / grid.length),
    divergence: div / (divW || 1),
    coherence,
  };
}

export { lerp };
