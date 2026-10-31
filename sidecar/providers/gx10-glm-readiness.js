/* Commit-bound readiness receipt for GX10 GLM agent tools. Chat remains available without it. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function receiptPath() {
  return process.env.STARNET_GX10_GLM_AGENT_RECEIPT
    || path.join(os.homedir(), '.local', 'state', 'starnet', 'gx10-glm-agent-ready.json');
}

function currentCommit() {
  if (process.env.STARNET_BUILD_COMMIT) return String(process.env.STARNET_BUILD_COMMIT).trim();
  try {
    const git = path.resolve(__dirname, '..', '..', '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5).trim();
    const loose = path.join(git, ...ref.split('/'));
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split(/\r?\n/);
    const row = packed.find(line => line && !line.startsWith('#') && line.endsWith(' ' + ref));
    return row ? row.split(' ')[0] : '';
  } catch (_) { return ''; }
}

function isReady(profile) {
  if (!profile || !profile.agentToolsAfterReceipt) return false;
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath(), 'utf8'));
    const commit = currentCommit();
    return receipt.passed === true
      && !!commit
      && receipt.starnetCommit === commit
      && receipt.providerId === profile.id
      && receipt.modelId === String(profile.staticModels && profile.staticModels[0] && profile.staticModels[0].id || '')
      && receipt.baseUrl === profile.baseUrl
      && receipt.profileVersion === profile.agentReadinessProfileVersion;
  } catch (_) { return false; }
}

module.exports = { currentCommit, isReady, receiptPath };
