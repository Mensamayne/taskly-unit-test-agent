/** Typed error for expected harness failures. `code` is stable and machine-readable. */
export class HarnessError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.details = details;
  }
}
