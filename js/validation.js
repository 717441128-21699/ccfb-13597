// 相关性验证:批量生成不同强度的会话 → 系统评分 vs 模拟 30 人问卷均分 → Pearson r
import { generateSession } from './recorder.js';
import { analyzeVRS } from './analyze.js';
import { mulberry32, gauss, pearson, clamp } from './util.js';

export async function runValidation(opts = {}, onProgress = () => {}) {
  const { n = 12, duration = 30, fps = 45, width = 480, height = 270, nSubjects = 30 } = opts;
  const rng = mulberry32(20261121);
  // 30 名被试的晕动易感性(跨会话保持一致)
  const susceptibility = Array.from({ length: nSubjects }, () => gauss(rng));

  const rows = [];
  for (let i = 0; i < n; i++) {
    const aggressiveness = 0.08 + 0.92 * (i / Math.max(1, n - 1));
    onProgress(i / n / 2, `会话 ${i + 1}/${n}:生成(强度 ${aggressiveness.toFixed(2)})`);
    const { blob, meta } = await generateSession(
      { duration, fps, width, height, seed: i * 31 + 7, aggressiveness },
      () => {},
    );
    onProgress((i + 0.5) / n / 2 + 0.0, `会话 ${i + 1}/${n}:分析`);
    const buf = await blob.arrayBuffer();
    const res = await analyzeVRS(buf, { skip: 2 }, {});
    const trueScore = meta.trueRisk.reduce((a, b) => a + b, 0) / meta.trueRisk.length;

    // 模拟问卷:均分 = 真值 + 个体易感性 + 测量噪声
    const subjScores = susceptibility.map(su =>
      clamp(trueScore + 9 * su + gauss(rng) * 8, 0, 100));
    const questMean = subjScores.reduce((a, b) => a + b, 0) / nSubjects;

    rows.push({
      i, aggressiveness: +aggressiveness.toFixed(2),
      system: res.overall, truth: +trueScore.toFixed(1),
      quest: +questMean.toFixed(1),
    });
    onProgress((i + 1) / n, `会话 ${i + 1}/${n} 完成`);
  }

  const r = pearson(rows.map(r => r.system), rows.map(r => r.quest));
  const rTruth = pearson(rows.map(r => r.system), rows.map(r => r.truth));
  return { r: +r.toFixed(3), rTruth: +rTruth.toFixed(3), rows, nSubjects };
}

export function drawScatter(canvas, rows) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pad = 40;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, W, H);
  const maxV = 100;
  const x = (v) => pad + (v / maxV) * (W - 2 * pad);
  const y = (v) => H - pad - (v / maxV) * (H - 2 * pad);
  ctx.strokeStyle = '#2a3140';
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px system-ui';
  for (let v = 0; v <= maxV; v += 20) {
    ctx.beginPath(); ctx.moveTo(x(v), pad); ctx.lineTo(x(v), H - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, y(v)); ctx.lineTo(W - pad, y(v)); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(String(v), x(v), H - pad + 14);
    ctx.textAlign = 'right'; ctx.fillText(String(v), pad - 6, y(v) + 3);
  }
  ctx.textAlign = 'center';
  ctx.fillText('系统风险分', W / 2, H - 8);
  ctx.save();
  ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('30 人问卷均分', 0, 0);
  ctx.restore();
  // 对角参考线
  ctx.strokeStyle = '#3a4150';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x(0), y(0)); ctx.lineTo(x(maxV), y(maxV)); ctx.stroke();
  ctx.setLineDash([]);
  for (const r of rows) {
    ctx.fillStyle = '#58a6ff';
    ctx.beginPath();
    ctx.arc(x(r.system), y(r.quest), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
