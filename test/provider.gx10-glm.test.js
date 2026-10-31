/* node test/provider.gx10-glm.test.js - named GX10 GLM profile and agent readiness gate. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const registry = require('../sidecar/providers/registry.js');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

module.exports = (async () => {
  const profile = registry.getProviderProfile('gx10-glm');
  A.ok(profile, 'GX10 GLM is registered');
  A.eq(profile.name, 'GX10 GLM · Colibri', 'operator-facing name is exact');
  A.eq(profile.baseUrl, 'http://127.0.0.1:11435/v1', 'named profile uses fixed loopback endpoint');
  A.eq(profile.authType, 'none', 'named profile is keyless');
  A.eq(profile.keyRequired, false, 'named profile never asks for a key');
  A.eq(profile.modelsPath, '/models', 'named profile discovers OpenAI-compatible models');
  A.eq(profile.maxOutputTokens, 2048, 'named profile caps output at the verified Colibri limit');
  A.eq(profile.connectTimeoutMs, 300000, 'named profile permits a long local cold start');
  A.eq(profile.supportsTools, false, 'tools fail closed until the readiness receipt matches');
  A.ok(profile.agentToolsAfterReceipt, 'profile declares the explicit receipt gate');

  for (const file of ['frontend/index.html', 'frontend/agent-station-demo.html']) {
    A.ok(source(file).includes('data-prov="gx10-glm"'), file + ' exposes GX10 GLM in the provider picker');
  }
  A.ok(source('frontend/app/app.js').includes("'gx10-glm': ['glm-5.2-colibri-e8-iq3']"), 'offline model fallback uses the fixed Colibri id');
  A.ok(source('frontend/app/overseer-setup.js').includes("'gx10-glm': ['GX10 GLM','Complex · local']"), 'onboarding describes the complex local provider');
  A.ok(source('frontend/app/stationui.js').includes("id: 'gx10-glm'"), 'Settings exposes a GX10 GLM provider card');
  A.ok(source('frontend/app/modeldock.js').includes("'gx10-glm': 'GX10 GLM'"), 'shared model picker labels GX10 GLM');
  A.ok(source('frontend/app/harness.js').includes("p === 'gx10-glm') return false"), 'fixed GX10 GLM endpoint never manufactures a stored credential');

  const readiness = require('../sidecar/providers/gx10-glm-readiness.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-glm-ready-'));
  const receiptPath = path.join(tmp, 'receipt.json');
  const previous = process.env.STARNET_GX10_GLM_AGENT_RECEIPT;
  process.env.STARNET_GX10_GLM_AGENT_RECEIPT = receiptPath;
  try {
    A.eq(readiness.isReady(profile), false, 'missing readiness receipt keeps tools disabled');
    fs.writeFileSync(receiptPath, JSON.stringify({
      providerId: profile.id,
      modelId: profile.staticModels[0].id,
      baseUrl: profile.baseUrl,
      starnetCommit: readiness.currentCommit(),
      profileVersion: profile.agentReadinessProfileVersion,
      passed: true
    }));
    A.eq(readiness.isReady(profile), true, 'matching commit/profile/model receipt enables tools');
    const stale = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    stale.starnetCommit = 'stale-commit';
    fs.writeFileSync(receiptPath, JSON.stringify(stale));
    A.eq(readiness.isReady(profile), false, 'stale StarNet commit fails closed');
  } finally {
    if (previous == null) delete process.env.STARNET_GX10_GLM_AGENT_RECEIPT;
    else process.env.STARNET_GX10_GLM_AGENT_RECEIPT = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  A.report('provider.gx10-glm.test');
})();
