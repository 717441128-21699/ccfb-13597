// 确定性伪随机数（mulberry32 + 字符串哈希种子），浏览器与 Node 结果完全一致
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 高斯白噪声（Box-Muller），rng 为 makeRng 返回的确定性随机源
export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 确定性平滑噪声（若干正弦叠加 + 缓慢随机游走），用于生成自然的头部运动
export function makeNoise1D(rng, { freqs = 5, baseHz = 0.3 } = {}) {
  const comps = Array.from({ length: freqs }, (_, i) => ({
    w: 2 * Math.PI * baseHz * (i + 1) * (0.7 + rng() * 0.6),
    amp: 1 / (i + 1.3),
    phase: rng() * 2 * Math.PI,
  }));
  let walk = 0;
  return (t) => {
    walk += gaussian(rng) * 0.012;
    walk *= 0.995; // 均值回归，防止漂移发散
    let v = 0;
    let norm = 0;
    for (const c of comps) {
      v += c.amp * Math.sin(c.w * t + c.phase);
      norm += c.amp;
    }
    return v / norm + walk;
  };
}
