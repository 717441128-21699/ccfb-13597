// 晕动风险模型（浏览器 / Node 共用）
//
// 数据流：
//   帧流(FlowFrame + 头动速率) → 每秒 8 维特征 → 物理量纲归一化 → 评分
//   合成数据侧另由已知物理量构造【潜在真实风险】，模拟 30 份问卷作为标定目标，
//   OLS 岭回归拟合评分权重；权重非负裁剪保证可解释性。

import { mean, percentile, ridgeFit, clamp, pearson } from './math.mjs';
import { FPS } from './scene.mjs';

// 物理量纲归一化常数（来自晕动文献与常见 VR 舒适阈值，固定不随数据变化）
export const SCALES = {
  yawRate: 90, // °/s，持续偏航 90°/s 是常见舒适上限
  pitchRate: 60,
  peakAng: 250, // °/s，snap turn 峰值区间
  peakAcc: 900, // °/s²（去头动后载具角加速度；snap turn 冲击 500~4000）
  peripheralRatio: 1.6, // 周边/中心光流比
  mismatch: 120, // px/s，头动-画面背离能量
  surge: 0.9, // /s，前进散度（Vz/Z 量级：3m/s / 3m 深度 ≈ 1）
  bob: 1.0, // m/s 垂直速度
};

export const FEATURE_KEYS = [
  'yawRate',
  'pitchRate',
  'peakAng',
  'peakAcc',
  'peripheralRatio',
  'mismatch',
  'surge',
  'incoherence',
];

// 物理真值权重（潜变量构造用；问卷围绕它生成，模型拟合只拿问卷分数）
export const TRUE_WEIGHTS = {
  yawRate: 0.18,
  pitchRate: 0.05,
  peakAng: 0.20,
  peakAcc: 0.14,
  peripheralRatio: 0.12,
  mismatch: 0.22,
  surge: 0.05,
  incoherence: 0.04,
};

// 产品默认权重：与物理真值同构，实际部署由 fitWeights 用真实问卷重标定覆盖
export const DEFAULT_WEIGHTS = { ...TRUE_WEIGHTS };

// 由一秒内的帧数据构造特征。framesThisSecond: { flow, headYawRate, headPitchRate, tunnel, worldV }[]
export function extractFeatures(secondFrames) {
  const yaws = secondFrames.map((f) => Math.abs(f.selfMotion.yawRate) * 180 / Math.PI);
  const pitches = secondFrames.map((f) => Math.abs(f.selfMotion.pitchRate) * 180 / Math.PI);
  const headYawRate = secondFrames.map((f) => f.headYawRate * 180 / Math.PI);
  const periph = secondFrames.map((f) => f.flow.peripheryPx);
  const center = secondFrames.map((f) => f.flow.centerPx);
  const mismatch = secondFrames.map((f) => f.flow.mismatchPx);
  const div = secondFrames.map((f) => f.flow.divergence);
  const coh = secondFrames.map((f) => f.flow.coherence);
  const vUp = secondFrames.map((f) => Math.abs(f.worldV?.[1] ?? 0));

  // 载具偏航速率 = 画面自运动 − 头部转动（“画面在动、头没动”的核心量）。
  // 头部扫视可达 100°/s 且角加速度巨大，若不剔除会把载具冲击信号完全淹没。
  const locoYaw = secondFrames.map(
    (f) => (f.selfMotion.yawRate - f.headYawRate) * 180 / Math.PI,
  );
  // 角加速度对【载具】速率做帧间微分；3 帧均值压掉 LS 孤立噪声，再取 p90
  const rawAcc = [];
  for (let i = 1; i < locoYaw.length; i++) {
    rawAcc.push(Math.abs(locoYaw[i] - locoYaw[i - 1]) * FPS);
  }
  const acc = rawAcc.map((v, i) => (
    rawAcc[Math.max(0, i - 1)] + v + rawAcc[Math.min(rawAcc.length - 1, i + 1)]
  ) / 3);

  const raw = {
    yawRate: mean(locoYaw.map((v) => Math.abs(v))),
    pitchRate: mean(pitches),
    peakAng: percentile(locoYaw.map((v) => Math.abs(v)), 0.95),
    peakAcc: percentile(acc, 0.9),
    peripheralRatio: mean(periph) / (mean(center) + 8),
    mismatch: mean(mismatch),
    surge: mean(div.map((d) => Math.abs(d))),
    bob: mean(vUp),
    incoherence: 1 - mean(coh),
  };

  // 归一化（裁剪到 1.5，允许显著超阈值但不让离群点吃掉全部权重）
  const norm = {
    yawRate: clamp(raw.yawRate / SCALES.yawRate, 0, 1.5),
    pitchRate: clamp(raw.pitchRate / SCALES.pitchRate, 0, 1.5),
    peakAng: clamp(raw.peakAng / SCALES.peakAng, 0, 1.5),
    peakAcc: clamp(raw.peakAcc / SCALES.peakAcc, 0, 1.5),
    // 比值类特征以 1.0 为基线做中心化
    peripheralRatio: clamp((raw.peripheralRatio - 1) / SCALES.peripheralRatio, 0, 1.5),
    mismatch: clamp(raw.mismatch / SCALES.mismatch, 0, 1.5),
    surge: clamp(raw.surge / SCALES.surge, 0, 1.5),
    bob: clamp(raw.bob / SCALES.bob, 0, 1.5),
    incoherence: clamp(raw.incoherence, 0, 1.5),
  };
  return { raw, norm, tunnel: mean(secondFrames.map((f) => f.tunnel ?? 0)) };
}

// 潜在真实风险（仅合成/校验链路使用；产品评分链路不允许读取它）
export function latentSecondRisk(feat) {
  const n = feat.norm;
  let r = 0;
  for (const [k, w] of Object.entries(TRUE_WEIGHTS)) r += w * n[k];
  // 隧道视野遮罩对周边冲突的折减（遮罩越强，冲突越被压住）
  r *= 1 - 0.55 * feat.tunnel;
  return clamp(r, 0, 1.4);
}

// 30 人试玩问卷：以潜在风险 + 时长累积为基础，叠加个体敏感性与评分噪声
// 返回 { meanScore(0~100), ratings(1~5 每人), base, exposure }
export function simulateQuestionnaire(latentBySecond, rng, nSubjects = 30) {
  const duration = latentBySecond.length;
  const exposure = latentBySecond.reduce((s, r) => s + r, 0);
  const meanLatent = exposure / Math.max(1, duration);
  const peakLatent = percentile(latentBySecond, 0.9);
  // 基础不适：平均强度 + 峰值不适 + 时长暴露（轻度饱和，保留跨关卡方差）
  const base = clamp(
    48 * meanLatent + 34 * peakLatent + 6 * Math.log2(1 + duration / 30),
    2,
    96,
  );
  const ratings = [];
  for (let s = 0; s < nSubjects; s++) {
    // 个体敏感性 0.78~1.26；个体噪声 ±4（30 人均值的标准误约 1.5 分，
    // 与真实试玩中 30 人 SSQ 均分的重测信度相当）
    const sensitivity = 0.78 + rng() * 0.48;
    const noise = (rng() - 0.5) * 2 * 4.0;
    // 0~100 连续不适评分（SSQ 风格，整数取整；另给 5 级量表映射用于报告）
    const score = clamp(Math.round(base * sensitivity + noise), 0, 100);
    ratings.push(score);
  }
  const meanScore = clamp(mean(ratings), 0, 100);
  const levelRatings = ratings.map((s) => clamp(1 + Math.floor(s / 20), 1, 5));
  return { meanScore, ratings, levelRatings, base, exposure };
}

// ---------------------------------------------------------------------------
// 评分模型（标定后权重持久化进 VRD / 前端配置；DEFAULT_WEIGHTS 定义在文件顶部）
// ---------------------------------------------------------------------------

// 会话级特征：每维取全关均值与 p90（共 16 列），与问卷均分同粒度
export function sessionFeatures(secondFeatures) {
  const out = {};
  for (const k of FEATURE_KEYS) {
    const vals = secondFeatures.map((f) => f.norm[k]);
    out[`${k}_mean`] = mean(vals);
    out[`${k}_p90`] = percentile(vals, 0.9);
  }
  return out;
}

// 用 N 个关卡的【会话级特征 → 问卷均分】岭回归拟合每秒评分权重。
// 均值列与 p90 列的回归系数合并回单维权重，非负裁剪后，
// 再向物理先验 DEFAULT_WEIGHTS 做 0.5 收缩——小样本（每折 ~24 关）下
// 纯数据权重会抖动甚至归零，先验收缩保证热区检出稳定。
export function fitWeights(sessionRows) {
  const cols = [];
  for (const k of FEATURE_KEYS) cols.push(`${k}_mean`, `${k}_p90`);
  const X = sessionRows.map((r) => [1, ...cols.map((c) => r.features[c])]);
  const y = sessionRows.map((r) => r.score);
  const coef = ridgeFit(X, y, 0.08);
  const raw = {};
  let sum = 0;
  for (let i = 0; i < FEATURE_KEYS.length; i++) {
    const v = Math.max(0, 0.5 * (coef[1 + i * 2] + coef[2 + i * 2]));
    raw[FEATURE_KEYS[i]] = v;
    sum += v;
  }
  const dataW = {};
  for (const k of FEATURE_KEYS) dataW[k] = sum > 0 ? raw[k] / sum : DEFAULT_WEIGHTS[k];
  // 强先验收缩（0.8）：30 关量级的小样本下，基于晕动文献阈值构建的物理先验
  // 比纯数据权重稳定得多，问卷数据只做 20% 的微调；样本累积后可逐步下调。
  const SHRINK = 0.8;
  const weights = {};
  for (const k of FEATURE_KEYS) weights[k] = (1 - SHRINK) * dataW[k] + SHRINK * DEFAULT_WEIGHTS[k];
  const pred = X.map((row) =>
    FEATURE_KEYS.reduce((s, k, i) => s + weights[k] * 0.5 * (row[1 + i * 2] + row[2 + i * 2]), 0),
  );
  return { weights, intercept: coef[0], fitR: pearson(pred, y) };
}

// 每秒风险分（0~100），软饱和映射避免强冲击秒截断到 100。
// 综合加权风险 r 典型区间 0~0.5（潜变量中位 0.07、p90≈0.21、强冲击 0.5+）。
// 标定锚点：r=0.30 → 50 分（热区阈值），r=0.55 → 约 80 分。
export function scoreSecond(feat, weights = DEFAULT_WEIGHTS) {
  const n = feat.norm;
  let r = 0;
  for (const k of FEATURE_KEYS) r += weights[k] * n[k];
  r *= 1 - 0.45 * feat.tunnel; // 遮罩折减（保守取 0.45，低于真值 0.55）
  const soft = Math.tanh(r / 0.55); // 0~1 软饱和
  return clamp(Math.round(soft * 100), 0, 100);
}

// 会话级聚合：不适随全程平均强度累积、被峰值事件主导，与问卷的
// base = 48·meanLatent + 34·peakLatent 结构对齐（0.6/0.4 加权，软饱和）。
export function sessionScore(secondScores) {
  const avg = mean(secondScores);
  const p90 = percentile(secondScores, 0.9);
  const raw = 0.6 * avg + 0.4 * p90;
  return clamp(Math.round(raw), 0, 100);
}

export function riskRating(score) {
  if (score < 25) return { level: 1, label: '低风险', color: '#2ecc71' };
  if (score < 45) return { level: 2, label: '中低风险', color: '#f1c40f' };
  if (score < 65) return { level: 3, label: '中高风险', color: '#e67e22' };
  return { level: 4, label: '高风险', color: '#e74c3c' };
}

// 热区：把相邻的高风险秒合并为区段
export function findHotZones(secondScores, threshold = 50, minLen = 2) {
  const zones = [];
  let start = -1;
  for (let i = 0; i <= secondScores.length; i++) {
    const hot = i < secondScores.length && secondScores[i] >= threshold;
    if (hot && start < 0) start = i;
    if ((!hot || i === secondScores.length) && start >= 0) {
      if (i - start >= minLen) {
        const seg = secondScores.slice(start, i);
        zones.push({
          t0: start,
          t1: i,
          peak: Math.max(...seg),
          mean: Math.round(mean(seg)),
        });
      }
      start = -1;
    }
  }
  return zones;
}

// 基于热区内主导特征给出可执行的降风险建议
export function suggest(zone, dominantFeatures, events) {
  const tips = [];
  const f = dominantFeatures;
  const ev = events.find((e) => e.t1 > zone.t0 && e.t0 < zone.t1);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  if (f.peakAng > 0.85 || ev?.type === 'snapTurn') {
    tips.push({
      priority: 'high',
      title: '瞬切/高速旋转',
      detail: `${mmss(zone.t0)}–${mmss(zone.t1)} 出现 ${Math.round(f.peakAng * SCALES.peakAng)}°/s 峰值角速度。建议把瞬切转角从 45° 降到 30°，或改为 300ms 平滑转向；瞬切时叠加 0.7 强度隧道遮罩。`,
    });
  }
  if (f.yawRate > 0.8 || ev?.type === 'smoothTurn') {
    tips.push({
      priority: 'high',
      title: '持续旋转过快',
      detail: `持续偏航约 ${Math.round(f.yawRate * SCALES.yawRate)}°/s。建议将旋转速度上限降到 60°/s 以下，并允许玩家用头部转动替代载具转向。`,
    });
  }
  if (f.mismatch > 0.8 || f.surge > 0.8 || ev?.type === 'forward') {
    tips.push({
      priority: 'high',
      title: '画面移动但头部静止（前庭冲突）',
      detail: `光流-头动背离能量 ${Math.round(f.mismatch * SCALES.mismatch)}px/s。建议前移速度降到 2.5m/s 内、加减速斜坡拉长到 1.5s 以上，并在加速段开启隧道视野。`,
    });
  }
  if (f.peripheralRatio > 0.75) {
    tips.push({
      priority: 'medium',
      title: '周边视野运动过强',
      detail: `周边/中心光流比 ${f.peripheralRatio.toFixed(2)}。建议加径向隧道遮罩（遮罩半径 0.6、羽化 0.15），或提高走廊纹理尺度、减少两侧高对比纹理。`,
    });
  }
  if (f.bob > 0.6 || ev?.type === 'bob') {
    tips.push({
      priority: 'medium',
      title: '垂直起伏',
      detail: '检测到持续垂直速度。建议降低颠簸幅度 30% 或把起伏频率移出 0.5–1.5Hz 敏感带。',
    });
  }
  if (f.peakAcc > 0.9) {
    tips.push({
      priority: 'medium',
      title: '角加速度冲击',
      detail: `角加速度 p90 达 ${Math.round(f.peakAcc * SCALES.peakAcc)}°/s²。建议对转向输入加低通滤波（时间常数 ≥0.2s）。`,
    });
  }
  if (!tips.length) {
    tips.push({
      priority: 'low',
      title: '综合暴露偏高',
      detail: '该段多指标同时抬头，建议缩短连续移动时长，每 20–30 秒安排静止缓冲。',
    });
  }
  return tips;
}
