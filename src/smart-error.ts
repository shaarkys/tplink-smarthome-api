/**
 * Represents an error result received from a TP-Link SMART response.
 *
 * Where response `error_code` != `0`.
 */
export default class SmartError extends Error {
  /**
   * Set by `Error.captureStackTrace`
   */
  override readonly stack = '';

  constructor(
    message: string,
    readonly errorCode: number,
    readonly method: string,
    readonly response: string,
    readonly request: string,
  ) {
    super(message);
    this.name = 'SmartError';
    this.message = `${message} error_code: ${errorCode} method: ${method} response: ${response} request: ${request}`;
    Error.captureStackTrace(this, this.constructor);
  }
}
