import Type from 'typebox';
import type { AgentSettings } from '@congruence/contracts';
import type { AgentSettingsStore } from '../features/agents/settings.js';
import { StoreError } from '../storage/store.js';

const SetupStatusSchema = Type.Object({
  status: Type.Union([
    Type.Literal('configured'),
    Type.Literal('proposal_required'),
    Type.Literal('awaiting_approval'),
    Type.Literal('rejected'),
  ]),
  setting: Type.Literal('codexCommand'),
  requestId: Type.Optional(Type.String()),
  nextStep: Type.String(),
});
export const AgentConfigurationSchema = Type.Object({
  codex: SetupStatusSchema,
});
export type AgentConfiguration = Type.Static<typeof AgentConfigurationSchema>;

export function agentConfiguration(
  review: ReturnType<AgentSettingsStore['review']>,
): AgentConfiguration {
  function statusFor(setting: 'codexCommand'): Type.Static<typeof SetupStatusSchema> {
    if (review.settings[setting].trim())
      return {
        status: 'configured',
        setting,
        nextStep:
          'This executable is configured. Propose a change only if your verified local path differs.',
      };
    const matching = review.requests.filter(
      (request) =>
        request.status !== 'approved' &&
        request.changes[setting]?.trim() &&
        (Object.keys(request.changes) as Array<keyof AgentSettings>).every(
          (key) => request.baseSettings[key] === review.settings[key],
        ),
    );
    const pending = matching.find((request) => request.status === 'pending');
    if (pending)
      return {
        status: 'awaiting_approval',
        setting,
        requestId: pending.id,
        nextStep:
          'Settings are still unset. The human can review this request in Congruence → Agents. If reporting is enabled, continue on the current activity while waiting. Never approve your own request.',
      };
    const rejected = [...matching].reverse().find((request) => request.status === 'rejected');
    if (rejected)
      return {
        status: 'rejected',
        setting,
        requestId: rejected.id,
        nextStep:
          'The human rejected this configuration. Enabled reporting may continue, but messaging remains unconfigured. Do not propose it again unless the human asks.',
      };
    return {
      status: 'proposal_required',
      setting,
      nextStep: `Only if the human enabled reporting or requested setup: identify your host, locate the executable, and call propose_agent_settings with changes.${setting}, evidence, reason, workspaceId and a stable request UUID. A matching pending proposal permits reporting while the human reviews it in Agents.`,
    };
  }
  return { codex: statusFor('codexCommand') };
}

export class ConfigurationRequiredError extends StoreError {
  readonly code = 'CONFIGURATION_REQUIRED';
  constructor(
    readonly configuration: AgentConfiguration,
    readonly workspaceId: string,
  ) {
    super(
      'CONFIGURATION_REQUIRED: Activity was not saved. Submit the missing executable configuration with propose_agent_settings, then retry publish_activity. The executable stays unset until the human approves in the Congruence frontend.',
      409,
    );
  }
}
