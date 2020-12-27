'use strict'

export class JSONRPCError extends Error {
  constructor ({ message, code, data }) {
    super(message)
    this.code = code
    if (data) this.data = data
    this.name = this.constructor.name
  }
}
