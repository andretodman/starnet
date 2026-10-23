/* Regression B-ollama-window (2026-10-23): CreativeShelf's local Qwen refused 44011 tokens against 40960.
   V-ollama-window: provider-reported counts set the smaller recovery budget; cold /api/show facts lower the
   next preflight budget without replaying completed tools. Real native adapter + loop, fake fetch, no network. */
'use strict';
const A = require('./_assert.js');
const F = require('../sidecar/compaction-fidelity.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');

const LIMIT = 40960;
const MODEL = 'qwen3:8b';
const OVERFLOW = 'request (44011 tokens) exceeds the available context size (40960 tokens), try increasing it';
const ERROR = { error: { code: 400, message: OVERFLOW, type: 'exceed_context_size_error', n_prompt_tokens: 44011, n_ctx: LIMIT } };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const ndjson = row => new Response(JSON.stringify(row) + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
const answer = () => ndjson({ message: { role: 'assistant', content: 'Finished the requested check.' }, done: true, done_reason: 'stop', prompt_eval_count: 10000, eval_count: 10 });
const tools = [{ type: 'function', function: { name: 'fixture_action', description: 'Complete one fixture action', parameters: { type: 'object', properties: {} } } }];

function seed(chars = 6000) {
  return [
    { role: 'system', content: 'You are a station agent. Never change production.' },
    { role: 'user', content: 'Inspect the fixture once, preserve production, and report.' },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: 'Earlier observation ' + i + ': ' + 'x'.repeat(chars) })),
    { role: 'user', content: 'Continue the existing work; do not repeat completed actions.' }
  ];
}

function nativeFixture(script, suffix) {
  const posts = [];
  const fetch = async (url, init) => {
    if (url.endsWith('/v1/models')) return json({ data: [{ id: MODEL }] });
    if (url.endsWith('/api/show')) return json({ model_info: { 'qwen3.context_length': LIMIT }, capabilities: ['completion', 'tools'] });
    if (url.endsWith('/api/ps')) return json({ models: [] });
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(init.body);
      posts.push(body);
      return script(body, posts.length);
    }
    throw new Error('Unexpected fixture URL: ' + url);
  };
  return {
    posts,
    provider: makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://ollama-' + suffix + '.fixture.invalid:11434/v1', nativeOllama: true, maxTokens: 4096 })
  };
}

function options(provider, context) {
  return { provider, context, contextLimit: 0, cost: makeCostEngine({ priceOf: () => null }),
    model: MODEL, agentId: 'a', runId: 'r', sleep: async () => {}, random: () => 0.5,
    summarize: async () => 'Earlier observations reviewed. Production must stay unchanged; continue the existing task.',
    microCompaction: false, limits: { maxIters: 5 } };
}

module.exports = (async () => {
  // The escaped envelope is exactly Ollama's native error shape; a generic OpenAI-compatible label does not
  // mean a paid provider was involved. Classification already worked; numeric adoption was missing.
  for (const text of [OVERFLOW, JSON.stringify(ERROR), JSON.stringify({ error: JSON.stringify(ERROR) }),
    'openai-compatible http 400 - ' + JSON.stringify({ error: JSON.stringify(ERROR) }),
    'request (44,011 tokens) exceeds the available context size (40,960 tokens)']) {
    A.eq(F.reportedWindow(text), { used: 44011, limit: LIMIT }, 'V-ollama-window reads actual prompt/window counts: ' + text.slice(0, 65));
  }
  A.eq(F.reportedWindow(JSON.stringify({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 44011, n_ctx: LIMIT } })),
    { used: 44011, limit: LIMIT }, 'typed numeric-only error is authoritative too');
  A.eq(F.reportedWindow(JSON.stringify({ error: JSON.stringify({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 44011, n_ctx: LIMIT } }) })),
    { used: 44011, limit: LIMIT }, 'escaped numeric-only error keeps the counts');
  for (const text of ['model not found', '{"n_prompt_tokens":44011,"n_ctx":40960}',
    'request (44011 tokens) exceeds the available context size (0 tokens)',
    'request (44011 tokens) exceeds the available context size (999999999 tokens)']) {
    A.eq(F.reportedWindow(text), null, 'unrelated or invalid count is not a window: ' + text);
  }
  const err = Object.assign(new Error('openai-compatible http 400 - ' + JSON.stringify({ error: JSON.stringify(ERROR) })), { status: 400 });
  A.eq(classifyApiError(err).reason, 'context_overflow', 'the exact observed failure is an overflow, not billing');

  // Cold catalog -> native refusal -> calibrated fold -> the same model retries with a smaller prompt.
  {
    const ctx = makeContext(Object.assign({ contextLimit: 131072 }, RUN_CONTEXT_DEFAULTS));
    const up = nativeFixture((body, n) => n === 1 ? json({ error: JSON.stringify(ERROR) }, 400) : answer(), 'overflow');
    A.eq(up.provider.contextLimit(MODEL), 0, 'fixture starts with a genuinely cold catalog');
    const events = [], recoveries = [];
    const res = await runAgentLoop(Object.assign(options(up.provider, ctx), {
      messages: seed(15000), emit: (name, payload) => events.push({ name, payload }), onRecovery: row => recoveries.push(row)
    }));
    A.eq(res.reason, 'done', 'V-ollama-window: native nested refusal recovers within the same run');
    A.eq(ctx.contextLimit, LIMIT, 'the real 40960 ceiling replaces the cold 131072 fallback');
    A.eq(up.posts.length, 2, 'exactly one refused POST and one folded retry, never a blind retry ladder');
    A.ok(JSON.stringify(up.posts[1].messages).length < JSON.stringify(up.posts[0].messages).length, 'the actual retried wire prompt shrank');
    A.ok(JSON.stringify(up.posts[1].messages).includes('Production must stay unchanged'), 'the recovered wire carries the summary constraint');
    A.eq(recoveries.map(r => r.action), ['compress'], 'only compaction recovery, no hidden fallback');
    A.eq(events.filter(e => e.name === 'agent.run.error').length, 0, 'no terminal error on a recovered run');
    A.ok(up.posts.every(p => p.truncate === false && p.options.num_ctx <= LIMIT), 'native truncation stays disabled and context never expands beyond the model');
  }

  // /api/show warms DURING a successful first call. Its smaller limit must govern the very next preflight,
  // including result growth. No overflow is required to learn it and the completed effect must run once only.
  {
    const ctx = makeContext(Object.assign({ contextLimit: 131072 }, RUN_CONTEXT_DEFAULTS));
    const up = nativeFixture((body, n) => n === 1 ? ndjson({
      message: { role: 'assistant', content: '', tool_calls: [{ id: 'effect-1', function: { name: 'fixture_action', arguments: {} } }] },
      done: true, done_reason: 'stop', prompt_eval_count: 20000, eval_count: 10
    }) : answer(), 'preflight');
    let effects = 0, folds = 0;
    const res = await runAgentLoop(Object.assign(options(up.provider, ctx), {
      messages: seed(), tools,
      dispatch: async () => { effects++; return { ok: true, content: 'Action already completed. ' + 'r'.repeat(60000) }; },
      emit: name => { if (name === 'agent.compact') folds++; }
    }));
    A.eq(res.reason, 'done', 'V-ollama-window: successful tool run continues after a proactive fold');
    A.eq(ctx.contextLimit, LIMIT, 'newly learned model window reaches the existing context manager');
    A.ok(folds >= 1, 'new smaller limit triggers preflight without waiting for a 400');
    A.eq(effects, 1, 'completed tool effect is never replayed by budget synchronization');
    A.eq(up.posts.length, 2, 'one tool request and one continuation, no restarted prompt');
    A.ok(JSON.stringify(up.posts[1].messages).includes('conversation_summary'), 'the second actual native request carries the fold');
    A.ok(JSON.stringify(up.posts[1].messages).includes('do not repeat completed actions'), 'latest user instruction survives');
  }

  // This refresh may only LOWER a budget; a known tighter bound and a cold provider are preserved.
  for (const reported of [0, 131072, Infinity, NaN]) {
    const ctx = makeContext({ contextLimit: LIMIT });
    const provider = { contextLimit: () => reported, stream: async function* () { yield { type: 'text', delta: 'Finished.' }; yield { type: 'done', finishReason: 'stop' }; } };
    await runAgentLoop(Object.assign(options(provider, ctx), { messages: [{ role: 'user', content: 'Hello' }], emit: () => {} }));
    A.eq(ctx.contextLimit, LIMIT, 'a larger/unknown/nonfinite provider value cannot expand the budget: ' + reported);
  }
  A.report('loop.overflow.ollama.test');
})().catch(e => { console.error(e); process.exit(1); });
