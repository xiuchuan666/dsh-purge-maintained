import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// What breaks this script:
// - it invents a location when the needle is missing, so the draft anchors on the wrong line and
//   looks finished;
// - it prints a draft whose pattern is not unique, so the patch would edit three places;
// - --patch cannot re-anchor a patch whose own pattern is dead (the #12 case) and just gives up.
// Each test below pins one of those.

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cli = path.join(root, 'scripts', 'new-patch.mjs');

function run(args, cwd) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// A fake tree only needs dsh/package.json plus the file under test, because the script reads
// targetFiles() from core, and core falls back to path probes on whatever aiBase it is handed.
function fakeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newpatch-'));
  const aiBase = path.join(dir, 'node_modules', '@deepseek-ai');
  fs.mkdirSync(path.join(aiBase, 'dsh'), { recursive: true });
  fs.writeFileSync(path.join(aiBase, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(aiBase, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return aiBase;
}

test('--needle 找不到时拒绝猜位置，不产草稿', () => {
  const aiBase = fakeTree({ 'dsh-sandbox/lib/index.js': 'alpha\nbeta\ngamma\n' });
  const r = run(['--tree', 't=' + aiBase, '--pkg', 'dsh-sandbox', '--line', '0', '--needle', 'NOT-PRESENT']);
  assert.equal(r.code, 2);
  assert.match(r.out, /refusing to guess a location/);
  assert.doesNotMatch(r.out, /draft entry/);
});

test('--line 越界时报出真实范围', () => {
  const aiBase = fakeTree({ 'dsh-sandbox/lib/index.js': 'one\ntwo\n' });
  const r = run(['--tree', 't=' + aiBase, '--pkg', 'dsh-sandbox', '--line', '99']);
  assert.equal(r.code, 2);
  // the trailing newline yields one empty last element, so the honest range is 1..3
  assert.match(r.out, /outside dsh-sandbox\/lib\/index\.js \(1\.\.3\)/);
});

test('唯一行产出唯一 pattern，重复行如实标注不唯一', () => {
  const body = 'const A = 1;\nconst B = 2;\nconst B = 2;\n';
  const aiBase = fakeTree({ 'dsh-sandbox/lib/index.js': body });
  const ok = run(['--tree', 't=' + aiBase, '--pkg', 'dsh-sandbox', '--line', '1']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /unique in file/);
  const dup = run(['--tree', 't=' + aiBase, '--pkg', 'dsh-sandbox', '--line', '2']);
  assert.equal(dup.code, 1, 'a non-unique anchor is a failure, not a draft');
  assert.match(dup.out, /not unique within one line/);
  assert.match(dup.out, /no draft/);
  assert.doesNotMatch(dup.out, /draft entry/);
});

test('草稿的 file 字段写注册表键名，不写路径', () => {
  const aiBase = fakeTree({ 'dsh-sandbox/lib/index.js': 'const only = true;\n' });
  const r = run(['--tree', 't=' + aiBase, '--pkg', 'dsh-sandbox', '--line', '1', '--json']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.file, 'dsh-sandbox/lib/index.js');
  assert.equal(parsed.line, 1);
  assert.equal(parsed.draft.file, 'escalation');
  assert.equal(parsed.draft.replacements[0].pattern, 'const only = true;');
  assert.equal(parsed.draft.replace, undefined);
});

test('草稿的 replace 永远是 TODO，不编造改写内容', () => {
  const aiBase = fakeTree({ 'dsh-sandbox/lib/index.js': 'let x = 1;\n' });
  const r = run(['--tree', 't=' + aiBase, '--pkg', 'dsh-sandbox', '--line', '1', '--json']);
  const parsed = JSON.parse(r.out);
  assert.match(parsed.draft.replacements[0].replace, /^TODO: /);
  assert.match(parsed.draft.desc, /^TODO: /);
});

test('--patch 在 pattern 已死时靠 gate needle 仍能重新定位（#12 的情形）', () => {
  const aiBase = fakeTree({
    'dsh-user-approval/lib/index.js': 'const OTHER = 0;\nconst ASK_SENTENCE = "Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.";\n',
  });
  const r = run(['--tree', 't=' + aiBase, '--patch', '12', '--json']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.line, 2, 'the gate points at the ASK_SENTENCE line, not line 1');
  assert.match(parsed.anchor, /^const ASK_SENTENCE/);
});

test('--list-targets 打出键到相对路径的对照表', () => {
  const aiBase = fakeTree({ 'dsh-sandbox/lib/index.js': 'x\n' });
  const r = run(['--tree', 't=' + aiBase, '--list-targets']);
  assert.equal(r.code, 0);
  assert.match(r.out, /== target keys on t \(/);
  assert.match(r.out, /escalation\s+dsh-sandbox\/lib\/index\.js/);
});

test('未知参数直接失败，不静默忽略', () => {
  const aiBase = fakeTree({ 'dsh-sandbox/lib/index.js': 'x\n' });
  const r = run(['--tree', 't=' + aiBase, '--pkg', 'dsh-sandbox', '--line', '1', '--nonsense']);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown argument --nonsense/);
});