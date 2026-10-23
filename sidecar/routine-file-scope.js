/* Operator-enrolled exact-file authority for one routine. No global cabinet grant, shell,
   connectors or delegation. The existing project guard and fs mutation receipts still run.
   Configuration comes only from the authenticated host cron route; run-time authority is
   re-read from that durable job, never from prompt text, tool arguments or a copied flag. */
'use strict';
const { parsePatch } = require('./tools/builtin/patchparse.js');
const READS = new Set(['fs.read', 'fs.list', 'fs.search']);
const WRITES = new Set(['fs.write', 'fs.append', 'fs.edit', 'fs.patch']);

function makeRoutineFileScopes({ fs, pathMod: P, canonicalWorkdir, protectedPath }) {
  function fail(message) { throw new Error('routine file scope: ' + message); }
  function normalize(raw, workdir) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected an object');
    if (raw.revoked === true) fail('approval was revoked by an agent-authored instruction change; operator re-enrollment required');
    if (raw.version != null && raw.version !== 1) fail('unsupported version');
    if (!workdir || !P.isAbsolute(workdir)) fail('workdir must be an approved absolute project folder');
    const root = canonicalWorkdir(workdir);
    if (root !== workdir || (raw.workdir != null && raw.workdir !== root)) fail('workdir changed; enroll the new exact root explicitly');
    if (!Array.isArray(raw.paths) || raw.paths.length < 1 || raw.paths.length > 64) fail('paths must contain 1–64 exact editable files');
    const paths = [];
    for (const rel of raw.paths) {
      if (typeof rel !== 'string' || !rel || rel !== rel.trim() || rel.length > 512
        || /[\x00-\x1f\\:*?<>|\[\]]/.test(rel) || P.isAbsolute(rel)
        || rel.split('/').some(p => !p || p === '.' || p === '..')) fail('paths must be exact relative file names without traversal, wildcards or backslashes');
      const abs = P.resolve(root, rel);
      const reason = protectedPath && protectedPath(abs, abs);
      if (reason) fail(reason);
      if (!paths.includes(rel)) paths.push(rel);
    }
    return { version: 1, workdir: root, paths: paths.sort() };
  }
  function constraints(job) {
    if (job.script || job.noAgent || job.runsLine) fail('scripts, script-only jobs and downstream lines are not permitted');
    if (job.unattendedGrants != null && (!Array.isArray(job.unattendedGrants) || job.unattendedGrants.length)) fail('no unattended workbench or connector grants are permitted');
    if (!Array.isArray(job.enabledToolsets) || job.enabledToolsets.length !== 1 || job.enabledToolsets[0] !== 'cabinet') fail('enabledToolsets must be exactly ["cabinet"]');
  }
  function configure(job, authority) {
    if (job.fileScope == null) return null;
    if (!authority || authority.host !== true) fail('only the authenticated host may enroll editable files');
    constraints(job);
    return normalize(job.fileScope, job.workdir);
  }
  function bind({ jobId, agentId, workdir, getJob, tainted }) {
    const initial = getJob(jobId);
    if (!initial || initial.fileScope == null) return null;
    const scope = configure(initial, { host: true });
    if (initial.agentId !== agentId || scope.workdir !== workdir) fail('agent or workdir does not match this routine');
    const signature = JSON.stringify([initial.agentId, String(initial.prompt || ''), scope]);
    function current() {
      const job = getJob(jobId);
      if (!job || job.enabled === false || job.fileScope == null) fail('approval was revoked or the routine was paused');
      if (tainted && tainted()) fail('external-content taint revoked this run’s file grant');
      const live = configure(job, { host: true });
      if (JSON.stringify([job.agentId, String(job.prompt || ''), live]) !== signature) fail('approved instruction or file scope changed; start a new run');
      return live;
    }
    // Check every ancestor, not only realpath(target): newly created files can have a symlinked parent.
    // Exact targets also reject hardlinks, which realpath alone cannot distinguish from ordinary files.
    function guardPath(raw, access) {
      const live = current();
      if (typeof raw !== 'string') fail('illegal path');
      // Native fs resolves project-relative inputs to host-native absolute paths. On Windows
      // those contain backslashes; accept that host form, but never alternate-separator relative paths.
      const checked = P.sep === '\\' && P.isAbsolute(raw) ? raw.replace(/\\/g, '/') : raw;
      if (/[\x00-\x1f\\]/.test(checked)) fail('illegal path');
      if (checked.split('/').includes('..')) fail('path traversal is not permitted');
      const abs = P.isAbsolute(raw) ? P.resolve(raw) : P.resolve(live.workdir, raw || '.');
      const rel = P.relative(live.workdir, abs).split(P.sep).join('/');
      if (rel === '..' || rel.startsWith('../') || P.isAbsolute(rel)) fail('path is outside the approved workdir');
      const reason = protectedPath && protectedPath(abs, abs);
      if (reason) fail(reason);
      if (access === 'write' && !live.paths.includes(rel)) fail('path is not one of the exact editable files');
      let cur = live.workdir;
      for (const part of rel.split('/').filter(Boolean)) {
        cur = P.join(cur, part);
        let stat;
        try { stat = fs.lstatSync(cur); } catch (e) { if (e && e.code === 'ENOENT') break; throw e; }
        if (stat.isSymbolicLink()) fail('symlink paths are not permitted');
        if (access === 'write' && cur === abs && (!stat.isFile() || stat.nlink > 1)) fail('editable target must be a regular file, not a directory or hardlink');
      }
      return abs;
    }
    function authorize(call, tool) {
      try {
        current();
        const name = call && call.name;
        if ((!READS.has(name) && !WRITES.has(name)) || !tool || tool.name !== name || tool.capability !== 'cabinet') fail('only native cabinet file tools are permitted');
        const write = WRITES.has(name);
        if (tool.scope !== (write ? 'write' : 'read')) fail('unexpected tool scope');
        const args = call.args || {};
        if (name === 'fs.patch') {
          const parsed = parsePatch(args.patch);
          if (!parsed.ok) fail(parsed.error);
          for (const op of parsed.operations) {
            guardPath(op.path, 'write');
            if (op.newPath) guardPath(op.newPath, 'write');
          }
        } else guardPath(args.path == null && !write ? '.' : args.path, write ? 'write' : 'read');
        return { ok: true };
      } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    }
    function consent(call, tool) {
      const result = authorize(call, tool);
      return { allow: result.ok, reason: result.ok ? 'operator-enrolled routine exact-file grant' : result.reason };
    }
    function restrict(resolved) {
      return { ...resolved, tools: (resolved.tools || []).filter(n => READS.has(n) || WRITES.has(n)) };
    }
    return { guardPath, authorize, consent, restrict, paths: scope.paths.slice(), workdir: scope.workdir };
  }
  return { configure, bind };
}

module.exports = { makeRoutineFileScopes };
