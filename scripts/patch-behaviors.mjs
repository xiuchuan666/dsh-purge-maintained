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
    orig: { kind: 'throw', error: 'Error' },
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
    orig: { kind: 'throw', error: 'Error' },
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
    orig: { kind: 'throw', error: 'Error' },
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
];

export default BEHAVIORS;