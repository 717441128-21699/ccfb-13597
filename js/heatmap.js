// 关卡地图:走廊俯视图 + 轨迹风险着色 + 高风险热区
import { EVENT_NAMES } from './trajectory.js';

function riskColor(r, alpha = 1) {
  // 绿 → 黄 → 红
  const t = Math.min(1, r / 70);
  const hue = 120 * (1 - t);
  return `hsla(${hue}, 85%, 55%, ${alpha})`;
}

export function drawHeatmap(canvas, level, camPosPerSec, perSecond, events) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, W, H);

  const pad = 30;
  const sx = (W - 2 * pad) / (level.outer.hx * 2 + 4);
  const sz = (H - 2 * pad) / (level.outer.hz * 2 + 4);
  const s = Math.min(sx, sz);
  const ox = W / 2, oz = H / 2;
  const X = (x) => ox + x * s, Z = (z) => oz + z * s;

  // 走廊区域(外矩形减内矩形)
  ctx.beginPath();
  ctx.rect(X(-level.outer.hx), Z(-level.outer.hz), level.outer.hx * 2 * s, level.outer.hz * 2 * s);
  ctx.rect(X(-level.inner.hx), Z(-level.inner.hz), level.inner.hx * 2 * s, level.inner.hz * 2 * s);
  ctx.fillStyle = '#21262d';
  ctx.fill('evenodd');
  ctx.strokeStyle = '#3a4150';
  ctx.strokeRect(X(-level.outer.hx), Z(-level.outer.hz), level.outer.hx * 2 * s, level.outer.hz * 2 * s);
  ctx.strokeRect(X(-level.inner.hx), Z(-level.inner.hz), level.inner.hx * 2 * s, level.inner.hz * 2 * s);

  // 高风险热区(径向渐变)
  for (let i = 0; i < perSecond.length && i < camPosPerSec.length; i++) {
    const r = perSecond[i];
    if (r < 55) continue;
    const [px, , pz] = camPosPerSec[i];
    const rad = (1.5 + (r - 55) / 15) * s;
    const g = ctx.createRadialGradient(X(px), Z(pz), 0, X(px), Z(pz), rad);
    g.addColorStop(0, `rgba(224, 48, 48, ${Math.min(0.55, (r - 50) / 60)})`);
    g.addColorStop(1, 'rgba(224, 48, 48, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(X(px), Z(pz), rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // 轨迹(按风险着色)
  ctx.lineWidth = Math.max(2, 0.8 * s);
  ctx.lineCap = 'round';
  for (let i = 1; i < camPosPerSec.length && i < perSecond.length + 1; i++) {
    const [x0, , z0] = camPosPerSec[i - 1];
    const [x1, , z1] = camPosPerSec[i];
    if (Math.hypot(x1 - x0, z1 - z0) > 10) continue; // 跨圈跳变不画
    ctx.strokeStyle = riskColor(perSecond[Math.min(i, perSecond.length - 1)]);
    ctx.beginPath();
    ctx.moveTo(X(x0), Z(z0));
    ctx.lineTo(X(x1), Z(z1));
    ctx.stroke();
  }

  // 事件标记
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  for (const e of events || []) {
    const mid = Math.floor((e.t0 + e.t1) / 2);
    if (mid >= camPosPerSec.length) continue;
    const [px, , pz] = camPosPerSec[mid];
    ctx.fillStyle = '#e6edf3';
    ctx.beginPath();
    ctx.arc(X(px), Z(pz), 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8b949e';
    ctx.fillText(EVENT_NAMES[e.type] || e.type, X(px), Z(pz) - 6);
  }

  // 图例
  const lg = ctx.createLinearGradient(pad, 0, pad + 120, 0);
  lg.addColorStop(0, riskColor(0));
  lg.addColorStop(1, riskColor(70));
  ctx.fillStyle = lg;
  ctx.fillRect(pad, H - 16, 120, 8);
  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'left';
  ctx.fillText('低', pad, H - 20);
  ctx.textAlign = 'right';
  ctx.fillText('高', pad + 120, H - 20);
  ctx.textAlign = 'left';
  ctx.fillText(level.name || '关卡地图', pad, 18);
}
