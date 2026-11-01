/* node test/provider.gx10-glm.test.js - named GX10 GLM profile and agent readiness gate. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const registry = require('../sidecar/providers/registry.js');
const factory = require('../sidecar/providers/factory.js');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

module.exports = (async () => {
  const profile = registry.getProviderProfile('gx10-glm');
  A.ok(profile, 'GX10 GLM is registered');
  A.eq(profile.name, 'GX10 GLM · Deep', 'operator-facing Deep name is exact');
  A.eq(profile.baseUrl, 'http://127.0.0.1:11435/v1', 'named profile uses fixed loopback endpoint');
  A.eq(profile.authType, 'none', 'named profile is keyless');
  A.eq(profile.keyRequired, false, 'named profile never asks for a key');
  A.eq(profile.modelsPath, '/models', 'named profile discovers OpenAI-compatible models');
  A.eq(profile.maxOutputTokens, 2048, 'named profile caps output at the verified Colibri limit');
  A.eq(profile.connectTimeoutMs, 300000, 'named profile permits a long local cold start');
  A.eq(profile.supportsTools, false, 'tools fail closed until the readiness receipt matches');
  A.ok(profile.agentToolsAfterReceipt, 'profile declares the explicit receipt gate');

  const fast = registry.getProviderProfile('gx10-glm-fast');
  A.ok(fast, 'GX10 GLM Fast is registered');
  A.eq(fast.baseUrl, 'http://127.0.0.1:11434/v1', 'Fast uses fixed loopback Ollama');
  A.eq(fast.staticModels[0].id, 'glm-4.7-flash:latest', 'Fast pins GLM 4.7 Flash');
  A.eq(fast.fixedReasoningEffort, 'none', 'Fast forces native thinking off');
  A.eq(fast.maxCtx, 131072, 'Fast permits the verified 131K model window');
  A.eq(fast.supportsTools, true, 'Fast exposes verified GLM tool calling');

  const reasoning = registry.getProviderProfile('gx10-glm-reasoning');
  A.ok(reasoning, 'GX10 GLM Reasoning is registered');
  A.eq(reasoning.baseUrl, 'http://127.0.0.1:11434/v1', 'Reasoning reuses fixed loopback Ollama');
  A.eq(reasoning.staticModels[0].id, 'glm-4.7-flash:latest', 'Reasoning pins the same GLM 4.7 Flash');
  A.eq(reasoning.fixedReasoningEffort, 'high', 'Reasoning forces native thinking on');
  A.eq(reasoning.maxCtx, 131072, 'Reasoning permits the verified 131K model window');
  A.eq(reasoning.supportsTools, true, 'Reasoning exposes verified GLM tool calling');

  async function nativeRequest(providerId, requestedEffort) {
    let requestBody = null;
    const fetch = async (url, init) => {
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'glm-4.7-flash:latest' }] }), { status: 200 });
      }
      if (url.endsWith('/api/show')) {
        return new Response(JSON.stringify({
          model_info: { 'glm4.context_length': 202752 },
          capabilities: ['completion', 'tools', 'thinking']
        }), { status: 200 });
      }
      if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (url.endsWith('/api/chat')) {
        requestBody = JSON.parse(init.body);
        return new Response('{"message":{"content":"OK"},"done":false}\n{"done":true}\n', {
          status: 200, headers: { 'content-type': 'application/x-ndjson' }
        });
      }
      throw new Error('unexpected URL ' + url);
    };
    const provider = factory.selectProvider({ provider: providerId, reasoningEffort: requestedEffort, fetch });
    for await (const _event of provider.stream({
      model: 'glm-4.7-flash:latest',
      messages: [{ role: 'user', content: 'Reply OK.' }],
      isTask: true
    })) {}
    return requestBody;
  }

  const fastWire = await nativeRequest('gx10-glm-fast', 'high');
  A.eq(fastWire.think, false, 'Fast keeps thinking off even when a stale agent setting asks for high');
  A.eq(fastWire.options.num_ctx, 8192, 'Fast uses StarNet native request-sized context');
  const reasoningWire = await nativeRequest('gx10-glm-reasoning', 'none');
  A.eq(reasoningWire.think, true, 'Reasoning keeps thinking on even when a stale agent setting asks for off');
  A.eq(reasoningWire.model, 'glm-4.7-flash:latest', 'Reasoning sends the installed Flash model ID');

  for (const file of ['frontend/index.html', 'frontend/agent-station-demo.html']) {
    for (const id of ['gx10-glm-fast', 'gx10-glm-reasoning', 'gx10-glm']) {
      A.ok(source(file).includes('data-prov="' + id + '"'), file + ' exposes ' + id + ' in the provider picker');
    }
  }
  const app = source('frontend/app/app.js');
  A.ok(app.includes("'gx10-glm-fast': ['glm-4.7-flash:latest']"), 'Fast offline fallback pins Flash');
  A.ok(app.includes("'gx10-glm-reasoning': ['glm-4.7-flash:latest']"), 'Reasoning offline fallback pins Flash');
  A.ok(app.includes("'gx10-glm': ['glm-5.2-colibri-e8-iq3']"), 'Deep offline fallback pins Colibri');
  for (const file of ['frontend/app/modeldock.js', 'frontend/app/stationui.js']) {
    const ui = source(file);
    A.ok(ui.includes('gx10-glm-fast') && ui.includes('gx10-glm-reasoning') && ui.includes('gx10-glm'), file + ' exposes all named GX10 choices');
  }
  const rust = source('src-tauri/src/credentials.rs');
  A.ok(rust.includes('"gx10-glm-fast"') && rust.includes('"gx10-glm-reasoning"') && rust.includes('"gx10-glm"'), 'desktop credentials preserve all GX10 provider IDs');

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
