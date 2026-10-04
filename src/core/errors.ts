/**
 * Errors thrown by the core.
 *
 * A `CodecError` means data from the wire is malformed: SCHEMAS.md says such a message is
 * invalid, never repaired. A `ParseError` means user or CSV text didn't parse. Anything
 * else thrown by the core (a `RangeError`, a `TypeError`) is a programming error.
 */

export class CodecError extends Error {
  /** Where in the decoded value the problem is, e.g. `splits[2].amount`. */
  readonly path: string;

  constructor(message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CodecError';
    this.path = path;
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
