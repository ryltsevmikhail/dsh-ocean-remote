// Sanitized support snapshot: enough to diagnose a connection, never enough to
// impersonate a device. No tokens, no keys, no full fingerprints, no paths.

export interface DiagnosticsTrust {
  trusted: number
  pending: number
  available: boolean
  localApproval: boolean
}

export interface DiagnosticsInput {
  role: 'host' | 'client'
  mode: string
  pluginVersion: string
  harnessVersion?: string
  serverUrl?: string
  device?: { id: string; name: string; platform: string }
  trust?: DiagnosticsTrust
  transport?: { connected: boolean; mode?: string; target?: string }
  features?: Record<string, boolean>
  error?: string
}

export interface DiagnosticsReport {
  schemaVersion: 1
  generatedAt: string
  role: 'host' | 'client'
  mode: string
  versions: { plugin: string; harness?: string }
  server?: { origin: string }
  device?: { idPrefix: string; name: string; platform: string }
  trust?: DiagnosticsTrust
  transport?: { connected: boolean; mode?: string; targetPrefix?: string }
  features?: Record<string, boolean>
  /** Only whether an error is present: messages can quote URLs and identifiers. */
  error: { present: boolean }
}

/** Keeps only the origin: path, query (tokens) and credentials never leave the process. */
function originOf(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl)
    return url.origin
  } catch {
    return undefined
  }
}

export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
  const origin = input.serverUrl === undefined ? undefined : originOf(input.serverUrl)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    role: input.role,
    mode: input.mode,
    versions: {
      plugin: input.pluginVersion,
      ...(input.harnessVersion === undefined ? {} : { harness: input.harnessVersion }),
    },
    ...(origin === undefined ? {} : { server: { origin } }),
    ...(input.device === undefined ? {} : {
      device: {
        idPrefix: input.device.id.slice(0, 8),
        name: input.device.name,
        platform: input.device.platform,
      },
    }),
    ...(input.trust === undefined ? {} : { trust: input.trust }),
    ...(input.transport === undefined ? {} : {
      transport: {
        connected: input.transport.connected,
        ...(input.transport.mode === undefined ? {} : { mode: input.transport.mode }),
        ...(input.transport.target === undefined ? {} : { targetPrefix: input.transport.target.slice(0, 8) }),
      },
    }),
    ...(input.features === undefined ? {} : { features: input.features }),
    error: { present: input.error !== undefined && input.error.length > 0 },
  }
}
