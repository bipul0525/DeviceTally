// The server's own version: bump it only when the server code changes, so app releases
// don't ask the admin to update the server (which needs a Cloudflare token) for nothing.
export const SERVER_VERSION = '1.0.5'
// Agents older than this get 426 and keep their data queued until they update.
export const AGENT_MIN_SUPPORTED = '0.1.0'
