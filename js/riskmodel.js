// 晕动风险模型:生成端(真值)与分析端(估计)共用同一套公式,保证口径一致。
// 输入分量为物理量(弧度/秒):
//   rot    — 视觉旋转与头部旋转的失配(含滚转加权)
//   periph — 视野边缘光流速度(vection 强度)
//   loom   — 径向扩张/收缩(逼近运动)
//   vert   — 垂直方向视觉晃动(头部摆动/相机震动)
export const NORM = { rot: 1.0, periph: 1.2, loom: 0.35, vert: 0.45 };
export const W = { rot: 0.42, periph: 0.30, loom: 0.10, vert: 0.18 };
const CAP = 1.5;

export function riskFromComponents(c) {
  const t =
    W.rot * Math.min(c.rot / NORM.rot, CAP) +
    W.periph * Math.min(c.periph / NORM.periph, CAP) +
    W.loom * Math.min(c.loom / NORM.loom, CAP) +
    W.vert * Math.min(c.vert / NORM.vert, CAP);
  return Math.min(100, 100 * t);
}

// 各分量对总分的加权贡献(用于找主导因素)
export function contributions(c) {
  return {
    rot: W.rot * Math.min(c.rot / NORM.rot, CAP),
    periph: W.periph * Math.min(c.periph / NORM.periph, CAP),
    loom: W.loom * Math.min(c.loom / NORM.loom, CAP),
    vert: W.vert * Math.min(c.vert / NORM.vert, CAP),
  };
}

export function gradeOf(score) {
  if (score < 20) return { grade: 'A', label: '低风险', color: '#3fb950' };
  if (score < 35) return { grade: 'B', label: '中风险', color: '#d4a017' };
  if (score < 50) return { grade: 'C', label: '高风险', color: '#e07020' };
  return { grade: 'D', label: '极高风险', color: '#e04040' };
}

export const RISK_THRESHOLD = 40; // 区段标记阈值
