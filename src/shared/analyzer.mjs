// 分析主链路（浏览器 / Node 共用）：
// 帧级输入 → estimateSelfMotion + summarizeFlow → 每秒特征 → 评分 → 热区 → 建议
//
// 浏览器侧由 GL 光流产出 fx/fy，Node 校验侧由解析模型产出同构的 fx/fy，
// 两条路径都汇聚到这里，保证“验证的代码就是上线的代码”。

import {
  FPS,
  GRID_COLS,
  GRID_ROWS,
  estimateSelfMotion,
  summarizeFlow,
} from './scene.mjs';
import {
  extractFeatures,
  scoreSecond,
  sessionScore,
  findHotZones,
  suggest,
  DEFAULT_WEIGHTS,
} from './risk.mjs';
import { mean, percentile } from './math.mjs';

// 喂入一帧：frame 含 { i, t, headYawRate, headPitchRate, worldV, tunnel, events? }
// flowInput: { fx, fy, hx, hy }（像素/秒）
export function createAnalyzer({ grid, events = [], weights = DEFAULT_WEIGHTS } = {}) {
  if (!grid) throw new Error('createAnalyzer 需要场景 grid');
  const raw = [];

  return {
    // 阶段一：逐帧收集 LS 自运动估计与光流统计（不做平滑）
    pushFrame(frame, flowInput) {
      const selfMotion = estimateSelfMotion(grid, flowInput.fx, flowInput.fy);
      const flow = summarizeFlow(grid, flowInput.fx, flowInput.fy, flowInput.hx, flowInput.hy);
      raw.push({
        i: frame.i,
        t: frame.t,
        selfMotion,
        flow,
        headYawRate: frame.headYawRate,
        headPitchRate: frame.headPitchRate,
        worldV: frame.worldV,
        tunnel: frame.tunnel ?? 0,
      });
    },

    // 阶段二：全序列中心平滑 → 每秒特征 → 评分/热区/建议
    finalize() {
      const smoothed = smoothRates(raw.map((f) => f.selfMotion));
      const perFrame = raw.map((f, i) => ({ ...f, selfMotion: smoothed[i] }));
      const seconds = [];
      const perSecond = Math.floor(perFrame.length / FPS);
      for (let s = 0; s < perSecond; s++) {
        const slice = perFrame.slice(s * FPS, (s + 1) * FPS);
        const feat = extractFeatures(slice);
        const score = scoreSecond(feat, weights);
        seconds.push({
          second: s,
          score,
          features: feat.norm,
          raw: feat.raw,
          tunnel: feat.tunnel,
          yawRateDeg: mean(slice.map((f) => Math.abs(f.selfMotion.yawRate) * 180 / Math.PI)),
          mismatchPx: mean(slice.map((f) => f.flow.mismatchPx)),
          peripheryPx: mean(slice.map((f) => f.flow.peripheryPx)),
        });
      }

      const scores = seconds.map((s) => s.score);
      const overall = sessionScore(scores);
      const hotZones = findHotZones(scores);
      const zonesWithTips = hotZones.map((z) => {
        const seg = seconds.slice(z.t0, z.t1);
        const dominant = averageFeatures(seg);
        return { ...z, tips: suggest(z, dominant, events) };
      });

      return {
        perSecond: seconds,
        scores,
        overall,
        hotZones: zonesWithTips,
        stats: {
          meanScore: Math.round(mean(scores)),
          p95Score: percentile(scores, 0.95),
          highRiskSeconds: scores.filter((s) => s >= 55).length,
          gridCols: GRID_COLS,
          gridRows: GRID_ROWS,
        },
      };
    },
  };
}

function averageFeatures(seg) {
  const keys = Object.keys(seg[0].features);
  const out = {};
  for (const k of keys) out[k] = mean(seg.map((s) => s.features[k]));
  return out;
}

// 角速度不平滑：LS 估计在静止时误差 <0.1°/s、平移耦合误差 ~2.7°/s，
// 中心平滑反而会把头部扫视/snap turn 尖峰与邻帧平均，引入 10°/s 级系统偏差。
// 角加速度的帧间噪声由 extractFeatures 里的 p99 分位数统计处理。
export function smoothRates(estimates) {
  return estimates.map((e) => ({ yawRate: e.yawRate, pitchRate: e.pitchRate }));
}
