/** Browser-safe control route names; no Node transport/authority implementation. */
export const CONTROL_RPC_PREFIX = '/ds-harness-remote'
export const STATUS_STREAM_ENDPOINT = 'status.events'
export const STATUS_STREAM_PATH = `${CONTROL_RPC_PREFIX}/${STATUS_STREAM_ENDPOINT}`
