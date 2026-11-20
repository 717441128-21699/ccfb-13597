// UI 主逻辑
import { generateSession } from './recorder.js';
import { analyzeVRS } from './analyze.js';
import { drawTimeline, timelineHit } from './timeline.js';
import { drawHeatmap } from './heatmap.js';
import { runValidation, drawScatter } from './validation.js';
import { formatTime } from './util.js';
import { EVENT_NAMES } from './trajectory.js';

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};

let currentBlob = null, currentMeta = null, currentResult = null, selectedSegment = null;

function checkSupport() {
  const items = [];
  const c = document.createElement('canvas');
  items.push(['WebGL2', !!c.getContext('webgl2')]);
  items.push(['WebCodecs 编码', typeof VideoEncoder !== 'undefined']);
  items.push(['WebCodecs 解码', typeof VideoDecoder !== 'undefined']);
  const ok = items.every(i => i[1]);
  $('support').innerHTML = items.map(([n, v]) =>
    `<span class="chip ${v ? 'ok' : 'bad'}">${n} ${v ? '✓' : '✗'}</span>`).join('');
  return ok;
}

function setProgress(id, p, text) {
  const bar = $(id);
  bar.querySelector('.fill').style.width = `${Math.round(p * 100)}%`;
  bar.querySelector('.label').textContent = text || '';
}

// ---- 生成试玩数据 ----
async function onGenerate() {
  const opts = {
    duration: +$('genDuration').value,
    fps: +$('genFps').value,
    width: +$('genRes').value.split('x')[0],
    height: +$('genRes').value.split('x')[1],
    seed: +$('genSeed').value,
    aggressiveness: +$('genAggr').value / 100,
  };
  $('btnGen').disabled = true;
  try {
    log(`开始生成试玩数据:${opts.duration}s @ ${opts.fps}fps ${opts.width}x${opts.height}`);
    const t0 = performance.now();
    const { blob, meta } = await generateSession(opts, (p, txt) => setProgress('genProgress', p, txt));
    currentBlob = blob; currentMeta = meta;
    log(`生成完成:${(blob.size / 1e6).toFixed(1)} MB,耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s,${meta.events.length} 个风险事件`);
    const url = URL.createObjectURL(blob);
    const a = $('downloadLink');
    a.href = url;
    a.download = `session_${opts.duration}s_${opts.fps}fps.vrs`;
    a.textContent = `下载 ${a.download} (${(blob.size / 1e6).toFixed(1)} MB)`;
    a.style.display = 'inline';
    $('btnAnalyze').disabled = false;
    setProgress('genProgress', 1, '完成');
  } catch (e) {
    log('生成失败:' + (e.stack || e));
  } finally {
    $('btnGen').disabled = false;
  }
}

// ---- 分析 ----
async function onAnalyze() {
  if (!currentBlob) return;
  $('btnAnalyze').disabled = true;
  try {
    log('开始分析…');
    const buf = await currentBlob.arrayBuffer();
    const res = await analyzeVRS(buf, { skip: 2 }, {
      onProgress: (p, txt) => setProgress('anaProgress', p, txt),
    });
    currentResult = res;
    selectedSegment = null;
    renderResults();
    const t = res.timing;
    log(`分析完成:${t.framesAnalyzed} 帧,耗时 ${(t.wallMs / 1000).toFixed(1)}s(${t.speedup}× 实时);总分 ${res.overall} (${res.grade.label})`);
    setProgress('anaProgress', 1, '完成');
  } catch (e) {
    log('分析失败:' + (e.stack || e));
  } finally {
    $('btnAnalyze').disabled = false;
  }
}

function renderResults() {
  const res = currentResult;
  $('results').style.display = 'block';
  const g = res.grade;
  $('scoreBig').textContent = res.overall;
  $('scoreBig').style.color = g.color;
  $('gradeLabel').textContent = `${g.grade} 级 · ${g.label}`;
  $('gradeLabel').style.color = g.color;
  const t = res.timing;
  $('perfInfo').textContent =
    `视频 ${t.videoSec}s → 分析 ${(t.wallMs / 1000).toFixed(1)}s(${t.speedup}× 实时)` +
    `| P95 风险 ${res.p95} | 高风险区段 ${res.segments.length} 个`;

  drawTimeline($('timeline'), res.perSecond, res.segments, res.meta.events, selectedSegment);
  drawHeatmap($('heatmap'), res.meta.level, res.meta.camPosPerSec, res.perSecond, res.meta.events);
  renderSegments();
  renderSuggestions();
}

function renderSegments() {
  const res = currentResult;
  const box = $('segments');
  if (!res.segments.length) {
    box.innerHTML = '<p class="dim">未发现高风险区段。</p>';
    return;
  }
  box.innerHTML = '';
  for (const s of res.segments) {
    const div = document.createElement('div');
    div.className = 'segment' + (s === selectedSegment ? ' selected' : '');
    const evNames = s.events.map(e => EVENT_NAMES[e] || e).join('、') || '—';
    div.innerHTML =
      `<div class="seg-head"><b>${formatTime(s.t0)} – ${formatTime(s.t1)}</b>` +
      `<span class="sev sev-${s.severity}">${s.severity}风险 ${s.mean.toFixed(0)}</span></div>` +
      `<div class="dim">主导因素:${s.suggestion.title} | 关联事件:${evNames}</div>`;
    div.onclick = () => { selectedSegment = s; renderResults(); };
    box.appendChild(div);
  }
}

function renderSuggestions() {
  const res = currentResult;
  const box = $('suggestions');
  // 按贡献度汇总需要整改的类型
  const agg = {};
  for (const s of res.segments) {
    agg[s.dominant] = (agg[s.dominant] || 0) + (s.contrib[s.dominant] || 0) * (s.t1 - s.t0);
  }
  const types = Object.keys(agg).sort((a, b) => agg[b] - agg[a]);
  if (!types.length) {
    box.innerHTML = '<p class="dim">当前关卡无需整改项。</p>';
    return;
  }
  box.innerHTML = '';
  for (const tp of types) {
    const sg = res.segments.find(s => s.dominant === tp).suggestion;
    const div = document.createElement('div');
    div.className = 'suggestion';
    div.innerHTML = `<b>${sg.title}</b><ul>${sg.tips.map(t => `<li>${t}</li>`).join('')}</ul>`;
    box.appendChild(div);
  }
}

// ---- 文件拖放 ----
function setupDrop() {
  const dz = $('dropzone');
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = async (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) await loadFile(f);
  };
  $('fileInput').onchange = async (e) => {
    if (e.target.files[0]) await loadFile(e.target.files[0]);
  };
  async function loadFile(f) {
    currentBlob = f;
    currentMeta = null;
    $('btnAnalyze').disabled = false;
    log(`已加载 ${f.name} (${(f.size / 1e6).toFixed(1)} MB),点击"开始分析"`);
  }
}

// ---- 相关性验证 ----
async function onValidate() {
  const n = +$('valN').value;
  $('btnVal').disabled = true;
  try {
    log(`开始相关性验证:${n} 个会话 × 30 名模拟被试(完整管线:生成→编码→解码→光流→评分)`);
    const t0 = performance.now();
    const val = await runValidation(
      { n, duration: 30, fps: 45, width: 480, height: 270 },
      (p, txt) => setProgress('valProgress', p, txt),
    );
    drawScatter($('scatter'), val.rows);
    const pass = val.r >= 0.8;
    $('valResult').innerHTML =
      `Pearson r = <b class="${pass ? 'ok-text' : 'bad-text'}">${val.r}</b>` +
      `(要求 ≥ 0.8,${pass ? '达标 ✓' : '未达标 ✗'})` +
      `<span class="dim"> | 系统分 vs 真值 r = ${val.rTruth} | 耗时 ${((performance.now() - t0) / 1000).toFixed(0)}s</span>`;
    log(`验证完成:r = ${val.r}(${pass ? '达标' : '未达标'})`);
    setProgress('valProgress', 1, '完成');
  } catch (e) {
    log('验证失败:' + (e.stack || e));
  } finally {
    $('btnVal').disabled = false;
  }
}

async function boot() {
  if (!checkSupport()) {
    log('当前浏览器缺少必要能力,请使用最新版 Chrome / Edge。');
    return;
  }
  $('btnGen').onclick = onGenerate;
  $('btnAnalyze').onclick = onAnalyze;
  $('btnVal').onclick = onValidate;
  $('timeline').onclick = (e) => {
    if (!currentResult) return;
    const s = timelineHit($('timeline'), currentResult.perSecond, currentResult.segments, e.clientX);
    if (s) { selectedSegment = s; renderResults(); }
  };
  setupDrop();
  log('系统就绪。可先生成一段试玩数据,或拖入已有 .vrs 文件分析。');
}

boot();
