// Errors with stable codes: the wire carries `{code, message}` and clients switch on code.
export class CollabError extends Error {
  /**
   * @param {string} code stable machine code, e.g. E_DENY
   * @param {string} message human message (safe to show to a peer)
   */
  constructor(code, message) {
    super(message)
    this.name = 'CollabError'
    this.code = code
  }
}

export const E = {
  badRequest: 'E_BADREQ',
  scope: 'E_SCOPE',
  denied: 'E_DENY',
  notFound: 'E_NOTFOUND',
  binary: 'E_BINARY',
  tooLarge: 'E_TOO_LARGE',
  rate: 'E_RATE',
  peer: 'E_PEER',
  unsupported: 'E_UNSUPPORTED',
  comment: 'E_COMMENT',
}
