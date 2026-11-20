// 时间轴:风险曲线 + 阈值线 + 区段标记 + 事件刻度
import { RISK_THRESHOLD } from './riskmodel.js';
import { EVENT_NAMES } from './trajectory.js';
import { formatTime } from './util.js';

const EVENT_COLORS = {
  forcedTurn: '#e07020', roll: '#c040c0', speedBurst: '#e0c020',
  starfield: '#4090e0', bob: '#40c080', stopStart: '#e04040',
};

export function drawTimeline(canvas, perSecond, segments, events, selected) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const padL = 36, padR = 8, padT = 18, padB = 20;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = perSecond.length;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, W, H);

  const x = (sec) => padL + (sec / Math.max(1, n - 1)) * iw;
  const y = (r) => padT + ih - (Math.min(100, r) / 100) * ih;

  // 网格与刻度
  ctx.strokeStyle = '#2a3140'; ctx.fillStyle = '#8b949e';
  ctx.font = '10px system-ui'; ctx.textAlign = 'right';
  for (let r = 0; r <= 100; r += 25) {
    ctx.beginPath(); ctx.moveTo(padL, y(r)); ctx.lineTo(W - padR, y(r)); ctx.stroke();
    ctx.fillText(String(r), padL - 4, y(r) + 3);
  }
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.round(n / 10));
  for (let s = 0; s < n; s += step) ctx.fillText(formatTime(s), x(s), H - 6);

  // 阈值线
  ctx.strokeStyle = '#e0404088'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, y(RISK_THRESHOLD)); ctx.lineTo(W - padR, y(RISK_THRESHOLD)); ctx.stroke();
  ctx.setLineDash([]);

  // 高风险区段底色
  for (const s of segments) {
    ctx.fillStyle = s === selected ? 'rgba(224,64,64,0.35)' : 'rgba(224,64,64,0.18)';
    ctx.fillRect(x(s.t0), padT, Math.max(2, x(s.t1) - x(s.t0)), ih);
  }

  // 风险曲线
  ctx.beginPath();
  ctx.moveTo(x(0), y(perSecond[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(perSecond[i]));
  ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(x(n - 1), y(0)); ctx.lineTo(x(0), y(0)); ctx.closePath();
  ctx.fillStyle = 'rgba(88,166,255,0.12)'; ctx.fill();

  // 事件刻度
  ctx.textAlign = 'left';
  for (const e of events || []) {
    const ex = x((e.t0 + e.t1) / 2);
    ctx.fillStyle = EVENT_COLORS[e.type] || '#888';
    ctx.fillRect(x(e.t0), 4, Math.max(2, x(e.t1) - x(e.t0)), 6);
    ctx.fillText(EVENT_NAMES[e.type] || e.type, ex + 2, 9);
  }
}

export function timelineHit(canvas, perSecond, segments, clientX) {
  const rect = canvas.getBoundingClientRect();
  const padL = 36, padR = 8;
  const iw = canvas.width - padL - padR;
  const sec = ((clientX - rect.left) / rect.width * canvas.width - padL) / iw * (perSecond.length - 1);
  return segments.find(s => sec >= s.t0 && sec <= s.t1) || null;
}
