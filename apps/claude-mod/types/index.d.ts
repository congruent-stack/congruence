// Each message the mod submitted, by message ID: the turn that runs it, or '' until it starts.
export type Submitted = Record<string, string>;

declare module 'claude-code' {
  interface PluginState {
    congruence: { submitted: Submitted };
  }
}
