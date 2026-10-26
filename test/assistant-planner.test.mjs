import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_LIMITS, planAssistant, validateAssistantPlan } from '../lib/assistant-planner.mjs';

const apps = [{ appId: 'cz.iprima.app', label: 'iPrima' }, { appId: 'youtube', label: 'YouTube' }];
const action = (type, extra = {}) => ({ type, key: null, appId: null, query: null, selection: null, ...extra });
const plan = (actions = [], extra = {}) => ({ reply: 'Připravím návrh.', actions, needsConfirmation: false, ...extra });
const jsonl = value => [
  { type: 'thread.started', thread_id: 'test' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }, { type: 'turn.completed', usage: {} },
].map(event => JSON.stringify(event)).join('\n');
const result = value => ({ code: 0, stdout: jsonl(value), stderr: '' });
const hasCode = code => error => error.code === code;
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'domov-planner-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('Codex receives only text and public app labels in an isolated tool-free invocation', async t => {
  const cwd = await fixture(t);
  const root = await realpath(cwd);
  let invocation;
  const expected = plan([action('launch_app', { appId: apps[0].appId })]);
  const value = await planAssistant({ text: 'Otevři iPrima', apps: [{ ...apps[0], token: 'must-not-forward', url: 'file:///private' }], cwd,
    runner: async request => {
      invocation = request;
      assert.equal(request.command, 'codex');
      assert.equal(request.timeoutMs, 90_000);
      assert.equal(request.maxOutputBytes, 1_048_576);
      assert.ok(request.cwd.startsWith(join(root, 'private', 'assistant-work', 'request-')));
      assert.ok(!request.input.includes('must-not-forward'));
      assert.ok(!request.input.includes('file:///private'));
      assert.ok(request.input.includes('Otevři iPrima'));
      for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--output-schema']) assert.ok(request.args.includes(flag));
      assert.equal(request.args[request.args.indexOf('--sandbox') + 1], 'read-only');
      for (const feature of ['shell_tool', 'apps', 'plugins', 'memories', 'browser_use', 'computer_use', 'unified_exec', 'multi_agent', 'hooks']) {
        const at = request.args.indexOf(feature); assert.equal(request.args[at - 1], '--disable');
      }
      assert.ok(request.args.includes('web_search="disabled"'));
      assert.ok(request.args.includes('mcp_servers={}'));
      assert.ok(request.args.includes('project_doc_max_bytes=0'));
      assert.ok(!Object.keys(request.env).some(key => /TOKEN|API_KEY|HA_URL/u.test(key)));
      const schema = JSON.parse(await readFile(join(request.cwd, 'plan.schema.json'), 'utf8'));
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.actions.maxItems, 5);
      return result(expected);
    } });
  assert.deepEqual(value, expected);
  assert.deepEqual(await readdir(join(cwd, 'private', 'assistant-work')), []);
  assert.ok(invocation);
});

test('latest episode remains an unexecuted search requiring confirmation', () => {
  const expected = plan([action('launch_app', { appId: apps[0].appId }), action('search_content', { appId: apps[0].appId, query: 'Zrádci', selection: 'latest' })],
    { reply: 'Navrhnu vyhledání Zrádců na iPrima; výběr nejnovějšího dílu čeká na potvrzení.', needsConfirmation: true });
  assert.deepEqual(validateAssistantPlan(expected, apps), expected);
  assert.throws(() => validateAssistantPlan({ ...expected, needsConfirmation: false }, apps), hasCode('INVALID_PLAN'));
  assert.throws(() => validateAssistantPlan({ ...expected, reply: 'Přehrávám nejnovější Zrádce.' }, apps), hasCode('INVALID_PLAN'));
  assert.throws(() => validateAssistantPlan({ ...expected, actions: [...expected.actions, action('key', { key: 'ok' })] }, apps), hasCode('INVALID_PLAN'));
});

test('strict plans reject unknown apps, arbitrary keys/protocols, extra fields and unbounded actions', () => {
  const bad = [
    plan([action('launch_app', { appId: 'unknown' })]),
    plan([action('launch_app', { appId: 'intent://unsafe' })]),
    plan([action('key', { key: 'shell:rm' })]),
    plan([action('key', { key: 'home', appId: apps[0].appId })]),
    plan([action('launch_app', { appId: apps[0].appId, command: 'adb shell' })]),
    plan(Array.from({ length: 6 }, () => action('key', { key: 'right' }))),
    plan([action('search_content', { appId: apps[0].appId, query: 'javascript:alert(1)', selection: 'none' })], { needsConfirmation: true }),
    plan([action('clarify')]),
    plan([action('clarify'), action('key', { key: 'ok' })], { needsConfirmation: true }),
    { ...plan(), command: 'adb' },
    JSON.parse('{"reply":"x","actions":[],"needsConfirmation":false,"__proto__":{"bad":true}}'),
  ];
  for (const value of bad) assert.throws(() => validateAssistantPlan(value, apps), hasCode('INVALID_PLAN'));
  assert.deepEqual(validateAssistantPlan(plan([action('clarify')], { needsConfirmation: true }), apps).actions, [action('clarify')]);
});

test('invalid input is rejected before spawning', async t => {
  const cwd = await fixture(t);
  const runner = async () => { assert.fail('must not run'); };
  for (const text of ['', 'x'.repeat(501), 'bad\u0000text']) await assert.rejects(planAssistant({ text, apps, cwd, runner }), hasCode('INVALID_INPUT'));
  await assert.rejects(planAssistant({ text: 'Ahoj', apps: [{ appId: 'file:///secret', label: 'App' }], cwd, runner }), hasCode('INVALID_INPUT'));
  await assert.rejects(planAssistant({ text: 'Ahoj', apps: [apps[0], apps[0]], cwd, runner }), hasCode('INVALID_INPUT'));
});

test('planner allows only one concurrent request and releases its slot', async t => {
  const cwd = await fixture(t);
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = planAssistant({ text: 'Ahoj', apps, cwd, runner: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  await ready;
  await assert.rejects(planAssistant({ text: 'Druhý', apps, cwd, runner: async () => result(plan()) }), hasCode('ASSISTANT_BUSY'));
  release(result(plan()));
  await pending;
  assert.deepEqual(await planAssistant({ text: 'Další', apps, cwd, runner: async () => result(plan()) }), plan());
});

test('tool events, incomplete output and malformed plans are never treated as AI success', async t => {
  const cwd = await fixture(t);
  for (const type of ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'todo_list']) {
    const stdout = JSON.stringify({ type: 'item.started', item: { type } }) + '\n' + jsonl(plan());
    await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => ({ code: 0, stdout }) }), hasCode('PLANNER_TOOL_ACTIVITY'));
  }
  for (const stdout of ['not json', JSON.stringify({ type: 'turn.completed' }), JSON.stringify({ type: 'unknown.event' })]) {
    await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => ({ code: 0, stdout }) }), hasCode('PLANNER_OUTPUT_INVALID'));
  }
  await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => result({ reply: 'x' }) }), hasCode('INVALID_PLAN'));
  await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => ({ code: 1, stdout: '', stderr: 'secret must never appear' }) }), error => error.code === 'PLANNER_FAILED' && !error.message.includes('secret'));
});

test('oversized or failed runner output is bounded and cleanup still occurs', async t => {
  const cwd = await fixture(t);
  await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => ({ code: 0, stdout: 'x'.repeat(ASSISTANT_LIMITS.outputBytes + 1) }) }), hasCode('PLANNER_OUTPUT_LIMIT'));
  await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => { throw new Error('HA_TOKEN=secret'); } }), error => error.code === 'PLANNER_UNAVAILABLE' && !error.message.includes('secret'));
  assert.deepEqual(await readdir(join(cwd, 'private', 'assistant-work')), []);
});

test('only two known pre-turn CLI configuration warnings are allowed; runtime and unknown errors fail closed', async t => {
  const cwd = await fixture(t);
  const warnings = [
    'Under-development features enabled: skip_host_skill_discovery. Under-development features are incomplete and may behave unpredictably.',
    'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.',
  ];
  const events = warnings.map(message => JSON.stringify({ type: 'item.completed', item: { type: 'error', message } })).join('\n');
  const value = await planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => ({ code: 0, stdout: events + '\n' + jsonl(plan()) }) });
  assert.deepEqual(value, plan());
  for (const stdout of [
    JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Unexpected MCP initialization failed' } }) + '\n' + jsonl(plan()),
    JSON.stringify({ type: 'turn.started' }) + '\n' + events + '\n' + jsonl(plan()),
  ]) await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => ({ code: 0, stdout }) }), hasCode('PLANNER_FAILED'));
});

test('work directory refuses a symlink into other private data', async t => {
  const cwd = await fixture(t);
  const outside = await fixture(t);
  await mkdir(join(cwd, 'private'));
  await symlink(outside, join(cwd, 'private', 'assistant-work'));
  await assert.rejects(planAssistant({ text: 'Ahoj', apps, cwd, runner: async () => result(plan()) }), hasCode('PLANNER_UNAVAILABLE'));
  assert.deepEqual(await readdir(outside), []);
});
