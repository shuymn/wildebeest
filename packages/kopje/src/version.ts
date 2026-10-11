import { version } from '../package.json'

// The package version, for display only. Two bundles of the same version can differ, so it never identifies a build.
export const PACKAGE_VERSION: string = version

// The build identity the Worker passes on every Store RPC: the Workers version id of the running deployment. The
// Worker and the Store are one script, so both sides of one deployment see the same id, and every new deployment
// gets a new one (which is what lets it clear a hold left by an earlier deployment).
export function buildOf(env: Pick<Env, 'CF_VERSION_METADATA'>): string {
	return env.CF_VERSION_METADATA.id
}
