/**
 * External driver: the pipeline stops at every author slot and hands the task packet
 * to whoever runs the CLI (a person or another coding agent). They write the test file,
 * optionally use `uta tool ...`, then `uta submit` and `uta gate`. The host keeps
 * ownership of state, budgets, and gates.
 */
export function createExternalDriver() {
  return { kind: 'external' };
}
