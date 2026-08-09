// src/core/plugin/manifest/errors.ts
import { AppError, ErrorCode } from '@shared/errors'

export class PluginManifestInvalid extends AppError {
  constructor(
    public readonly validationCode: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(ErrorCode.PluginManifestInvalid, message)
  }
}

export class PluginEngineVersionTooOld extends AppError {
  constructor(
    public readonly required: string,
    public readonly hostVersion: string
  ) {
    super(
      ErrorCode.PluginEngineVersionTooOld,
      `Plugin requires host ${required}; running ${hostVersion}`
    )
  }
}
