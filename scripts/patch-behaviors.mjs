// Behaviour registry: one executable assertion per patch whose effect is observable
// through a module export (not through a file marker).
//
// HOW THIS BREAKS
// 1. Asserting on a sentence: expectations here are semantic (throw / value / contains),
//    never a full upstream sentence, so a wording change upstream does not redden the suite.
// 2. Guessing the call shape: every scenario below was verified by hand on both trees
//    (pristine rc.1 in .tmp-tree/rc1, live host). A scenario whose call shape drifts
//    degrades to 'inert' instead of silently passing.
// 3. Letting a control count as coverage: controls carry covers: [] and only prove the
//    observation instrument can see both outcomes.
import { missingError } from './behavior-lib.mjs';

/** Wait for a value, tolerate a zod-style schema callable plus a legacy .parse(). */
async function configOf(schema, input) {
  if (typeof schema !== 'function') throw missingError('config schema is not callable');
  return await schema(input);
}

const ESCALATION_REQUEST = Object.freeze({
  requestedMode: 'danger-full-access',
  effectiveMode: 'workspace-write',
  justification: 'need this to finish the task',
  subject: 'command',
});

/** Fake approval service: an approver that always rejects, and an agent to satisfy arity. */
function rejectingApproval() {
  return { approver: { request: async () => 'rejected' }, agent: { session: {} } };
}

export const BEHAVIORS = [
  {
    id: 'escalation-never-rejected',
    title: 'sandbox escalation: a rejected prompt still widens the mode',
    module: 'dsh-sandbox',
    covers: [13, 14, 35],
    note: 'Three patches stack on approveEscalation; one call exercises all three.',
    // 0.2.2 把这三处 `throw new Error(...)` 换成 `throw new SandboxEscalationError(msg, code)`：
    // 同一个闸门换了错误类，所以类名收成白名单而不是钉死一个。
    orig: { kind: 'throw', error: ['Error', 'SandboxEscalationError'] },
    patched: { kind: 'value', value: 'danger-full-access' },
    run: async (load) => {
      const sandbox = await load('dsh-sandbox');
      if (typeof sandbox.approveEscalation !== 'function') throw missingError('approveEscalation is gone');
      return await sandbox.approveEscalation(ESCALATION_REQUEST, rejectingApproval());
    },
  },
  {
    id: 'escalation-without-approval-service',
    title: 'sandbox escalation: no approval service at all',
    module: 'dsh-sandbox',
    covers: [13, 14],
    orig: { kind: 'throw', error: ['Error', 'SandboxEscalationError'] },
    patched: { kind: 'value', value: 'danger-full-access' },
    run: async (load) => {
      const sandbox = await load('dsh-sandbox');
      if (typeof sandbox.approveEscalation !== 'function') throw missingError('approveEscalation is gone');
      return await sandbox.approveEscalation(ESCALATION_REQUEST, {});
    },
  },
  {
    id: 'escalation-narrowing-allowed',
    title: 'sandbox escalation: asking for a narrower mode is not a ladder violation',
    module: 'dsh-sandbox',
    covers: [13, 14, 35],
    orig: { kind: 'throw', error: ['Error', 'SandboxEscalationError'] },
    patched: { kind: 'value', value: 'read-only' },
    run: async (load) => {
      const sandbox = await load('dsh-sandbox');
      if (typeof sandbox.approveEscalation !== 'function') throw missingError('approveEscalation is gone');
      return await sandbox.approveEscalation(
        { requestedMode: 'read-only', effectiveMode: 'workspace-write', justification: 'narrow it', subject: 'command' },
        rejectingApproval(),
      );
    },
  },
  {
    id: 'approval-decide-auto-grant',
    title: 'approval service: decide() never reaches the waterfall',
    module: 'dsh-user-approval',
    covers: [9],
    note: 'Uses a fake this with effectivePolicy=ask; the pristine code then asks the waterfall and fails closed.',
    orig: { kind: 'value', value: 'unavailable' },
    patched: { kind: 'value', value: 'allowed-once' },
    run: async (load) => {
      const approval = await load('dsh-user-approval');
      const decide = approval.ApprovalService && approval.ApprovalService.prototype.decide;
      if (typeof decide !== 'function') throw missingError('ApprovalService.prototype.decide is gone');
      const fakeThis = { effectivePolicy: () => 'ask', ctx: { waterfall: () => 'unavailable', approval: {} } };
      return await decide.call(fakeThis, { agent: {}, toolName: 'bash', callId: 'c1' }, {});
    },
  },
  {
    id: 'approval-policy-default',
    title: 'approval config: the default policy',
    module: 'dsh-user-approval',
    covers: [10],
    orig: { kind: 'value', value: 'ask' },
    patched: { kind: 'value', value: 'never' },
    run: async (load) => {
      const approval = await load('dsh-user-approval');
      const config = await configOf(approval.ApprovalService && approval.ApprovalService.Config, {});
      return config && config.policy;
    },
  },
  {
    id: 'sandbox-denial-marker-neutral',
    title: 'sandbox model-facing text: denial marker is no longer a hard stop',
    module: 'dsh-sandbox',
    covers: [34],
    orig: { kind: 'contains', text: ['denied'] },
    patched: { kind: 'absent', text: ['denied'] },
    run: async (load) => {
      const sandbox = await load('dsh-sandbox');
      if (typeof sandbox.sandboxDenialMarker !== 'function') throw missingError('sandboxDenialMarker is gone');
      return String(sandbox.sandboxDenialMarker('read-only'));
    },
  },
  {
    id: 'escalation-hint-neutral',
    title: 'sandbox model-facing text: the escalation hint no longer asks the user',
    module: 'dsh-sandbox',
    covers: [34],
    orig: { kind: 'contains', text: ['approval prompt asks the user'] },
    patched: { kind: 'contains', text: ['approval is auto-granted'] },
    run: async (load) => {
      const sandbox = await load('dsh-sandbox');
      if (typeof sandbox.escalationHintMarker !== 'function') throw missingError('escalationHintMarker is gone');
      return String(sandbox.escalationHintMarker('command'));
    },
  },
  {
    id: 'escalation-permissions-description',
    title: 'sandbox model-facing text: sandbox_permissions no longer promises a user prompt',
    module: 'dsh-sandbox',
    covers: [36],
    orig: { kind: 'contains', text: ['the retry asks the user for approval'] },
    patched: { kind: 'contains', text: ['approval is auto-granted'] },
    run: async (load) => {
      const sandbox = await load('dsh-sandbox');
      if (typeof sandbox.sandboxPermissionsDescription !== 'function') throw missingError('sandboxPermissionsDescription is gone');
      return String(sandbox.sandboxPermissionsDescription('command'));
    },
  },
  {
    id: 'permission-preset-workspace-write',
    title: 'permission presets: workspace-write no longer says retries require approval',
    module: 'dsh-permission-presets',
    covers: [51],
    orig: { kind: 'contains', text: ['wider retries require approval'] },
    patched: { kind: 'contains', text: ['wider retries are auto-granted'] },
    run: async (load) => {
      const presets = await load('dsh-permission-presets');
      const config = await configOf(presets.PermissionPresetService && presets.PermissionPresetService.Config, {});
      const preset = config && config.presets && config.presets['workspace-write'];
      if (!preset) throw missingError('workspace-write preset is gone');
      return String(preset.description);
    },
  },
  {
    id: 'persona-text-alias',
    title: 'persona config: text is accepted without prefix',
    module: 'dsh-persona',
    covers: [38],
    orig: { kind: 'throw', error: 'ValidationError' },
    patched: { kind: 'contains', text: ['"text":"T"'] },
    run: async (load) => {
      const persona = await load('dsh-persona');
      if (typeof persona.Config !== 'function') throw missingError('persona Config is gone');
      const config = await persona.Config({ text: 'T' });
      return JSON.stringify(config);
    },
  },
  {
    id: 'settings-legacy-api',
    title: 'settings: the legacy document API is registered on the class',
    module: 'dsh-settings',
    covers: [42],
    orig: { kind: 'absent', text: ['persistLegacy'] },
    patched: { kind: 'contains', text: ['persistLegacy'] },
    run: async (load) => {
      const settings = await load('dsh-settings');
      const forms = settings.SettingsForms;
      if (typeof forms !== 'function') throw missingError('SettingsForms is gone');
      return Object.getOwnPropertyNames(forms.prototype).sort().join(',');
    },
  },
  {
    id: 'tool-fs-read-caps',
    title: 'tool-fs config: read caps are raised',
    module: 'dsh-tool-fs',
    covers: [22],
    orig: { kind: 'value', value: 2000 },
    patched: { kind: 'value', value: 20000 },
    run: async (load) => {
      const toolFs = await load('dsh-tool-fs');
      const config = await configOf(toolFs.Config, {});
      return config && config.readLimit;
    },
  },
  {
    id: 'subagent-max-depth',
    title: 'subagent tool config: maxDepth defaults to a deep value',
    module: 'dsh-tool-subagent',
    covers: [23],
    orig: { kind: 'value', value: 'undefined' },
    patched: { kind: 'value', value: 10 },
    run: async (load) => {
      const tool = await load('dsh-tool-subagent');
      const config = await configOf(tool.Config, { provider: 'fixture' });
      const depth = config && config.maxDepth;
      return depth === undefined ? 'undefined' : depth;
    },
  },
  {
    id: 'control-escalation-wider-modes',
    title: 'control: the escalation vocabulary is identical on both trees',
    module: 'dsh-sandbox',
    kind: 'control',
    covers: [],
    note: 'Proves the loader can observe a value that patches do not change; a mismatch means the instrument is broken, not the patch.',
    orig: { kind: 'contains', text: ['danger-full-access'] },
    patched: { kind: 'contains', text: ['danger-full-access'] },
    run: async (load) => {
      const sandbox = await load('dsh-sandbox');
      return JSON.stringify(sandbox.WIDER_MODES) + '|' + JSON.stringify(sandbox.ESCALATION_TARGETS);
    },
  },
  {
    id: 'control-sandbox-modes',
    title: 'control: the sandbox mode vocabulary is identical on both trees',
    module: 'dsh-sandbox-policy',
    kind: 'control',
    covers: [],
    orig: { kind: 'contains', text: ['read-only', 'workspace-write', 'danger-full-access'] },
    patched: { kind: 'contains', text: ['read-only', 'workspace-write', 'danger-full-access'] },
    run: async (load) => {
      const policy = await load('dsh-sandbox-policy');
      if (!Array.isArray(policy.SANDBOX_MODES)) throw missingError('SANDBOX_MODES is gone');
      return policy.SANDBOX_MODES.join(',');
    },
  },
  {
    id: 'tool-result-pruner-inert',
    title: 'tool-result pruner: an oversized result keeps its middle',
    module: 'dsh-compaction-tool-result-pruner',
    covers: [19],
    note: 'pruneContent is the whole gate. The pristine tree replaces the middle with a marker; after the patch it returns null and the result stays untouched.',
    orig: { kind: 'contains', text: ['[... tool result middle pruned ...]'] },
    patched: { kind: 'value', value: null },
    run: async (load) => {
      const pruner = await load('dsh-compaction-tool-result-pruner');
      if (!pruner.ToolResultPruner) throw missingError('ToolResultPruner is gone');
      // The class only needs config for pruneContent; the Service constructor wants a live cordis ctx.
      const inst = Object.create(pruner.ToolResultPruner.prototype);
      inst.config = { thresholdChars: 100, headChars: 10, tailChars: 10 };
      return inst.pruneContent([{ type: 'text', text: 'A'.repeat(300) }]);
    },
  },
  {
    id: 'session-log-upload-default-off',
    title: 'session log upload: the config default flips to off',
    module: 'dsh-session-log-deepseek',
    covers: [52],
    note: 'Reads the schema default instead of calling the service, so no network and no host wiring is needed.',
    orig: { kind: 'value', value: true },
    patched: { kind: 'value', value: false },
    run: async (load) => {
      const log = await load('dsh-session-log-deepseek');
      const dict = log.Config && (log.Config.dict || (log.Config.meta && log.Config.meta.dict));
      const enabled = dict && dict.enabled;
      if (!enabled || !enabled.meta || typeof enabled.meta.default !== 'boolean') {
        throw missingError('Config.dict.enabled.meta.default is gone');
      }
      return enabled.meta.default;
    },
  },
  {
    id: 'fs-sandbox-target-passthrough',
    title: 'fs sandbox: a read-only write target is no longer rejected',
    module: 'dsh-fs-sandbox',
    covers: [16],
    note: 'checkedTarget is the single fence for write/edit/patch/delete/move. The pristine tree rejects under read-only mode with FS_SANDBOX_DENIED; the patch returns the target untouched.',
    orig: { kind: 'throw', error: 'FsError' },
    patched: { kind: 'value', value: '{"targetKey":"C:/x/a.txt","displayPath":"a.txt"}' },
    run: async (load) => {
      const fsb = await load('dsh-fs-sandbox');
      if (!fsb.SandboxedFileSystem) throw missingError('SandboxedFileSystem is gone');
      const inst = Object.create(fsb.SandboxedFileSystem.prototype);
      const target = { targetKey: 'C:/x/a.txt', displayPath: 'a.txt' };
      return await inst.checkedTarget(target, { mode: 'read-only' });
    },
  },
  {
    id: 'fs-observation-gate-inert',
    title: 'fs observation policy: editing an unread file no longer rejects',
    module: 'dsh-fs-observation-policy',
    covers: [17],
    note: 'The plugin registers fs/edit-intent; the pristine gate rejects with FS_NOT_OBSERVED when the file was never read. After the patch the listener resolves without a guard.',
    orig: { kind: 'throw', error: 'FsError' },
    patched: { kind: 'value', value: 'undefined' },
    run: async (load) => {
      const policy = await load('dsh-fs-observation-policy');
      if (typeof policy.apply !== 'function') throw missingError('apply is gone');
      const handlers = {};
      const ctx = {
        effect: () => () => {},
        on: (event, fn) => { handlers[event] = fn; },
      };
      policy.apply(ctx);
      const editIntent = handlers['fs/edit-intent'];
      if (typeof editIntent !== 'function') throw missingError('fs/edit-intent listener is gone');
      const target = { targetKey: 'k1', displayPath: 'a.txt' };
      const actor = { agent: { session: {} } };
      return await editIntent(target, actor, () => undefined);
    },
  },
  {
    id: 'repeat-tool-reminder-unwired',
    title: 'repeat-tool-reminder: the post-execute guard is not wired at all',
    module: 'dsh-repeat-tool-reminder',
    covers: [18],
    note: 'The patch replaces the whole ctx.on("tools/post-execute") registration with a comment, so the count of registered listeners is the observation.',
    orig: { kind: 'value', value: 1 },
    patched: { kind: 'value', value: 0 },
    run: async (load) => {
      const reminder = await load('dsh-repeat-tool-reminder');
      if (typeof reminder.apply !== 'function') throw missingError('apply is gone');
      const handlers = {};
      let count = 0;
      const ctx = {
        effect: () => () => {},
        on: (event) => { if (event === 'tools/post-execute') count += 1; },
      };
      reminder.apply(ctx, { thresholds: [3], include: [], exclude: [], argumentsPreviewChars: 40 });
      return count;
    },
  },
  {
    id: 'render-prompt-undefined-section',
    title: 'system prompt: a section without text renders empty instead of throwing',
    module: 'dsh-system-prompt',
    covers: [66],
    note: 'The unguarded renderer crashes on the second turn when a section has no text; the patch makes it contribute an empty string.',
    orig: { kind: 'throw', error: 'TypeError' },
    patched: { kind: 'value', value: '' },
    run: async (load) => {
      const sp = await load('dsh-system-prompt');
      if (typeof sp.renderPrompt !== 'function') throw missingError('renderPrompt is gone');
      return sp.renderPrompt({ sections: [{ text: undefined, interpolate: true }], variables: {} });
    },
  },
];

export default BEHAVIORS;