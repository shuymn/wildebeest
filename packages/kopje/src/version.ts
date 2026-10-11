import { version } from '../package.json'

// The build version the Worker passes on every Store RPC. It is the package version, fixed at bundle time;
// the Store is bundled into the same script, so both sides of one deployment always agree.
export const BUILD_VERSION: string = version
