// 轻量 CDP（Chrome DevTools Protocol）浏览器端到端测试驱动，无第三方依赖。
// 启动 headless Chrome/Edge → 打开 e2e 测试页 → 轮询 window.__e2e → 输出结果。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = 'http://localhost:8080/src/browser/e2e-test.html';
const TIMEOUT_MS = 90_000;

const BROWSERS = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(port) {
  const userDir = mkdtempSync(join(tmpdir(), 'cdp-'));
  const flags = [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    'about:blank',
  ];
  for (const bin of BROWSERS) {
    try {
      const proc = spawn(bin, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        proc.once('error', reject);
        setTimeout(resolve, 200);
      });
      return { proc, bin };
    } catch {
      /* 下一个浏览器 */
    }
  }
  return null;
}

async function getWsUrl(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 重试 */ }
    await sleep(250);
  }
  throw new Error('无法连接浏览器调试端口');
}

async function run() {
  // 用随机高端口避免冲突
  const port = 10000 + Math.floor(Math.random() * 8000);
  const launched = await launch(port);
  if (!launched) {
    console.log('未找到可用的 Chrome/Edge，跳过浏览器端到端测试');
    return;
  }
  const { proc: chrome, bin } = launched;
  console.log(`浏览器: ${bin}（调试端口 ${port}）`);

  try {
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    await new Promise((r) => { ws.addEventListener('open', r); });
    const send = (method, params = {}) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve) => pending.set(id, resolve));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');
    await send('Page.navigate', { url: URL });

    const deadline = Date.now() + TIMEOUT_MS;
    let result = null;
    const pageErrors = [];
    while (Date.now() < deadline) {
      for (const e of events.splice(0)) {
        if (e.method === 'Runtime.exceptionThrown') {
          pageErrors.push(e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
        }
      }
      const r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__e2e || null)',
        returnByValue: true,
      });
      const val = r.result?.result?.value;
      // 注意：JSON.stringify(null) 得到字符串 "null"（truthy），需显式排除
      if (val && val !== 'null') {
        result = JSON.parse(val);
        break;
      }
      await sleep(800);
    }

    if (!result) {
      console.error('❌ 浏览器测试超时，未产出结果');
      if (pageErrors.length) console.error('页面异常:\n' + pageErrors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) {
        console.error('\n❌ 浏览器 E2E 断言失败');
        process.exitCode = 1;
      } else {
        console.log('\n✅ 浏览器端到端测试通过');
      }
    }
  } finally {
    chrome.kill();
  }
}

run();
