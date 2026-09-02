export class ServiceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ServiceUnavailableError'
  }
}
