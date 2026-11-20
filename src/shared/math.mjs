// 通用数学工具：角度、四元数、统计。浏览器与 Node 共用，无平台依赖。
export const TAU = Math.PI * 2;
export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;

export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

// 解开跨越 ±π 的角度序列，保证差分连续（捕捉 snap turn 这类大跳变也保留真实差值）
export function unwrapAngle(prev, next) {
  let d = next - prev;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return prev + d;
}

// yaw（绕 Y）→ pitch（绕 X）顺序的欧拉角转四元数 [x,y,z,w]
export function eulerToQuat(yaw, pitch, roll = 0) {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  return [
    sr * cy * cp - cr * sy * sp, // x
    cr * sy * cp + sr * cy * sp, // y
    cr * cy * sp - sr * sy * cp, // z
    cr * cy * cp + sr * sy * sp, // w
  ];
}

// 四元数转回 yaw/pitch（roll 忽略——VR 晕动分析主要用偏航/俯仰）
export function quatToEuler(q) {
  const [x, y, z, w] = q;
  const sinp = 2 * (w * z - y * x);
  const pitch = Math.asin(clamp(sinp, -1, 1));
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
  return { yaw, pitch };
}

export function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function rms(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x * x;
  return Math.sqrt(s / xs.length);
}

export function percentile(xs, p) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const idx = clamp(Math.round(p * (a.length - 1)), 0, a.length - 1);
  return a[idx];
}

// Pearson 相关系数
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

// Spearman 秩相关（先排名再算 Pearson，并列取平均名次）
export function spearman(xs, ys) {
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

// 普通最小二乘 y = X·w（含截距列由调用方决定），带岭正则防共线
export function ridgeFit(X, y, lambda = 1e-3) {
  const n = X.length;
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += lambda;
  return solveLinear(A, b);
}

// 高斯消元解线性方程组
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
