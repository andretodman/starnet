'use strict';
// Invariant: operator-enrolled routines mutate exact files only; no shell, self-grant or stale authority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makeRoutineFileScopes } = require('../sidecar/routine-file-scope.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const store = require('../sidecar/cron-store.js');

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-file-scope-'));
  try {
    let root = path.join(dir, 'project');
    const other = path.join(dir, 'other');
    await fsp.mkdir(root); await fsp.mkdir(other);
    root = fs.realpathSync(root);
    let blessed = true, tainted = false;
    const trust = makePathTrust({ fsp, pathMod: path, roots: () => blessed ? [root] : [] });
    const scopes = makeRoutineFileScopes({ fs, pathMod: path, canonicalWorkdir: raw => {
      const real = fs.realpathSync(raw);
      if (!blessed || real !== root) throw new Error('project approval revoked');
      return real;
    }, protectedPath: trust._internals.hardlineReason });
    const spec = { id: 'job', agentId: 'worker', prompt: 'Implement checkpoint test', workdir: root,
      enabled: true, enabledToolsets: ['cabinet'], unattendedGrants: [], fileScope: { paths: ['Assets/Checkpoint.cs', 'Tools/checkpoint.test.js'] } };
    let job = { ...spec, fileScope: scopes.configure(spec, { host: true }) };
    assert.throws(() => scopes.configure(spec), /host/);
    for (const bad of ['../escape', '/tmp/escape', '*.cs', 'Assets/', 'Assets/../escape', '.git/config', '.env', 'x\\y']) {
      assert.throws(() => scopes.configure({ ...spec, fileScope: { paths: [bad] } }, { host: true }), /file scope|protected/);
    }
    for (const extra of [{ script: 'test.js' }, { noAgent: true }, { runsLine: true }, { unattendedGrants: ['workbench'] }, { enabledToolsets: null }]) {
      assert.throws(() => scopes.configure({ ...spec, ...extra }, { host: true }), /file scope/);
    }
    assert.equal(scopes.configure({ ...spec, fileScope: null }), null);
    const createRun = () => scopes.bind({ jobId: 'job', agentId: 'worker', workdir: root, getJob: () => job, tainted: () => tainted });
    const run = createRun();
    const toolDeps = { fsp, pathMod: path, root: path.join(dir, 'private'), noSymlinkTraversal: true, pathTrust: async (abs, opts) => {
      run.guardPath(abs, opts.scope);
      const guarded = await trust.guard(abs, { ...opts, surface: 'autonomous' });
      return { ...guarded, base: root };
    } };
    const tools = makeFsTools(toolDeps);
    const ctx = { agentId: 'worker', projectRoot: root, surface: 'autonomous' };
    const call = { name: 'fs.write', args: { path: 'Assets/Checkpoint.cs', content: 'first' } };
    assert.equal(run.authorize(call, tools.writeTool).ok, true);
    assert.equal(run.consent(call, tools.writeTool).allow, true);
    await tools.writeTool.run(call.args, ctx);
    assert.equal(await fsp.readFile(path.join(root, call.args.path), 'utf8'), 'first');
    assert.equal(run.authorize({ name: 'shell.exec', args: { cmd: 'true' } }, { name: 'shell.exec', scope: 'execute' }).ok, false);
    assert.equal(run.authorize({ name: 'routine.manage', args: {} }, { name: 'routine.manage', scope: 'write' }).ok, false);
    await assert.rejects(tools.writeTool.run({ path: 'Assets/Other.cs', content: 'no' }, ctx), /exact editable/);
    await assert.rejects(tools.writeTool.run({ path: path.join(other, 'outside'), content: 'no' }, ctx), /outside/);
    await assert.rejects(tools.readTool.run({ path: path.join(other, 'outside') }, ctx), /outside/);
    await assert.rejects(tools.readTool.run({ path: '.git/config' }, ctx), /protected/);
    const multi = '*** Begin Patch\n*** Update File: Assets/Checkpoint.cs\n-first\n+second\n*** Add File: Assets/Other.cs\n+no\n*** End Patch';
    assert.equal(run.authorize({ name: 'fs.patch', args: { patch: multi } }, tools.patchTool).ok, false);
    await assert.rejects(tools.patchTool.run({ patch: multi }, ctx), /exact editable/);
    assert.equal(await fsp.readFile(path.join(root, call.args.path), 'utf8'), 'first');
    await fsp.mkdir(path.join(root, 'Tools'));
    await fsp.symlink(path.join(other, 'outside'), path.join(root, 'Tools/checkpoint.test.js'));
    await assert.rejects(tools.writeTool.run({ path: 'Tools/checkpoint.test.js', content: 'no' }, ctx), /symlink/);
    await fsp.unlink(path.join(root, 'Tools/checkpoint.test.js'));
    await fsp.writeFile(path.join(other, 'secret.txt'), 'DO_NOT_LEAK_EXTERNAL');
    await fsp.writeFile(path.join(root, '.env'), 'DO_NOT_LEAK_PROTECTED');
    await fsp.symlink(path.join(other, 'secret.txt'), path.join(root, 'external-alias.txt'));
    await fsp.symlink(other, path.join(root, 'external-directory'));
    await fsp.symlink(path.join(root, '.env'), path.join(root, 'protected-alias.txt'));
    const listing = await tools.listTool.run({ recursive: true }, ctx);
    assert.ok(!listing.content.includes('external-directory/secret.txt'), 'recursive listing never follows child directory links');
    for (const searchTools of [tools, makeFsTools({ ...toolDeps, spawn: require('node:child_process').spawn })]) {
      const search = await searchTools.searchTool.run({ query: 'DO_NOT_LEAK', gitignore: false }, ctx);
      assert.ok(!search.content.includes('DO_NOT_LEAK_EXTERNAL') && !search.content.includes('DO_NOT_LEAK_PROTECTED'), 'both walker and ripgrep skip child symlinks, including protected in-root targets');
    }
    await fsp.writeFile(path.join(other, 'shared'), 'safe');
    await fsp.link(path.join(other, 'shared'), path.join(root, 'Tools/checkpoint.test.js'));
    await assert.rejects(tools.writeTool.run({ path: 'Tools/checkpoint.test.js', content: 'no' }, ctx), /hardlink/);
    await fsp.unlink(path.join(root, 'Tools/checkpoint.test.js'));
    // Live revocation overrides cached/full approvals because authorization precedes the consent broker.
    tainted = true; assert.equal(run.authorize(call, tools.writeTool).ok, false); tainted = false;
    blessed = false; assert.equal(run.authorize(call, tools.writeTool).ok, false); blessed = true;
    const approved = job;
    for (const revoked of [null, { ...job, enabled: false }, { ...job, fileScope: null }, { ...job, prompt: 'different' }, { ...job, agentId: 'other' }]) {
      job = revoked; assert.equal(run.authorize(call, tools.writeTool).ok, false);
    }
    job = approved;
    assert.equal(run.authorize(call, tools.writeTool).ok, true);
    assert.equal(scopes.bind({ jobId: 'job', agentId: 'worker', workdir: root, getJob: () => ({ ...job, fileScope: null }) }), null);
    assert.throws(() => scopes.bind({ jobId: 'job', agentId: 'worker', workdir: other, getJob: () => job }), /workdir/);
    const stored = store.makeJob(job, { now: 1 });
    assert.deepEqual(stored.fileScope, job.fileScope);
    assert.deepEqual(store.loadEnvelope(JSON.stringify(store.toEnvelope([stored]))).jobs[0].fileScope, job.fileScope, 'same exact enrollment survives durable envelope reload');
    stored.fileScope.paths.push('not-shared');
    assert.equal(job.fileScope.paths.includes('not-shared'), false);
    assert.deepEqual(store.grantsRevokedByAgentEdit(job, { prompt: 'changed' }), ['files']);
    assert.deepEqual(store.grantsRevokedByAgentEdit(job, { prompt: job.prompt }), []);
    assert.throws(() => scopes.bind({ jobId: 'job', agentId: 'worker', workdir: root,
      getJob: () => ({ ...job, fileScope: { ...job.fileScope, revoked: true } }) }), /revoked/);
    assert.equal(store.updateJob([job], 'job', { fileScope: null }, { now: 2 })[0].fileScope, null);
    const source = await fsp.readFile(path.resolve(__dirname, '../sidecar/index.js'), 'utf8');
    assert.match(source, /createCronJobFromSpec\(body, \{ hostFileScope: true \}\)/);
    assert.equal((source.match(/hostFileScope: true/g) || []).length, 1, 'only the authenticated create route opts into scope enrollment');
    assert.match(source, /if \(grantsCleared\.includes\('files'\)\) next\.fileScope = \{ \.\.\.current\.fileScope, revoked: true \}/);
    assert.match(source, /if \(revoked\.includes\('files'\)\) patch\.fileScope = \{ \.\.\.current\.fileScope, revoked: true \}/, 'app.schedule agent edits revoke too');
    assert.match(source, /if \(routineFiles\) resolved = routineFiles\.restrict\(resolved\)/);
    assert.match(source, /authorize: \(call, tool\) => \{\s*if \(routineFiles\)/);
    assert.match(source, /unrestrictedHost: !routineFiles && unrestrictedHostNow\(\)/);
    assert.match(source, /return routineFiles \? \{ \.\.\.guarded, base: routineFiles\.workdir \} : guarded/);
    const winScopes = makeRoutineFileScopes({ fs: { lstatSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
      pathMod: path.win32, canonicalWorkdir: r => r });
    const winJob = { ...spec, workdir: 'C:\\game', fileScope: { paths: ['Assets/Checkpoint.cs'] } };
    const winRun = winScopes.bind({ jobId: 'job', agentId: 'worker', workdir: 'C:\\game', getJob: () => winJob });
    assert.equal(winRun.guardPath('C:\\game\\Assets\\Checkpoint.cs', 'write'), 'C:\\game\\Assets\\Checkpoint.cs');
    assert.throws(() => winRun.guardPath('C:\\game\\..\\outside.cs', 'write'), /traversal/);
    console.log('routine-file-scope: PASS');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
