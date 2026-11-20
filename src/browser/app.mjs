// 应用主逻辑：标签页、数据生成/导入、分析编排、时间轴、热区图、建议、性能实测
import { generateSession } from './generator.mjs';
import { analyzeVrd } from './analyze-pipeline.mjs';
import { glFlowSupported } from './flow-gl.mjs';
import { parseVrd } from '../shared/vrd.mjs';
import { riskRating, DEFAULT_WEIGHTS } from '../shared/risk.mjs';
import { FPS } from '../shared/scene.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  session: null, // { bytes, meta, events, model }
  parsed: null,
  result: null,
  abortController: null,
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3800);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function scoreColor(score) {
  if (score < 25) return '#2ecc71';
  if (score < 45) return '#f1c40f';
  if (score < 65) return '#e67e22';
  return '#e74c3c';
}

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------
function detectCapabilities() {
  // 光流后端可用性由 glFlowSupported 统一判定（含浮点 FBO 完整性，无 GPU 时回退 CPU）
  const glUsable = glFlowSupported();
  const caps = [
    ['WebCodecs VideoEncoder', typeof VideoEncoder !== 'undefined'],
    ['WebCodecs VideoDecoder', typeof VideoDecoder !== 'undefined'],
    [glUsable ? 'WebGL2 GPU 光流（浮点 FBO）' : 'WebGL2 FBO 不可用 → CPU 回退', glUsable],
  ];
  $('capabilities').innerHTML = caps
    .map(([name, ok]) => `<span class="cap-pill ${ok ? 'ok' : 'no'}">${ok ? '✓' : '⚠' } ${name}</span>`)
    .join('');
  return caps.every(([, ok]) => ok);
}

// ---------------------------------------------------------------------------
// 标签页
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'heatmap' && state.result) drawHeatmap();
  });
});

// 滑块实时值
$('aggr').addEventListener('input', (e) => { $('aggrVal').textContent = Number(e.target.value).toFixed(2); });
$('tunnel').addEventListener('input', (e) => { $('tunnelVal').textContent = Number(e.target.value).toFixed(2); });

// ---------------------------------------------------------------------------
// ① 数据生成
// ---------------------------------------------------------------------------
$('btnGenerate').addEventListener('click', async () => {
  const duration = Number($('duration').value);
  const seed = Number($('seed').value);
  const profile = {
    aggressiveness: Number($('aggr').value),
    tunnelFraction: Number($('tunnel').value),
  };
  state.abortController = new AbortController();
  $('btnGenerate').disabled = true;
  $('btnCancel').disabled = false;
  $('genProgressWrap').hidden = false;
  $('genMeta').textContent = '';
  try {
    const t0 = performance.now();
    const session = await generateSession({
      duration,
      seed,
      profile,
      signal: state.abortController.signal,
      onProgress: (p) => {
        $('genProgress').style.width = `${(p * 100).toFixed(1)}%`;
        $('genProgressText').textContent = `${(p * 100).toFixed(0)}%`;
      },
    });
    const genMs = performance.now() - t0;
    state.session = session;
    state.parsed = null;
    state.result = null;
    const sizeKb = (session.bytes.byteLength / 1024).toFixed(1);
    $('genMeta').innerHTML = `
      <code>${session.meta.frameCount}</code> 帧姿态 · <code>${duration}</code> 秒 @90fps ·
      编码 <code>${session.codec}</code> · 文件 <code>${sizeKb} KB</code> ·
      事件 <code>${session.events.length}</code> 个 · 生成耗时 <code>${(genMs / 1000).toFixed(1)}s</code>
      <br>可直接在「② 分析」中分析（内存模式），或下载 .vrd 后重新导入验证完整解码链路。`;
    $('btnDownload').disabled = false;
    $('btnAnalyze').disabled = false;
    toast('试玩数据生成完成');
  } catch (e) {
    if (e.name !== 'AbortError') toast('生成失败: ' + e.message, true);
  } finally {
    $('btnGenerate').disabled = false;
    $('btnCancel').disabled = true;
  }
});

$('btnCancel').addEventListener('click', () => state.abortController?.abort());

$('btnDownload').addEventListener('click', () => {
  if (!state.session) return;
  const blob = new Blob([state.session.bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vrd-session-${state.session.meta.seed}-${state.session.meta.duration}s.vrd`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// 导入 .vrd
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseVrd(new Uint8Array(buf));
    state.parsed = parsed;
    state.session = null;
    state.result = null;
    $('loadMeta').innerHTML = `
      已加载 <code>${file.name}</code><br>
      <code>${parsed.meta.frameCount}</code> 帧 · <code>${parsed.meta.duration}</code> 秒 ·
      编码 <code>${parsed.meta.codec}</code> · 视频块 <code>${parsed.video.length}</code> 个 ·
      事件 <code>${parsed.meta.events?.length ?? 0}</code> 个`;
    $('btnAnalyze').disabled = false;
    toast('VRD 文件解析成功');
  } catch (err) {
    toast('解析失败: ' + err.message, true);
  }
});

// ---------------------------------------------------------------------------
// ② 分析
// ---------------------------------------------------------------------------
$('btnAnalyze').addEventListener('click', async () => {
  try {
    let parsed;
    if (state.parsed) {
      parsed = state.parsed; // 导入的文件：完整解码 + GL 光流链路
    } else if (state.session) {
      // 内存模式：把生成产物序列化再解析，确保走的是同一条 VRD 解码链路
      parsed = parseVrd(state.session.bytes);
      state.parsed = parsed;
    } else {
      toast('请先生成或导入试玩数据', true);
      return;
    }

    $('btnAnalyze').disabled = true;
    $('anProgressWrap').hidden = false;
    const canvas = $('glCanvas');
    const t0 = performance.now();
    const result = await analyzeVrd(parsed, {
      canvas,
      weights: DEFAULT_WEIGHTS,
      onProgress: (p) => {
        $('anProgress').style.width = `${(p * 100).toFixed(1)}%`;
        $('anProgressText').textContent = `${(p * 100).toFixed(0)}%`;
      },
    });
    state.result = result;
    renderSummary(result);
    renderTimeline(result, parsed);
    toast(`分析完成，会话风险分 ${result.overall}`);
  } catch (err) {
    toast('分析失败: ' + err.message, true);
  } finally {
    $('btnAnalyze').disabled = false;
  }
});

function renderSummary(result) {
  const rating = riskRating(result.overall);
  const t = result.timing;
  const budget10Min = (t.elapsedMs / t.frames) * 54000;
  $('analyzeSummary').innerHTML = `
    <div class="summary-grid">
      <div class="stat" style="border-left-color:${rating.color}">
        <div class="num">${result.overall}</div>
        <div class="lbl">会话风险分</div>
      </div>
      <div class="stat" style="border-left-color:${rating.color}">
        <span class="rating-badge" style="background:${rating.color}">${rating.label}</span>
        <div class="lbl">发行商评级（L${rating.level}）</div>
      </div>
      <div class="stat">
        <div class="num">${result.stats.highRiskSeconds}</div>
        <div class="lbl">高风险秒数（≥55 分）</div>
      </div>
      <div class="stat">
        <div class="num">${result.hotZones.length}</div>
        <div class="lbl">热区数量</div>
      </div>
      <div class="stat">
        <div class="num">${t.fps.toFixed(0)}</div>
        <div class="lbl">分析吞吐（帧/秒）</div>
      </div>
      <div class="stat">
        <div class="num">${(t.realtimeRatio).toFixed(1)}×</div>
        <div class="lbl">快于实时倍率</div>
      </div>
    </div>
    <p class="hint" style="margin-top:14px">
      光流后端 <code>${t.backend === 'webgl2-lk' ? 'WebGL2 金字塔 LK（GPU）' : 'CPU 相位相关（无 GPU 降级，精度受限）'}</code>
      · 本会话实测分析耗时 <code>${(t.elapsedMs / 1000).toFixed(1)}s</code>；
      按当前吞吐折算 10 分钟会话约需 <code>${(budget10Min / 1000).toFixed(1)}s</code>（预算 180s）。
    </p>`;
}

// ---------------------------------------------------------------------------
// ③ 时间轴
// ---------------------------------------------------------------------------
const FEATURE_LABELS = {
  yawRate: '载具偏航速率',
  pitchRate: '俯仰速率',
  peakAng: '峰值角速度',
  peakAcc: '角加速度冲击',
  peripheralRatio: '周边光流放大',
  mismatch: '头动-画面背离',
  surge: '前进散度',
  incoherence: '光流非相干',
};

function renderTimeline(result, parsed) {
  const chart = $('timelineChart');
  chart.innerHTML = '';
  const maxScore = 100;
  result.perSecond.forEach((sec) => {
    const bar = document.createElement('div');
    bar.className = 'tl-bar';
    bar.style.height = `${(sec.score / maxScore) * 100}%`;
    bar.style.background = scoreColor(sec.score);
    bar.title = `${fmtTime(sec.second)} 风险分 ${sec.score}`;
    bar.addEventListener('mousemove', () => renderSecondDetail(sec));
    chart.appendChild(bar);
  });
  renderEventList(result);
}

function renderSecondDetail(sec) {
  const featRows = Object.entries(sec.features)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `
      <div class="feat-row">
        <span class="name">${FEATURE_LABELS[k] || k}</span>
        <div class="feat-track"><div style="width:${Math.min(100, v / 1.5 * 100)}%"></div></div>
        <span class="val">${v.toFixed(2)}</span>
      </div>`).join('');
  $('secondDetail').innerHTML = `
    <strong>${fmtTime(sec.second)} – ${fmtTime(sec.second + 1)}</strong>
    风险分 <span style="color:${scoreColor(sec.score)};font-weight:700">${sec.score}</span>
    · 偏航 ${sec.yawRateDeg.toFixed(0)}°/s · 背离 ${sec.mismatchPx.toFixed(0)}px/s
    · 周边 ${sec.peripheryPx.toFixed(0)}px/s
    ${sec.tunnel > 0.05 ? `· 隧道遮罩 ${(sec.tunnel * 100).toFixed(0)}%` : ''}
    <div style="margin-top:10px">${featRows}</div>`;
}

function renderEventList(result) {
  const wrap = $('eventList');
  if (!result.hotZones.length) {
    wrap.innerHTML = '<p class="hint">未检测到高风险热区，关卡舒适度良好。</p>';
    return;
  }
  wrap.innerHTML = result.hotZones.map((z) => `
    <div class="event-item prio-${z.tips[0]?.priority || 'low'}">
      <h3>${fmtTime(z.t0)}–${fmtTime(z.t1)} 热区 · 峰值 ${z.peak} 分 · 均值 ${z.mean} 分</h3>
      ${z.tips.map((tip) => `
        <div class="tip">
          <span class="time">[${tip.priority === 'high' ? '高优先' : tip.priority === 'medium' ? '中优先' : '低优先'}]
          ${tip.title}</span>
          <p>${tip.detail}</p>
        </div>`).join('')}
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// ④ 关卡热区图（俯视走廊，颜色=风险）
// ---------------------------------------------------------------------------
function drawHeatmap() {
  const result = state.result;
  const parsed = state.parsed;
  const canvas = $('mapCanvas');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = 360;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const margin = 40;

  // 路径点：优先用 VRD v2 存储的精确位置；旧文件回退到速度积分重建
  const hasPos = parsed.frames[0]?.pos;
  const path = hasPos
    ? parsed.frames.map((f) => [f.pos[0], f.pos[2]])
    : (() => {
        const integrated = [[0, 2]];
        let px = 0;
        let pz = 2;
        for (let i = 1; i < parsed.frames.length; i++) {
          const v = parsed.frames[i].worldV;
          px += v[0] / FPS;
          pz += v[2] / FPS;
          integrated.push([px, pz]);
        }
        return integrated;
      })();
  const minX = Math.min(...path.map((p) => p[0]));
  const maxX = Math.max(...path.map((p) => p[0]));
  const minZ = Math.min(...path.map((p) => p[1]));
  const maxZ = Math.max(...path.map((p) => p[1]));
  const sx = (W - margin * 2) / Math.max(0.001, maxX - minX);
  const sz = (H - margin * 2) / Math.max(0.001, maxZ - minZ);
  const toMap = (p) => [
    margin + (p[0] - minX) * sx,
    margin + (p[1] - minZ) * sz,
  ];

  // 走廊边界
  ctx.strokeStyle = 'rgba(147,160,176,0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  const corners = [
    toMap([minX - 0.5, minZ]), toMap([minX - 0.5, maxZ]),
    toMap([maxX + 0.5, maxZ]), toMap([maxX + 0.5, minZ]),
  ];
  ctx.beginPath();
  ctx.moveTo(corners[0][0], corners[0][1]);
  for (const c of corners.slice(1)) ctx.lineTo(c[0], c[1]);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // 路径按秒着色（每秒 90 帧）
  const scores = result.perSecond.map((s) => s.score);
  for (let s = 0; s < scores.length; s++) {
    const start = s * FPS;
    const end = Math.min(path.length, (s + 1) * FPS);
    if (end - start < 2) continue;
    ctx.strokeStyle = scoreColor(scores[s]);
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    const a = toMap(path[start]);
    ctx.moveTo(a[0], a[1]);
    for (let i = start + 1; i < end; i++) {
      const p = toMap(path[i]);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 起点/终点标记
  const st = toMap(path[0]);
  const en = toMap(path[path.length - 1]);
  ctx.fillStyle = '#4aa8ff';
  ctx.beginPath(); ctx.arc(st[0], st[1], 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e6ebf2';
  ctx.beginPath(); ctx.arc(en[0], en[1], 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#93a0b0';
  ctx.font = '11px system-ui';
  ctx.fillText('起点', st[0] + 9, st[1] + 4);
  ctx.fillText('终点', en[0] + 9, en[1] + 4);

  // 热区编号
  ctx.font = 'bold 12px system-ui';
  result.hotZones.forEach((z, idx) => {
    const mid = Math.min(path.length - 1, Math.floor((z.t0 + z.t1) / 2) * FPS);
    const p = toMap(path[mid]);
    ctx.fillStyle = '#fff';
    ctx.fillText(`H${idx + 1}`, p[0] - 5, p[1] - 9);
  });

  renderZoneTips(result);
}

function renderZoneTips(result) {
  $('zoneTips').innerHTML = result.hotZones.map((z, idx) => `
    <div class="zone-tip">
      <h3>热区 H${idx + 1} · ${fmtTime(z.t0)}–${fmtTime(z.t1)} · 峰值 ${z.peak} 分</h3>
      ${z.tips.map((tip) => `
        <div class="tip">
          <strong style="color:${tip.priority === 'high' ? '#e74c3c' : tip.priority === 'medium' ? '#e67e22' : '#f1c40f'}">
            ${tip.title}</strong>
          <p style="margin:4px 0 0">${tip.detail}</p>
        </div>`).join('')}
    </div>`).join('') || '<p class="hint">无热区</p>';
}

// ---------------------------------------------------------------------------
// ⑤ 性能实测
// ---------------------------------------------------------------------------
$('btnBenchShort').addEventListener('click', async () => {
  try {
    toast('正在生成 60 秒基准会话并分析…');
    const session = await generateSession({
      duration: 60,
      seed: 7,
      profile: { aggressiveness: 1.1, tunnelFraction: 0.3 },
      onProgress: () => {},
    });
    const parsed = parseVrd(session.bytes);
    const canvas = $('glCanvas');
    const result = await analyzeVrd(parsed, { canvas, weights: DEFAULT_WEIGHTS, onProgress: () => {} });
    const t = result.timing;
    const projected10Min = (t.elapsedMs / t.frames) * 54000;
    const pass = projected10Min <= 180_000;
    $('benchResults').innerHTML = `
      <div class="bench-row"><span>基准会话</span><span>60 秒 / ${t.frames} 帧 @90fps</span></div>
      <div class="bench-row"><span>实测分析耗时</span><span>${(t.elapsedMs / 1000).toFixed(2)} s</span></div>
      <div class="bench-row"><span>解码+GL 光流+评分吞吐</span><span>${t.fps.toFixed(0)} 帧/秒</span></div>
      <div class="bench-row"><span>快于实时倍率</span><span>${t.realtimeRatio.toFixed(1)}×</span></div>
      <div class="bench-row"><span>折算 10 分钟（54000 帧）耗时</span>
        <span class="${pass ? 'ok' : 'fail'}">${(projected10Min / 1000).toFixed(1)} s ${pass ? '✓ 达标（≤180s）' : '✗ 超预算'}</span></div>
      <div class="bench-row"><span>预算余量</span><span>${(180 - projected10Min / 1000).toFixed(1)} s</span></div>`;
    toast('基准测试完成');
  } catch (e) {
    toast('基准测试失败: ' + e.message, true);
  }
});

// 启动
detectCapabilities();
