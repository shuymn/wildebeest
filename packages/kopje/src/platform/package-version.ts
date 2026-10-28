import { version } from '../../package.json'

// The package version, for display only (NodeInfo, User-Agent, the version RPC). Two bundles of the same version can
// differ, so it never identifies a build; version.ts has the build identity.
export const PACKAGE_VERSION: string = version

// Where the software is published: NodeInfo's repository and homepage, and the about page's version line.
export const SOFTWARE_REPOSITORY = 'https://github.com/shuymn/kopje'
