// All other requests are handled by the UI, which is a server-side rendered app.
// The `onRequest` handler is created in the `frontend/server` directory at build time.

// eslint-disable-next-line import/no-restricted-paths
export { onRequest } from '../frontend/server/entry.cloudflare-pages'
