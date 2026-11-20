import assert from 'node:assert/strict';
import test from 'node:test';
import { backendHarness } from './backend-harness.mjs';
import { extractModelSteps } from '../trajectory-metrics.mjs';

function mkUserStep(text, createdAt, stepIndex = 0) {
  return {
    stepIndex,
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt,
      sourceTrajectoryStepInfo: { stepIndex },
    },
    userInput: { userResponse: text },
  };
}

function mkPlannerStep({
  stepIndex,
  createdAt,
  finishedGeneratingAt,
  model = 'MODEL_PLACEHOLDER_M429',
  modelDisplayName = 'Gemini 4 Carbon (High)',
  responseModel = 'gemini-4-carbon',
  inputTokens = 1000,
  cacheReadTokens = 0,
  thinkingTokens = 400,
  responseTokens = 600,
  ttft = '2s',
  thinkingDuration = '4s',
  response = 'done',
  thinking = 'reasoning trace',
  toolCalls = [],
} = {}) {
  const out = thinkingTokens + responseTokens;
  return {
    status: 'CORTEX_STEP_STATUS_DONE',
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: {
      createdAt,
      finishedGeneratingAt,
      sourceTrajectoryStepInfo: { stepIndex },
      modelUsage: {
        model,
        inputTokens: String(inputTokens),
        cacheReadTokens: String(cacheReadTokens),
        outputTokens: String(out),
        thinkingOutputTokens: String(thinkingTokens),
        responseOutputTokens: String(responseTokens),
      },
      generatorMetadata: [
        {
          chatModel: {
            model,
            responseModel,
            modelDisplayName,
            timeToFirstToken: ttft,
            streamingDuration: '3s',
          },
        },
      ],
    },
    plannerResponse: {
      response,
      thinking,
      thinkingDuration,
      toolCalls,
    },
  };
}

function mkToolResult(name, content = 'ok', status = 'CORTEX_STEP_STATUS_DONE', extra = {}) {
  return {
    type: 'GENERIC',
    status,
    content,
    metadata: { toolCall: { name } },
    ...extra,
  };
}

test('Inference health stays healthy across >=180s TTL gaps, 90%+ prefix shifts, ByteOffset/Partial-read pagination, .jsonl logs, and single TDD failure', async () => {
  const rawSteps = [
    mkUserStep('读取代码与长日志分片并跑单测', '2026-01-01T00:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T00:00:01Z',
      finishedGeneratingAt: '2026-01-01T00:00:10Z',
      cacheReadTokens: 120000,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/app.js', StartLine: 1, EndLine: 200 } },
        { name: 'read_file', args: { Path: '/repo/src/bundle.min.js', StartLine: 1, EndLine: 50 } },
      ],
    }),
    mkToolResult('read_file', 'lines 1-200'),
    mkToolResult(
      'read_file',
      'Partial read (lines 1-10 of 50). Showing bytes 0-46080 of 180000 in this line range, truncated at the 46080-byte limit.'
    ),

    // ByteOffset continuation & truncated StartLine advance + dynamic .jsonl transcript read -> ZERO false 重读!
    // Also transient <SYSTEM_MESSAGE> removal shrinks cacheReadTokens by 9k (still 93% hit) -> ZERO false 切流!
    mkPlannerStep({
      stepIndex: 4,
      createdAt: '2026-01-01T00:00:12Z',
      finishedGeneratingAt: '2026-01-01T00:00:20Z',
      inputTokens: 8500,
      cacheReadTokens: 111000,
      toolCalls: [
        {
          name: 'read_file',
          args: { Path: '/repo/src/bundle.min.js', StartLine: 1, EndLine: 50, ByteOffset: 46080 },
        },
        {
          name: 'read_file',
          args: { Path: '/repo/src/bundle.min.js', StartLine: 11, EndLine: 50 },
        },
        {
          name: 'read_file',
          args: { Path: '/brain/abc/.system_generated/logs/transcript.jsonl', StartLine: 100, EndLine: 150 },
        },
        {
          name: 'read_file',
          args: { Path: '/brain/abc/.system_generated/logs/transcript.jsonl', StartLine: 110, EndLine: 150 },
        },
      ],
    }),
    mkToolResult('read_file', 'bytes 46080-92160'),
    mkToolResult('read_file', 'lines 11-50'),
    mkToolResult('read_file', 'jsonl chunk 1'),
    mkToolResult('read_file', 'jsonl chunk 2'),

    // Edit file -> read back same range to verify edit + single failing npm test (must NOT alert)
    mkPlannerStep({
      stepIndex: 9,
      createdAt: '2026-01-01T00:00:22Z',
      finishedGeneratingAt: '2026-01-01T00:00:30Z',
      cacheReadTokens: 124000,
      toolCalls: [
        { name: 'edit_file', args: { Path: '/repo/src/app.js', Target: 'a', Replacement: 'b' } },
      ],
    }),
    mkToolResult('edit_file', 'Made 1 replacement'),
    mkPlannerStep({
      stepIndex: 11,
      createdAt: '2026-01-01T00:00:32Z',
      finishedGeneratingAt: '2026-01-01T00:00:40Z',
      cacheReadTokens: 126000,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/app.js', StartLine: 1, EndLine: 200 } },
        { name: 'run_command', args: { CommandLine: 'npm test' } },
      ],
    }),
    mkToolResult('read_file', 'verified lines 1-200'),
    mkToolResult('run_command', 'AssertionError: expected 1 to equal 2', 'CORTEX_STEP_STATUS_ERROR'),

    // Natural cache TTL expiry after 4 minutes (240s >= 180s) + structured error object auto-retry that recovers cleanly
    mkUserStep('继续修复并重跑单测', '2026-01-01T00:04:45Z', 14),
    {
      stepIndex: 15,
      type: 'ERROR_MESSAGE',
      status: 'DONE',
      error: { code: 503, message: 'UNAVAILABLE: upstream backend overloaded' },
    },
    mkPlannerStep({
      stepIndex: 16,
      createdAt: '2026-01-01T00:04:48Z',
      finishedGeneratingAt: '2026-01-01T00:04:58Z',
      inputTokens: 130000,
      cacheReadTokens: 0,
      thinkingTokens: 480,
      responseTokens: 520,
      toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    }),
    mkToolResult('run_command', 'all tests passed', 'CORTEX_STEP_STATUS_DONE'),
  ];

  const h = backendHarness({
    trajectories: { clean1: { trajectory: { steps: rawSteps }, numTotalSteps: rawSteps.length } },
    summaries: {
      clean1: {
        stepCount: rawSteps.length,
        lastModifiedTime: '2026-01-01T00:04:58Z',
        status: 'IDLE',
        annotations: { title: 'Clean Session' },
      },
    },
  });
  const payload = await h.buildTelemetryPayloadInternal('clean1');
  const health = payload.activeConversation.inferenceHealth;
  assert.equal(health.activeAlert, null, 'Confounder events must produce zero false alerts');
  assert.equal(health.anomalyStepCount, 0);
  assert.equal(health.anomalyTurnCount, 0);
  assert.equal(health.sessionStateLabel, '正常');

  const step16 = payload.activeConversation.recentSteps.find((s) => s.stepIndex === 16);
  assert.equal(step16.cacheZeroReason, 'ttl_expired');
  assert.ok(!step16.infraNote.includes('[object Object]'), 'Structured error object must never serialize as [object Object]');
  assert.match(step16.infraNote, /503|网关/);
});

test('Causal contagion (#1807 archetype): detects TTFT stall + thinking squeeze, traces downstream script crash & zero-think patching, and resolves live banner after deep-thought recovery', () => {
  const baseSteps = [
    mkUserStep('核查模块并运行全量审计脚本', '2026-11-18T19:58:45Z', 1793),
    mkPlannerStep({
      stepIndex: 1794,
      createdAt: '2026-11-18T19:58:46Z',
      finishedGeneratingAt: '2026-11-18T19:59:00Z',
      inputTokens: 2868,
      cacheReadTokens: 499405,
      thinkingTokens: 903,
      responseTokens: 719,
      ttft: '9.3s',
      thinkingDuration: '18.0s',
      thinking: 'Deep initial reasoning '.repeat(35),
    }),
    mkPlannerStep({
      stepIndex: 1801,
      createdAt: '2026-11-18T19:59:01Z',
      finishedGeneratingAt: '2026-11-18T19:59:07Z',
      inputTokens: 4000,
      cacheReadTokens: 45000,
      thinkingTokens: 320,
      responseTokens: 220,
      ttft: '5.6s',
      thinkingDuration: '5.8s',
      thinking: 'Checking transcript offsets '.repeat(12),
    }),
    // #1803: healthy deep thinking (2197 tok), but RPC runCommand exits with code 1 (ESM URL scheme error)
    mkPlannerStep({
      stepIndex: 1803,
      createdAt: '2026-11-18T19:59:08Z',
      finishedGeneratingAt: '2026-11-18T19:59:46Z',
      inputTokens: 4307,
      cacheReadTokens: 47026,
      thinkingTokens: 2197,
      responseTokens: 769,
      ttft: '8.9s',
      thinkingDuration: '32.5s',
      thinking: 'Thorough audit planning '.repeat(80),
      toolCalls: [
        { name: 'run_command', args: { CommandLine: 'node --input-type=module -e "import \'C:/bad.mjs\'"' } },
      ],
    }),
    {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_DONE',
      runCommand: {
        exitCode: 1,
        combinedOutput: {
          full: "Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported. Received protocol 'c:'",
        },
      },
    },
    // #1807: TTFT stalls 35.9s, thinkingDuration 37.5s, thinking collapses to 171 tok (4.6 tok/s)!
    mkPlannerStep({
      stepIndex: 1807,
      createdAt: '2026-11-18T19:59:49Z',
      finishedGeneratingAt: '2026-11-18T20:00:34Z',
      inputTokens: 19273,
      cacheReadTokens: 51334,
      thinkingTokens: 171,
      responseTokens: 782,
      ttft: '35.9s',
      thinkingDuration: '37.5s',
      thinking: 'Origin and upstream push URLs are now disabled. The audit script will be used next.',
      toolCalls: [
        { name: 'run_command', args: { CommandLine: 'node --input-type=module -e "console.log(1)"' } },
      ],
    }),
    {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_DONE',
      runCommand: { exitCode: 0, combinedOutput: { full: '1' } },
    },
  ];

  const h = backendHarness();

  // Stage 1: Right after #1807 finishes (since #1803/#1806 had an unresolved fault, #1807 alerts immediately as 卡顿缩水!)
  const stepsAt1807 = extractModelSteps(baseSteps, []);
  const diagAt1807 = h.evaluateAgentInferenceHealth(stepsAt1807);
  assert.ok(diagAt1807.activeAlert, '#1807 after prior error should immediately alert');
  assert.equal(diagAt1807.activeAlert.badge, '卡顿缩水');
  assert.equal(diagAt1807.activeAlert.stateLabel, '预警');
  assert.equal(diagAt1807.activeAlert.anchorStepIndex, 1807);

  // Stage 2: Downstream contagion hits #1810 (SyntaxError) and #1813 (0 visible thinking)
  const stepsWithContagion = [
    ...baseSteps,
    mkPlannerStep({
      stepIndex: 1810,
      createdAt: '2026-11-18T20:00:37Z',
      finishedGeneratingAt: '2026-11-18T20:01:03Z',
      inputTokens: 5727,
      cacheReadTokens: 70608,
      thinkingTokens: 240,
      responseTokens: 1376,
      ttft: '8.2s',
      thinkingDuration: '11.5s',
      thinking: 'Quick follow-up without reading local-scanner exports',
      toolCalls: [
        {
          name: 'run_command',
          args: { CommandLine: 'node --input-type=module -e "import { parseTranscriptSteps } from \'file:///scanner.mjs\'"' },
        },
      ],
    }),
    {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_DONE',
      runCommand: {
        exitCode: 1,
        combinedOutput: {
          full: "SyntaxError: The requested module 'file:///scanner.mjs' does not provide an export named 'parseTranscriptSteps'",
        },
      },
    },
    mkPlannerStep({
      stepIndex: 1813,
      createdAt: '2026-11-18T20:01:07Z',
      finishedGeneratingAt: '2026-11-18T20:01:23Z',
      inputTokens: 4959,
      cacheReadTokens: 76336,
      thinkingTokens: 39,
      responseTokens: 997,
      ttft: '16.2s',
      thinkingDuration: '16.2s',
      thinking: '',
      toolCalls: [
        { name: 'run_command', args: { CommandLine: 'node --input-type=module -e "console.log(2)"' } },
      ],
    }),
    {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_DONE',
      runCommand: { exitCode: 0, combinedOutput: { full: '2' } },
    },
  ];

  const extractedContagion = extractModelSteps(stepsWithContagion, []);
  const diagAt1813 = h.evaluateAgentInferenceHealth(extractedContagion);
  assert.ok(diagAt1813.activeAlert);
  assert.equal(diagAt1813.activeAlert.category, 'degraded_contagion');
  assert.equal(diagAt1813.activeAlert.badge, '劣化传染');
  assert.equal(diagAt1813.activeAlert.level, 'critical');
  assert.equal(diagAt1813.activeAlert.stateLabel, '失控');
  assert.equal(diagAt1813.activeAlert.anchorStepIndex, 1807, 'Root cause anchors back to #1807');
  assert.ok(diagAt1813.activeAlert.reasons[0].includes('#1807'));
  assert.ok(diagAt1813.activeAlert.reasons.some((r) => r.includes('#1810')));
  assert.ok(diagAt1813.activeAlert.reasons.some((r) => r.includes('#1813')));

  const st1807 = extractedContagion.find((s) => s.stepIndex === 1807);
  assert.match(st1807.stepHealthDetail, /传导至 #1810, #1813/);

  // Stage 3: 4 consecutive clean deep-thinking steps (#1817..#1826) heal the live banner while preserving step badges
  const healedRaw = [
    ...stepsWithContagion,
    ...[1817, 1820, 1823, 1826].map((idx, k) =>
      mkPlannerStep({
        stepIndex: idx,
        createdAt: `2026-11-18T20:0${2 + k}:00Z`,
        finishedGeneratingAt: `2026-11-18T20:0${2 + k}:35Z`,
        inputTokens: 4500,
        cacheReadTokens: 86000 + k * 5000,
        thinkingTokens: 1200,
        responseTokens: 1100,
        ttft: '9.0s',
        thinkingDuration: '28.0s',
        thinking: 'Restored deep analysis '.repeat(60),
      })
    ),
  ];
  const extractedHealed = extractModelSteps(healedRaw, []);
  const diagHealed = h.evaluateAgentInferenceHealth(extractedHealed);
  assert.equal(diagHealed.activeAlert, null, 'Sustained deep-thought recovery clears live banner');
  assert.equal(diagHealed.turnDiagnoses[0].isResolved, true);
  assert.equal(
    extractedHealed.find((s) => s.stepIndex === 1807).stepHealthBadge,
    '卡顿缩水',
    'Historical step badge on #1807 remains preserved in table'
  );
});

test('Graded watch window: read-only stall-squeeze starts as notice (浅思) and promotes to warn (劣化传染) only if downstream fails', () => {
  const mkBase = () => [
    mkUserStep('先阅读相关配置', '2026-01-01T01:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T01:00:01Z',
      finishedGeneratingAt: '2026-01-01T01:00:15Z',
      cacheReadTokens: 80000,
      thinkingTokens: 800,
      responseTokens: 500,
      ttft: '6.0s',
      thinkingDuration: '11.0s',
      thinking: 'Normal deep thinking '.repeat(30),
    }),
    mkPlannerStep({
      stepIndex: 2,
      createdAt: '2026-01-01T01:00:16Z',
      finishedGeneratingAt: '2026-01-01T01:00:30Z',
      cacheReadTokens: 82000,
      thinkingTokens: 750,
      responseTokens: 480,
      ttft: '6.5s',
      thinkingDuration: '11.0s',
      thinking: 'Normal deep thinking '.repeat(30),
    }),
    // Step 3: pure read_file with 28s TTFT stall + shallow 90-tok thinking, NO prior error
    mkPlannerStep({
      stepIndex: 3,
      createdAt: '2026-01-01T01:00:32Z',
      finishedGeneratingAt: '2026-01-01T01:01:05Z',
      cacheReadTokens: 84000,
      thinkingTokens: 90,
      responseTokens: 520,
      ttft: '28.0s',
      thinkingDuration: '29.0s',
      thinking: 'Brief read',
      toolCalls: [{ name: 'read_file', args: { Path: '/repo/src/cfg.js', StartLine: 1, EndLine: 100 } }],
    }),
    mkToolResult('read_file', 'cfg lines'),
  ];

  const h = backendHarness();
  const quietSteps = extractModelSteps(mkBase(), []);
  const quietDiag = h.evaluateAgentInferenceHealth(quietSteps);
  assert.equal(quietSteps[2].stepHealthLevel, 'notice');
  assert.equal(quietSteps[2].stepHealthBadge, '浅思');
  assert.equal(quietDiag.activeAlert, null, 'Pure read-only shallow step stays in notice watch mode without nagging banner');

  // Now within the 4-step window, Step 5 fails an edit_file -> promotes Step 3 to warn 卡顿缩水 and raises 劣化传染!
  const infectedSteps = extractModelSteps([
    ...mkBase(),
    mkPlannerStep({
      stepIndex: 5,
      createdAt: '2026-01-01T01:01:08Z',
      finishedGeneratingAt: '2026-01-01T01:01:18Z',
      cacheReadTokens: 86000,
      thinkingTokens: 180,
      responseTokens: 500,
      ttft: '6.0s',
      thinkingDuration: '8.0s',
      toolCalls: [{ name: 'edit_file', args: { Path: '/repo/src/cfg.js', Target: 'bad', Replacement: 'new' } }],
    }),
    mkToolResult('edit_file', 'Target not found', 'CORTEX_STEP_STATUS_ERROR'),
  ], []);
  const escDiag = h.evaluateAgentInferenceHealth(infectedSteps);
  assert.equal(infectedSteps[2].stepHealthLevel, 'warn');
  assert.equal(infectedSteps[2].stepHealthBadge, '卡顿缩水');
  assert.ok(escDiag.activeAlert);
  assert.equal(escDiag.activeAlert.badge, '劣化传染');
  assert.equal(escDiag.activeAlert.anchorStepIndex, 3);
});

test('Symptom-free cold cache drops record quiet billing notes without false anomaly alerts, while timeout + zero-think code edit alerts', () => {
  const h = backendHarness();

  // Symptom-free short-idle cold cache drop -> zero anomaly steps, zero activeAlert, billing note on cache column
  const benignColdSteps = extractModelSteps([
    mkUserStep('正常连续对话', '2026-01-01T06:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T06:00:00Z',
      finishedGeneratingAt: '2026-01-01T06:00:10Z',
      cacheReadTokens: 64000,
      inputTokens: 1000,
      thinkingTokens: 420,
      responseTokens: 400,
    }),
    mkPlannerStep({
      stepIndex: 2,
      createdAt: '2026-01-01T06:00:25Z',
      finishedGeneratingAt: '2026-01-01T06:00:35Z',
      cacheReadTokens: 0,
      inputTokens: 65000,
      thinkingTokens: 410,
      responseTokens: 400,
    }),
  ], []);
  const coldDiag = h.evaluateAgentInferenceHealth(benignColdSteps);
  assert.equal(coldDiag.activeAlert, null, 'Pure billing cache drop with healthy thinking must NOT raise alert');
  assert.equal(coldDiag.anomalyStepCount, 0);
  assert.equal(benignColdSteps[1].isColdCacheBilling, true);
  assert.match(benignColdSteps[1].cacheNote, /冷缓存重算/);

  // HTTP2 timeout + collapsed 0-thinking heavy edit -> raises 卡顿缩水 alert!
  const shockEditSteps = extractModelSteps([
    mkUserStep('常规规划', '2026-01-01T01:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T01:00:01Z',
      finishedGeneratingAt: '2026-01-01T01:00:12Z',
      inputTokens: 3000,
      cacheReadTokens: 274533,
      thinkingTokens: 800,
      responseTokens: 500,
    }),
    mkUserStep('开始修改视图', '2026-01-01T01:00:18Z', 2),
    {
      stepIndex: 3,
      type: 'ERROR_MESSAGE',
      status: 'DONE',
      error: 'API error (attempt 1): http2: timeout awaiting response headers',
    },
    mkPlannerStep({
      stepIndex: 4,
      createdAt: '2026-01-01T01:00:35Z',
      finishedGeneratingAt: '2026-01-01T01:00:55Z',
      inputTokens: 14764,
      cacheReadTokens: 264595,
      thinkingTokens: 0,
      responseTokens: 6227,
      thinkingDuration: '0.1s',
      thinking: '',
      toolCalls: [
        { name: 'edit_file', args: { Path: '/repo/src/StepsDetailView.js', Target: 'a', Replacement: 'b' } },
      ],
    }),
    mkToolResult('edit_file', 'ok'),
  ], []);
  const shockDiag = h.evaluateAgentInferenceHealth(shockEditSteps);
  assert.ok(shockDiag.activeAlert);
  assert.equal(shockDiag.activeAlert.category, 'degraded_contagion');
  assert.equal(shockDiag.activeAlert.anchorStepIndex, 4);
});

test('Endogenous detectors: context_rot (/compact), worker_handoff + git rollback, same-region thrashing, consecutive test-failure loop, read-only stall, and identical-tool loop', () => {
  const h = backendHarness();

  // 1. High-context static amnesia + edit failure -> context_rot with /compact
  const rotSteps = extractModelSteps([
    mkUserStep('在超大上下文里定位修改', '2026-01-01T02:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T02:00:01Z',
      finishedGeneratingAt: '2026-01-01T02:00:10Z',
      inputTokens: 5000,
      cacheReadTokens: 215000,
      toolCalls: [{ name: 'read_file', args: { Path: '/repo/src/core.js', StartLine: 1, EndLine: 180 } }],
    }),
    mkToolResult('read_file', 'lines 1-180'),
    mkPlannerStep({
      stepIndex: 3,
      createdAt: '2026-01-01T02:00:14Z',
      finishedGeneratingAt: '2026-01-01T02:00:25Z',
      inputTokens: 6000,
      cacheReadTokens: 218000,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/core.js', StartLine: 1, EndLine: 180 } },
        { name: 'edit_file', args: { Path: '/repo/src/core.js', Target: 'missing snippet', Replacement: 'fixed' } },
      ],
    }),
    mkToolResult('read_file', 'lines 1-180 again'),
    mkToolResult('edit_file', 'Target not found', 'CORTEX_STEP_STATUS_ERROR'),
  ], []);
  const rotDiag = h.evaluateAgentInferenceHealth(rotSteps);
  assert.ok(rotDiag.activeAlert);
  assert.equal(rotDiag.activeAlert.category, 'context_rot');
  assert.equal(rotDiag.activeAlert.primaryAction.copyText, '/compact');

  // 2. Worker handoff fault + git rollback confirmation
  const workerRaw = [
    mkUserStep('设计并执行修改', '2026-01-01T03:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T03:00:01Z',
      finishedGeneratingAt: '2026-01-01T03:00:10Z',
      cacheReadTokens: 40000,
      toolCalls: [{ name: 'exit_plan_mode', args: {} }],
    }),
    mkToolResult('exit_plan_mode', 'ok'),
    { stepIndex: 3, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: this turn runs on the execution model.' },
    mkPlannerStep({
      stepIndex: 4,
      createdAt: '2026-01-01T03:00:15Z',
      finishedGeneratingAt: '2026-01-01T03:00:25Z',
      inputTokens: 42000,
      thinkingTokens: 0,
      thinking: '',
      responseTokens: 600,
      toolCalls: [
        { name: 'edit_file', args: { Path: '/repo/src/ui.js', Target: 'wrong', Replacement: 'x' } },
        { name: 'run_command', args: { CommandLine: 'python -c "import json; json.loads(\'bad)"' } },
      ],
    }),
    mkToolResult('edit_file', 'Target not found', 'CORTEX_STEP_STATUS_ERROR'),
    mkToolResult('run_command', 'SyntaxError: unterminated string literal', 'CORTEX_STEP_STATUS_ERROR'),
  ];
  const wDiag = h.evaluateAgentInferenceHealth(extractModelSteps(workerRaw, []));
  assert.equal(wDiag.activeAlert?.category, 'worker_handoff');

  const rolledSteps = extractModelSteps([
    ...workerRaw,
    mkUserStep('做法很糟糕，打断并回滚', '2026-01-01T03:01:00Z', 7),
    mkPlannerStep({
      stepIndex: 8,
      createdAt: '2026-01-01T03:01:02Z',
      finishedGeneratingAt: '2026-01-01T03:01:08Z',
      cacheReadTokens: 42000,
      toolCalls: [{ name: 'run_command', args: { CommandLine: 'git checkout HEAD -- src/ui.js' } }],
    }),
    mkToolResult('run_command', 'Updated 1 path'),
  ], []);
  const rolledDiag = h.evaluateAgentInferenceHealth(rolledSteps);
  assert.equal(rolledDiag.turnDiagnoses.find((d) => d.turnIndex === 1).level, 'critical');
  assert.equal(rolledDiag.activeAlert, null);

  // 3. Consecutive failing npm test (>=3) triggers 测试连败, then green test resolves it!
  const testFailRaw = [mkUserStep('修复单测', '2026-01-01T04:00:00Z', 0)];
  for (let k = 1; k <= 3; k++) {
    testFailRaw.push(
      mkPlannerStep({
        stepIndex: k * 2,
        createdAt: `2026-01-01T04:00:${10 * k}Z`,
        finishedGeneratingAt: `2026-01-01T04:00:${10 * k + 5}Z`,
        cacheReadTokens: 50000,
        toolCalls: [
          { name: 'edit_file', args: { Path: `/repo/src/f${k}.js`, Target: 'a', Replacement: 'b' } },
          { name: 'run_command', args: { CommandLine: 'npm test' } },
        ],
      }),
      mkToolResult('edit_file', 'Made 1 replacement'),
      {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_DONE',
        runCommand: { exitCode: 1, combinedOutput: { full: 'not ok 1 - test failed\nTEST_EXIT=1' } },
      }
    );
  }
  const failLoopDiag = h.evaluateAgentInferenceHealth(extractModelSteps(testFailRaw, []));
  assert.ok(failLoopDiag.activeAlert);
  assert.equal(failLoopDiag.activeAlert.badge, '测试连败');

  // 4. 12 consecutive pure read-only steps -> 空转停滞 (exploration_stall)
  const stallRaw = [mkUserStep('查找配置项', '2026-01-01T05:00:00Z', 0)];
  for (let k = 1; k <= 12; k++) {
    stallRaw.push(
      mkPlannerStep({
        stepIndex: k * 2,
        createdAt: `2026-01-01T05:${String(k).padStart(2, '0')}:00Z`,
        finishedGeneratingAt: `2026-01-01T05:${String(k).padStart(2, '0')}:06Z`,
        cacheReadTokens: 60000 + k * 1000,
        thinkingTokens: 300,
        responseTokens: 150,
        response: '',
        toolCalls: [{ name: 'read_file', args: { Path: `/repo/src/mod${k}.js`, StartLine: 1, EndLine: 100 } }],
      }),
      mkToolResult('read_file', 'module content')
    );
  }
  const stallDiag = h.evaluateAgentInferenceHealth(extractModelSteps(stallRaw, []));
  assert.ok(stallDiag.activeAlert);
  assert.equal(stallDiag.activeAlert.category, 'exploration_stall');
  assert.equal(stallDiag.activeAlert.badge, '空转停滞');

  // 5. 3 identical tool calls on unchanged file -> 复读死循环 (infinite_loop)
  const loopRaw = [mkUserStep('查看入口', '2026-01-01T06:00:00Z', 0)];
  for (let k = 1; k <= 3; k++) {
    loopRaw.push(
      mkPlannerStep({
        stepIndex: k * 2,
        createdAt: `2026-01-01T06:00:${10 * k}Z`,
        finishedGeneratingAt: `2026-01-01T06:00:${10 * k + 5}Z`,
        cacheReadTokens: 40000,
        toolCalls: [{ name: 'read_file', args: { Path: '/repo/src/index.js', StartLine: 1, EndLine: 80 } }],
      }),
      mkToolResult('read_file', 'same 80 lines')
    );
  }
  const loopDiag = h.evaluateAgentInferenceHealth(extractModelSteps(loopRaw, []));
  assert.ok(loopDiag.activeAlert);
  assert.equal(loopDiag.activeAlert.category, 'infinite_loop');
  assert.equal(loopDiag.activeAlert.level, 'critical');

  // 6. Genuine same-region A->B->A thrashing -> 反复返工 (code_thrashing)
  const thrashSteps = extractModelSteps([
    mkUserStep('修复校验逻辑', '2026-01-01T07:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T07:00:01Z',
      finishedGeneratingAt: '2026-01-01T07:00:08Z',
      cacheReadTokens: 60000,
      toolCalls: [{ name: 'edit_file', args: { Path: '/repo/src/h.js', Target: 'const mode = orig();', Replacement: 'const mode = try1();' } }],
    }),
    mkToolResult('edit_file', 'Made 1 replacement starting at line 42 (+1/-1 lines)'),
    mkPlannerStep({
      stepIndex: 3,
      createdAt: '2026-01-01T07:00:10Z',
      finishedGeneratingAt: '2026-01-01T07:00:18Z',
      cacheReadTokens: 61000,
      toolCalls: [{ name: 'edit_file', args: { Path: '/repo/src/h.js', Target: 'const mode = try1();', Replacement: 'const mode = orig();' } }],
    }),
    mkToolResult('edit_file', 'Made 1 replacement starting at line 42 (+1/-1 lines)'),
    mkPlannerStep({
      stepIndex: 5,
      createdAt: '2026-01-01T07:00:20Z',
      finishedGeneratingAt: '2026-01-01T07:00:28Z',
      cacheReadTokens: 62000,
      toolCalls: [{ name: 'edit_file', args: { Path: '/repo/src/h.js', Target: 'const mode = orig();', Replacement: 'const mode = try2();' } }],
    }),
    mkToolResult('edit_file', 'Made 1 replacement starting at line 42 (+1/-1 lines)'),
    mkPlannerStep({
      stepIndex: 7,
      createdAt: '2026-01-01T07:00:30Z',
      finishedGeneratingAt: '2026-01-01T07:00:38Z',
      cacheReadTokens: 63000,
      toolCalls: [{ name: 'edit_file', args: { Path: '/repo/src/h.js', Target: 'const mode = try2();', Replacement: 'const mode = orig();' } }],
    }),
    mkToolResult('edit_file', 'Made 1 replacement starting at line 42 (+1/-1 lines)'),
  ], []);
  const thrashDiag = h.evaluateAgentInferenceHealth(thrashSteps);
  assert.ok(thrashDiag.activeAlert);
  assert.equal(thrashDiag.activeAlert.category, 'code_thrashing');
  assert.equal(thrashDiag.activeAlert.badge, '反复返工');
});

test('Orchestrator cross-pool cache shifts, large write_file denominator, and planned batch edits produce zero false alarms', async () => {
  const mkOrchestratorStep = ({ stepIndex, createdAt, finishedGeneratingAt, responseModel, modelDisplayName, cacheReadTokens, inputTokens, responseTokens, ttft }) => {
    const base = mkPlannerStep({
      stepIndex,
      createdAt,
      finishedGeneratingAt,
      model: 'MODEL_PLACEHOLDER_M667',
      responseModel,
      modelDisplayName,
      inputTokens,
      cacheReadTokens,
      thinkingTokens: 0,
      responseTokens,
      ttft,
      thinkingDuration: '0s',
      thinking: '',
    });
    return base;
  };

  const rawSteps = [
    mkUserStep('编排器跨模型池与大文件写出', '2026-01-01T08:00:00Z', 0),
    mkOrchestratorStep({
      stepIndex: 1,
      createdAt: '2026-01-01T08:00:01Z',
      finishedGeneratingAt: '2026-01-01T08:00:44Z',
      responseModel: 'orchestrator-carbon',
      modelDisplayName: 'Orchestrator (Carbon)',
      cacheReadTokens: 250000,
      inputTokens: 3000,
      responseTokens: 3900,
      ttft: '42.9s',
    }),
    mkOrchestratorStep({
      stepIndex: 2,
      createdAt: '2026-01-01T08:00:44Z',
      finishedGeneratingAt: '2026-01-01T08:00:50Z',
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Orchestrator Worker (Hydrogen)',
      cacheReadTokens: 18800,
      inputTokens: 160000,
      responseTokens: 350,
      ttft: '2.1s',
    }),
    // Deep-thinking flagship write_file (434 think tok / 21k output) + planned follow-up batch edit
    mkPlannerStep({
      stepIndex: 3,
      createdAt: '2026-01-01T08:01:00Z',
      finishedGeneratingAt: '2026-01-01T08:03:00Z',
      cacheReadTokens: 205000,
      thinkingTokens: 434,
      responseTokens: 21054,
      thinkingDuration: '11.5s',
      thinking: 'Detailed architecture plan '.padEnd(1500, 'x'),
      toolCalls: [{ name: 'write_file', args: { Path: '/repo/src/core.js', Content: 'export const ok = 1;' } }],
    }),
    mkToolResult('write_file', 'ok'),
    mkPlannerStep({
      stepIndex: 5,
      createdAt: '2026-01-01T08:03:05Z',
      finishedGeneratingAt: '2026-01-01T08:03:35Z',
      cacheReadTokens: 226000,
      thinkingTokens: 0,
      responseTokens: 3385,
      thinkingDuration: '0s',
      thinking: '',
      toolCalls: [
        { name: 'edit_file', args: { Path: '/repo/src/b.js', Target: 'const b1 = 1;', Replacement: 'const b1 = 2;' } },
        { name: 'edit_file', args: { Path: '/repo/src/b.js', Target: 'const b2 = 1;', Replacement: 'const b2 = 2;' } },
      ],
    }),
    mkToolResult('edit_file', 'Made 1 replacement starting at line 10 (+1/-1 lines)'),
    mkToolResult('edit_file', 'Made 1 replacement starting at line 40 (+1/-1 lines)'),
  ];

  const h = backendHarness({
    trajectories: { cross1: { trajectory: { steps: rawSteps }, numTotalSteps: rawSteps.length } },
    summaries: {
      cross1: {
        stepCount: rawSteps.length,
        lastModifiedTime: '2026-01-01T08:03:35Z',
        status: 'IDLE',
        annotations: { title: 'Cross Pool & Planned Batch' },
      },
    },
  });
  const payload = await h.buildTelemetryPayloadInternal('cross1');
  const health = payload.activeConversation.inferenceHealth;
  assert.equal(health.activeAlert, null);
  assert.equal(health.anomalyStepCount, 0);
});

test('Audit Regression (#2073..#2326): idle SQLite bounded toolCall decode preserves plannerResponse & silent 30s+ TTFT stalls distinguish squeezed vs intact thinking', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const { readLocalSqliteTrajectory } = await import('../backend/cli-sqlite-reader.mjs');
  const { extractModelSteps } = await import('../trajectory-metrics.mjs');
  const { evaluateAgentInferenceHealth } = await import('../backend/inference-health.mjs');

  function pbVarint(n) {
    const out = [];
    let v = BigInt(n);
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return Buffer.from(out);
  }
  function pbBytes(fieldNum, buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
    return Buffer.concat([pbVarint((fieldNum << 3) | 2), pbVarint(b.length), b]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sqlite-audit-'));
  const dbPath = path.join(tmpDir, 'conv.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE steps (
        idx integer PRIMARY KEY,
        step_type integer NOT NULL DEFAULT 0,
        status integer NOT NULL DEFAULT 0,
        metadata blob,
        step_payload blob
      );
      CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);
    `);

    const toolCallProto = Buffer.concat([
      pbBytes(1, 'call_1'),
      pbBytes(2, 'edit_file'),
      pbBytes(3, JSON.stringify({ Path: '/repo/a.js', Target: 'oldVal', Replacement: 'newVal' })),
    ]);
    const plannerRespProto = Buffer.concat([
      pbBytes(1, 'Applied fix.'),
      pbBytes(3, 'Carefully checking imports before editing module.'),
      pbBytes(7, toolCallProto),
    ]);
    const stepPayloadProto = pbBytes(20, plannerRespProto);
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      5,
      15,
      3,
      null,
      stepPayloadProto
    );
    db.close();

    // Critical check: isRunning=false triggers includeArgs='bounded' via decodeUtf8Slice
    const sq = readLocalSqliteTrajectory(dbPath, {
      cascadeId: '11111111-2222-3333-4444-555555555555',
      isRunning: false,
    });
    assert.ok(sq && sq.steps.length === 1);
    assert.ok(sq.steps[0].plannerResponse, 'plannerResponse must not be swallowed on idle bounded decode');
    assert.ok(sq.steps[0].plannerResponse.thinkingByteLen > 20);
    assert.equal(sq.steps[0].plannerResponse.toolCalls?.[0]?.name, 'edit_file');
    assert.match(sq.steps[0].plannerResponse.toolCalls?.[0]?.argumentsJson || '', /\/repo\/a\.js/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Verify silent 30s+ TTFT stall classification on short tool steps (#2073 vs #2230)
  const steps = extractModelSteps([
    mkUserStep('排查长连接卡顿', '2026-01-01T09:00:00Z', 0),
    ...Array.from({ length: 5 }, (_, idx) =>
      mkPlannerStep({
        stepIndex: idx + 1,
        createdAt: `2026-01-01T09:00:${String(idx * 10 + 1).padStart(2, '0')}Z`,
        finishedGeneratingAt: `2026-01-01T09:00:${String(idx * 10 + 8).padStart(2, '0')}Z`,
        thinkingTokens: 420,
        responseTokens: 500,
        ttft: '5.2s',
        thinkingDuration: '5.0s',
      })
    ),
    // #2073 archetype: 51.3s silent TTFT stall + squeezed thinking (58 tok, 0 chars) on short read_file
    mkPlannerStep({
      stepIndex: 10,
      createdAt: '2026-01-01T09:02:00Z',
      finishedGeneratingAt: '2026-01-01T09:02:52Z',
      thinkingTokens: 58,
      responseTokens: 64,
      ttft: '51.3s',
      thinkingDuration: '0.2s',
      thinking: '',
      toolCalls: [{ name: 'read_file', args: { Path: '/repo/x.js' } }],
    }),
    mkToolResult('read_file', 'content'),
    // #2230 archetype: 35.7s silent TTFT stall, thinking intact (290 tok) -> healthy + infraNote
    mkPlannerStep({
      stepIndex: 12,
      createdAt: '2026-01-01T09:03:00Z',
      finishedGeneratingAt: '2026-01-01T09:03:39Z',
      thinkingTokens: 290,
      responseTokens: 248,
      ttft: '35.7s',
      thinkingDuration: '4.5s',
      thinking: 'Normal thorough reasoning despite slow upstream gateway.',
      toolCalls: [{ name: 'read_file', args: { Path: '/repo/y.js' } }],
    }),
    mkToolResult('read_file', 'content'),
  ], []);

  const summary = evaluateAgentInferenceHealth(steps);
  const stSqueezed = steps.find((s) => s.stepIndex === 10);
  const stIntact = steps.find((s) => s.stepIndex === 12);
  assert.equal(stSqueezed.stepHealthLevel, 'notice');
  assert.equal(stSqueezed.stepHealthBadge, '浅思');
  assert.match(stSqueezed.stepHealthDetail, /首字卡顿 51\.3s 挤压思考/);
  assert.equal(stIntact.stepHealthLevel, 'healthy');
  assert.match(stIntact.infraNote, /首字响应长卡顿 35\.7s.*思考未受损/);
  assert.equal(summary.activeAlert, null, 'Read-only notice without downstream fault must not raise activeAlert');
});

test('Audit Regression (#2491 -> #2493) & Pre-Replatform Parity: low-share large code dump does not prematurely clear contagion window, plus adaptive TTFT & 4-part duration detail', async () => {
  const { extractModelSteps } = await import('../trajectory-metrics.mjs');
  const { evaluateAgentInferenceHealth } = await import('../backend/inference-health.mjs');
  const {
    buildModelTtftBaselines,
    classifyStepTtft,
    formatStepDurationDetail,
    formatStepTtftDetail,
    buildStepHealthDiagnostic,
  } = await import('../src/core/formatters.js');

  const steps = extractModelSteps([
    mkUserStep('移植检测面板与样式', '2026-01-01T10:00:00Z', 0),
    ...Array.from({ length: 4 }, (_, idx) =>
      mkPlannerStep({
        stepIndex: idx + 1,
        createdAt: `2026-01-01T10:00:${String(idx * 10 + 1).padStart(2, '0')}Z`,
        finishedGeneratingAt: `2026-01-01T10:00:${String(idx * 10 + 8).padStart(2, '0')}Z`,
        thinkingTokens: 500,
        responseTokens: 500,
        ttft: '5.5s',
        thinkingDuration: '5.0s',
      })
    ),
    // #2491 archetype: 35.4s TTFT stall + squeezed thinking (67 tok) on read_file
    mkPlannerStep({
      stepIndex: 20,
      createdAt: '2026-01-01T10:02:00Z',
      finishedGeneratingAt: '2026-01-01T10:02:36Z',
      thinkingTokens: 67,
      responseTokens: 64,
      ttft: '35.4s',
      thinkingDuration: '0.2s',
      thinking: '',
      toolCalls: [{ name: 'read_file', args: { Path: '/repo/domPatch.js' } }],
    }),
    mkToolResult('read_file', 'ok'),
    // #2493 archetype: 21.5s TTFT stall + 348 think tokens vs 10107 response tokens (3.3% share) -> must NOT clear contagion window!
    mkPlannerStep({
      stepIndex: 22,
      createdAt: '2026-01-01T10:02:40Z',
      finishedGeneratingAt: '2026-01-01T10:04:18Z',
      thinkingTokens: 348,
      responseTokens: 10107,
      ttft: '21.5s',
      thinkingDuration: '3.0s',
      thinking: 'Quick port '.padEnd(588, 'x'),
      toolCalls: [{ name: 'write_file', args: { Path: '/repo/SettingsDetectorTab.js', Content: 'x' } }],
    }),
    mkToolResult('write_file', 'ok'),
    // Downstream fault within 4-step window must still trace back to #20!
    mkPlannerStep({
      stepIndex: 24,
      createdAt: '2026-01-01T10:04:20Z',
      finishedGeneratingAt: '2026-01-01T10:04:28Z',
      thinkingTokens: 90,
      responseTokens: 400,
      ttft: '6.5s',
      toolCalls: [{ name: 'edit_file', args: { Path: '/repo/SettingsView.js', Target: 'missing', Replacement: 'y' } }],
    }),
    mkToolResult('edit_file', 'Target string not found in file', true),
  ], []);

  const summary = evaluateAgentInferenceHealth(steps);
  const st20 = steps.find((s) => s.stepIndex === 20);
  const st24 = steps.find((s) => s.stepIndex === 24);
  assert.equal(st20.stepHealthLevel, 'warn', '#2491 source step promotes to warn when downstream fault occurs after low-share #2493');
  assert.equal(st20.stepHealthBadge, '卡顿缩水');
  assert.match(st20.stepHealthDetail, /传导至 #24/);
  assert.match(st24.stepHealthDetail, /受 #20 浅思考传导/);
  assert.equal(summary.activeAlert?.category, 'degraded_contagion');

  // Verify model-adaptive TTFT classification & 4-part duration hover detail
  const baselines = buildModelTtftBaselines([
    { responseModel: 'gemini-3.1-pro-high', ttftSec: 6.2, isComplete: true },
    { responseModel: 'gemini-3.1-pro-high', ttftSec: 7.0, isComplete: true },
    { responseModel: 'gemini-3.1-pro-high', ttftSec: 6.8, isComplete: true },
    { responseModel: 'gemini-2.5-flash', ttftSec: 1.5, isComplete: true },
    { responseModel: 'gemini-2.5-flash', ttftSec: 1.8, isComplete: true },
    { responseModel: 'gemini-2.5-flash', ttftSec: 1.6, isComplete: true },
  ]);
  const proNormal = classifyStepTtft(
    { responseModel: 'gemini-3.1-pro-high', ttftSec: 14.2, thinkingDurationSec: 5.0 },
    baselines
  );
  assert.equal(proNormal.isSlow, false, '14.2s on Pro High with 5s buffered thinking is normal');
  assert.equal(proNormal.isStall, false);

  const flashStall = classifyStepTtft(
    { responseModel: 'gemini-2.5-flash', ttftSec: 12.0 },
    baselines
  );
  assert.equal(flashStall.isStall, true, '12.0s on Flash is flagged as stall');
  assert.match(formatStepTtftDetail({ ttftSec: 12.0 }, flashStall), /1\.6s/);

  const durDetail = formatStepDurationDetail({
    totalDurationSec: 65.3,
    ttftSec: 34.2,
    thinkingDurationSec: 1.2,
    streamDurationSec: 31.0,
    isComplete: true,
  });
  assert.match(durDetail, /65\.30s.*34\.20s.*1\.20s.*31\.00s/);

  const healthDiag = buildStepHealthDiagnostic(st20);
  assert.ok(healthDiag?.copyAction?.copyText, 'Step health diagnostic provides one-click copyAction');
});
