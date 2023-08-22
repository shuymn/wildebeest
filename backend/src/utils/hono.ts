// This file is based on Sonik https://github.com/yusukebe/sonik by Yusuke Wada, licensed under the MIT license.

import { Hono } from 'hono'

import { HonoEnv } from 'wildebeest/backend/src/types'

import { filePathToPath, groupByDirectory } from './file'

type RouteFile = { default: Hono }

const root = '../routes'
const regExp = new RegExp(`^${root}`)

export const createApp = (): Hono<HonoEnv> => {
	const ROUTES = import.meta.glob<true, string, RouteFile>(
		['../routes/**/[a-z0-9[-][a-z0-9.[_-]*.ts', '../routes/.well-known/[a-z0-9[-][a-z0-9.[_-]*.ts'],
		{
			eager: true,
		}
	)
	const routesMap = groupByDirectory(ROUTES)

	const app = new Hono<HonoEnv>()

	for (const [dir, content] of Object.entries(routesMap)) {
		const subApp = new Hono()

		for (const [filename, route] of Object.entries(content)) {
			const routeDefault = route.default
			if (!routeDefault) {
				continue
			}

			const path = filePathToPath(filename)
			subApp.route(path, routeDefault)
		}

		const rootPath = filePathToPath(dir.replace(regExp, ''))
		app.route(rootPath, subApp)
	}

	return app
}
