// 分析主流程:解码 → 光流 → 与头显位姿对比 → 风险分 → 区段 → 建议
import { decodeVRS } from './vrs.js';
import { decodeFrames } from './decoder.js';
import { OpticalFlow } from './optflow.js';
import { angularRates, clamp } from './util.js';
import { riskFromComponents, contributions, gradeOf, RISK_THRESHOLD } from './riskmodel.js';

export const SUGGESTIONS = {
  rot: {
    title: '虚拟旋转过强(画面转头没转)',
    tips: ['改用快速转身 (snap turn, 30°/步) 替代平滑旋转', '将虚拟旋转速度限制在 60°/s 以下', '避免过场动画强制转动镜头'],
  },
  roll: {
    title: '镜头滚转 (roll)',
    tips: ['消除相机滚转,保持地平线水平', '滚转是最强的晕动诱因,即使低速也应避免'],
  },
  periph: {
    title: '外周视野运动过强',
    tips: ['移动时启用隧道视野遮罩 (vignette),收缩外周视野 20–40%', '降低移动速度或改用瞬移', '添加中央固定参考物(虚拟鼻尖 / 座舱框)'],
  },
  loom: {
    title: '迎面扩张运动 / 加速度过大',
    tips: ['降低加速度和冲击式运动', '避免物体高速冲向玩家', '加减速改为缓入缓出曲线'],
  },
  vert: {
    title: '垂直方向晃动',
    tips: ['减少头部摆动 (head bob) 与相机震动', '添加稳定的地平线参考'],
  },
};

export async function analyzeVRS(arrayBuffer, opts = {}, cb = {}) {
  const onProgress = cb.onProgress || (() => {});
  const t0 = performance.now();
  const vrs = decodeVRS(arrayBuffer);
  const { meta, head } = vrs;
  const fps = meta.fps;
  const skip = opts.skip || 2;

  const flow = new OpticalFlow();
  flow.setFov(meta.fovX || 100, meta.width / meta.height);

  const stats = [];
  flow.onBatch = (arr, start, count) => {
    for (let i = 0; i < count; i++) stats[start + i] = arr.subarray(i * 16, i * 16 + 16);
  };
  onProgress(0, '解码 + 光流分析中');
  const decoded = await decodeFrames(vrs, {
    skip,
    onFrame: (vf) => flow.pushFrame(vf),
    onProgress: (p) => onProgress(p * 0.9, '解码 + 光流分析中'),
  });
  flow.flush();
  const tDecode = performance.now();

  const result = computeRisk(stats, head, meta, skip);
  const wallMs = performance.now() - t0;
  result.timing = {
    wallMs: Math.round(wallMs),
    decodeMs: Math.round(tDecode - t0),
    framesDecoded: decoded,
    framesAnalyzed: stats.length,
    videoSec: meta.duration,
    speedup: +(meta.duration / (wallMs / 1000)).toFixed(1),
  };
  return result;
}

// 光流测量值的标定系数(对合成场景标定,使测量值与物理真值同尺度)
const CAL = { periph: 2.5, loom: 1.0, vert: 1.5, rot: 1.0 };

// 由光流统计量 + 头显位姿计算风险(分析管线与离线测试共用)
export function computeRisk(stats, head, meta, skip) {
  const fps = meta.fps;
  const fpsA = fps / skip; // 分析帧率

  // 头显角速度(物理头部运动)
  const nPose = head.length / 7;
  const headYaw = new Float32Array(nPose), headPitch = new Float32Array(nPose), headRoll = new Float32Array(nPose);
  for (let i = 0; i < nPose; i++) {
    headYaw[i] = head[i * 7 + 4]; headPitch[i] = head[i * 7 + 5]; headRoll[i] = head[i * 7 + 6];
  }
  const dtPose = 1 / meta.poseFps;
  const headYawR = angularRates(headYaw, dtPose);
  const headPitchR = angularRates(headPitch, dtPose);
  const headRollR = angularRates(headRoll, dtPose);

  // 逐分析帧计算风险分量
  const nFrames = stats.length;
  const fovX = (meta.fovX || 100) * Math.PI / 180;
  const fovY = 2 * Math.atan(Math.tan(fovX / 2) / (meta.width / meta.height));
  const rollCorr = 2 / (fovX / 2 + fovY / 2); // 滚转估计的几何修正
  const riskInst = new Float32Array(nFrames);
  const compInst = []; // 每帧 {rot, periph, loom, vert}
  let ema = 0;
  for (let i = 0; i < nFrames; i++) {
    const s = stats[i];
    if (!s) { riskInst[i] = ema; compInst.push({ rot: 0, periph: 0, loom: 0, vert: 0 }); continue; }
    const periphSp = s[6] / Math.max(1e-6, s[7]);
    const loom = s[5];
    const centerW = Math.max(1e-6, s[9]);
    const centerU = s[10] / centerW, centerV = s[11] / centerW; // 中心区全局流(抗近景干扰)
    const rollN = s[12] / centerW, rollR2 = Math.max(1e-6, s[13] / centerW);
    // 对应的头显位姿帧
    const poseIdx = clamp(Math.round(i * skip * fps / meta.poseFps), 0, nPose - 2);
    const yawObs = centerU * fpsA, pitchObs = centerV * fpsA;
    const rollObs = (rollN / rollR2) * rollCorr * fpsA;
    const periph = periphSp * fpsA * CAL.periph;
    const loomR = loom * fpsA * CAL.loom;
    const vertObs = pitchObs;
    const c = {
      rot: Math.hypot(yawObs - headYawR[poseIdx], pitchObs - headPitchR[poseIdx]) + 2 * Math.abs(rollObs - headRollR[poseIdx]),
      periph,
      loom: Math.abs(loomR),
      vert: Math.abs(vertObs - headPitchR[poseIdx]) * CAL.vert,
    };
    compInst.push(c);
    const r = riskFromComponents(c);
    ema = i === 0 ? r : ema * 0.7 + r * 0.3;
    riskInst[i] = ema;
  }

  // 每秒聚合
  const nSec = meta.trueRisk ? meta.trueRisk.length : Math.ceil(meta.duration);
  const perSecond = new Float32Array(nSec);
  const compSec = Array.from({ length: nSec }, () => ({ rot: 0, periph: 0, loom: 0, vert: 0, n: 0 }));
  const counts = new Float32Array(nSec);
  for (let i = 0; i < nFrames; i++) {
    const sec = Math.min(nSec - 1, Math.floor((i * skip) / fps));
    perSecond[sec] += riskInst[i];
    counts[sec]++;
    const c = compInst[i], cs = compSec[sec];
    cs.rot += c.rot; cs.periph += c.periph; cs.loom += c.loom; cs.vert += c.vert; cs.n++;
  }
  for (let i = 0; i < nSec; i++) {
    perSecond[i] /= Math.max(1, counts[i]);
    const cs = compSec[i];
    if (cs.n) { cs.rot /= cs.n; cs.periph /= cs.n; cs.loom /= cs.n; cs.vert /= cs.n; }
  }

  // 区段提取:风险 > 阈值,最短 1s,间隔 < 1.5s 合并
  const segments = [];
  let cur = null;
  for (let i = 0; i < nSec; i++) {
    if (perSecond[i] > RISK_THRESHOLD) {
      if (!cur) cur = { t0: i, t1: i + 1, peak: perSecond[i] };
      else { cur.t1 = i + 1; cur.peak = Math.max(cur.peak, perSecond[i]); }
    } else if (cur) { segments.push(cur); cur = null; }
  }
  if (cur) segments.push(cur);
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && s.t0 - last.t1 <= 1.5) { last.t1 = s.t1; last.peak = Math.max(last.peak, s.peak); }
    else merged.push({ ...s });
  }
  for (const s of merged) {
    let sum = 0, acc = { rot: 0, periph: 0, loom: 0, vert: 0 };
    for (let i = s.t0; i < Math.min(nSec, s.t1); i++) {
      sum += perSecond[i];
      acc.rot += compSec[i].rot; acc.periph += compSec[i].periph;
      acc.loom += compSec[i].loom; acc.vert += compSec[i].vert;
    }
    const m = Math.max(1, s.t1 - s.t0);
    s.mean = sum / m;
    s.severity = s.mean >= 60 ? '高' : s.mean >= 45 ? '中' : '低';
    const meanComp = { rot: acc.rot / m, periph: acc.periph / m, loom: acc.loom / m, vert: acc.vert / m };
    const contrib = contributions(meanComp);
    s.dominant = Object.keys(contrib).reduce((a, b) => (contrib[a] >= contrib[b] ? a : b));
    s.contrib = contrib;
    s.suggestion = SUGGESTIONS[s.dominant];
    // 关联事件
    s.events = (meta.events || []).filter(e => e.t0 < s.t1 && e.t1 > s.t0).map(e => e.type);
  }

  // 汇总
  let mean = 0;
  for (let i = 0; i < nSec; i++) mean += perSecond[i];
  mean /= Math.max(1, nSec);
  const sorted = Array.from(perSecond).sort((a, b) => a - b);
  const p95 = sorted[Math.min(nSec - 1, Math.floor(nSec * 0.95))] || 0;

  return {
    meta,
    perSecond: Array.from(perSecond, v => +v.toFixed(2)),
    compSec: compSec.map(c => ({ rot: +c.rot.toFixed(3), periph: +c.periph.toFixed(3), loom: +c.loom.toFixed(3), vert: +c.vert.toFixed(3) })),
    segments: merged,
    overall: +mean.toFixed(1),
    p95: +p95.toFixed(1),
    grade: gradeOf(mean),
    framesAnalyzed: nFrames,
  };
}
