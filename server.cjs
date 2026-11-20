// 极简静态服务器(仅用于本地测试)
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.vrs': 'application/octet-stream' };
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/__result')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fs.writeFileSync(path.join(root, '.autotest-result.json'), body);
      res.writeHead(200); res.end('ok');
      console.log('result saved');
    });
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/__image')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = body.match(/^data:image\/png;base64,(.+)$/);
      if (m) fs.writeFileSync(path.join(root, '.debug-image.png'), Buffer.from(m[1], 'base64'));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8931, () => console.log('serving on http://127.0.0.1:8931'));
