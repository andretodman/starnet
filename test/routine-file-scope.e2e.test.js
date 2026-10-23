'use strict';
// Real host + mock model: scoped routine writes a project file through native fs, never shell.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-file-scope-e2e-'));
  let project = path.join(scratch, 'project');
  const ws = path.join(scratch, 'workspaces');
  fs.mkdirSync(project); fs.mkdirSync(ws);
  project = fs.realpathSync(project);
  let child, round = 0;
  const requests = [];
  const mock = http.createServer((req, res) => {
    if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); return; }
    let input = '';
    req.on('data', b => { input += b; });
    req.on('end', () => {
      const body = JSON.parse(input || '{}'); requests.push(body);
      const names = (body.tools || []).map(t => t.function.name);
      const write = names.find(n => /^fs[._]write$/.test(n));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta, finish) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish || null }] }) + '\n\n');
      if (write && round < 2) {
        const approved = round++ === 0;
        send({ tool_calls: [{ index: 0, id: 'scope-call-' + round, type: 'function', function: {
          name: write, arguments: JSON.stringify({ path: approved ? 'Assets/Checkpoint.cs' : 'Assets/NotApproved.cs', content: approved ? '// checkpoint proof\n' : '// must not be written\n' })
        } }] });
        send({}, 'tool_calls');
      } else { send({ content: 'Checkpoint source saved. The other file was denied. Runtime tests were not executed.' }); send({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    });
  });
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    // Reserve an ephemeral local port, release it immediately before boot.
    const portProbe = http.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const base = 'http://127.0.0.1:' + port;
    const appdata = path.join(scratch, 'appdata');
    child = spawn(process.execPath, [path.resolve(__dirname, '../sidecar/index.js')], {
      env: { ...process.env, SKYNET_PORT: String(port), SKYNET_WORKSPACES: ws, SKYNET_DEV: '1',
        SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + mock.address().port + '/api/v1',
        SKYNET_OPENROUTER_KEY: 'test-not-a-real-key', SKYNET_DEFAULT_MODEL: 'test/model',
        SKYNET_FULL_ACCESS: '1', SKYNET_CHECKPOINTS: '0', STARNET_TRUST_LOCAL_PEERS: '1',
        LOCALAPPDATA: appdata, APPDATA: appdata, XDG_DATA_HOME: appdata },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      let logs = '';
      const timer = setTimeout(() => reject(new Error('isolated host boot timeout: ' + logs.slice(-2000))), 20000);
      const data = b => { logs += b; if (logs.includes(base)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', data); child.stderr.on('data', data);
      child.once('exit', code => { clearTimeout(timer); reject(new Error('isolated host exited ' + code + ': ' + logs.slice(-2000))); });
    });
    const token = await bootToken(base, base);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base };
    const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const permissions = await (await fetch(base + '/api/permissions', { headers })).json();
    assert.equal(permissions.envFullAccess, true, 'fixture really enables Full Access before the scope narrows it');
    const blessed = await post('/api/projects/bless', { path: project });
    assert.equal(blessed.status, 200, await blessed.text());
    const spec = { name: 'Scoped checkpoint proof', prompt: 'Implement the checkpoint proof file using fs.write.', schedule: 'every 1h',
      agentId: 'checkpoint-worker', model: 'test/model', provider: 'openrouter', workdir: project,
      enabledToolsets: ['cabinet'], unattendedGrants: [], fileScope: { paths: ['Assets/Checkpoint.cs'] } };
    const unauthenticated = await fetch(base + '/api/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    assert.equal(unauthenticated.status, 403, 'unauthenticated requests cannot enroll files');
    const made = await post('/api/cron', spec);
    const saved = await made.json();
    assert.equal(made.status, 200, JSON.stringify(saved));
    assert.deepEqual(saved.job.fileScope, { version: 1, workdir: project, paths: ['Assets/Checkpoint.cs'] });
    const id = saved.job.id;
    for (const patch of [{ enabledToolsets: ['workbench'] }, { unattendedGrants: ['workbench'] }, { workdir: ws }, { runsLine: true }]) {
      assert.equal((await post('/api/cron/update', { id, patch })).status, 400, 'scope cannot widen via another config field');
    }
    const run = await post('/api/cron/run', { id });
    assert.equal(run.status, 200);
    const events = (await run.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(fs.readFileSync(path.join(project, 'Assets/Checkpoint.cs'), 'utf8'), '// checkpoint proof\n', JSON.stringify(events.filter(e => e.name === 'agent.run.error')));
    assert.equal(fs.existsSync(path.join(project, 'Assets/NotApproved.cs')), false);
    const toolRequests = requests.filter(r => Array.isArray(r.tools) && r.tools.length);
    assert.ok(toolRequests.length > 0, 'real model requests had file tools');
    assert.ok(toolRequests.every(r => r.tools.every(t => /^fs[._](read|list|search|write|append|edit|patch)$/.test(t.function.name))), 'even Full Access advertises only native cabinet files');
    assert.ok(events.some(e => e.name === 'agent.run.end'), 'native routine reached a terminal event');
    assert.equal((await post('/api/permissions/revoke', { key: 'path:' + project })).status, 200);
    assert.equal((await post('/api/cron/update', { id, patch: { enabled: false } })).status, 200, 'pause still works after project trust is revoked');
    assert.equal((await post('/api/cron/update', { id, patch: { enabled: true } })).status, 400, 'revoked project cannot resume a scoped worker');
    const revoke = await post('/api/cron/update', { id, patch: { fileScope: null } });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).job.fileScope, null);
    console.log('routine-file-scope.e2e: PASS (host enrollment, native run, exact writes, full-posture fence)');
  } finally {
    if (child && child.exitCode == null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); }); }
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    await fsp.rm(scratch, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
