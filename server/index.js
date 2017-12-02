'use strict'

const Basic = require('hapi-auth-basic')
const Boom = require('boom')
const dotenv = require('dotenv')
const Handlebars = require('handlebars')
const Hapi = require('hapi')
const Inert = require('inert')
const massive = require('massive')
const {resolve} = require('path')
const SQL = require('./sql/index.js')
const validate = require('./validate.js')
const Vision = require('vision')

const UNDEFINED_TABLE = '42P01'

dotenv.config()

const server = new Hapi.Server({
	port: process.env.PORT,
	router: {stripTrailingSlash: true},
})

async function main () {
	let db
	let dumps

	try {
		db = await massive(process.env.DATABASE_URL)
	} catch (error) {
		throw new Error(error)
	}

	try {
		dumps = await db.run('SELECT * FROM dumps')
	} catch (error) {
		if (error.code !== UNDEFINED_TABLE) throw new Error(error)
	}

	if (dumps) {
		try {
			// Add new columns to reports
			await db.run('ALTER TABLE reports ADD COLUMN dump bytea')
			await db.run('ALTER TABLE reports ADD COLUMN open boolean DEFAULT TRUE')
			await db.run('ALTER TABLE reports ADD COLUMN closed_at timestamptz')
			await db.run(
				'ALTER TABLE reports ADD COLUMN updated_at timestamptz DEFAULT now()'
			)
			// Migrate dumps table to reports.dump
			dumps.forEach(async dump => {
				await db.reports.update({
					dump: dump.file,
					id: dump.report_id,
				})
			})
			// Add NOT NULL to dump column
			await db.run('ALTER TABLE reports ALTER COLUMN dump SET NOT NULL')
			// Drop old dumps table
			await db.run('DROP TABLE dumps')
		} catch (error) {
			console.error(error)
		}
	}

	try {
		await server.register([Basic, Inert, Vision])
	} catch (error) {
		throw new Error(error)
	}

	try {
		// Prepare database
		await db.run(SQL)
	} catch (error) {
		throw new Error(error)
	}

	// Load, configure plugins
	server.auth.strategy('simple', 'basic', {validate})
	server.views({
		engines: {html: Handlebars},
		layout: true,
		path: 'views',
		relativeTo: __dirname,
	})

	// Application state
	server.app.db = db
	server.app.env = process.env.NODE_ENV
	server.app.user = process.env.AUTH_USER
	server.app.pass = process.env.AUTH_PASS
	server.app.auth = `${server.app.user}:${server.app.pass}`

	// Application routes
	// route: GET /
	server.route({
		method: 'GET',
		options: {
			auth: 'simple',
			handler: (request, h) => {
				const auth = Buffer.from(server.app.auth).toString('base64')
				const isSecure = server.app.env === 'production'
				const options = {isHttpOnly: false, isSecure}

				return h.view('index').state('authorization', auth, options)
			},
		},
		path: '/',
	})

	// route: POST /
	server.route({
		method: 'POST',
		options: {
			handler: async (request, h) => {
				if (request.payload) {
					const body = Object.assign({}, request.payload)
					const dump = request.payload.upload_file_minidump

					delete body.upload_file_minidump

					try {
						await server.app.db.reports.save({body, dump})

						return {}
					} catch (error) {
						throw new Error(error)
					}
				} else {
					return Boom.badRequest()
				}
			},
		},
		path: '/',
	})

	// route: GET /reports
	server.route({
		method: 'GET',
		options: {
			auth: 'simple',
			handler: async (request, h) => {
				const sql = 'SELECT * FROM reports ORDER BY created_at DESC'

				try {
					const reports = await server.app.db.run(sql)

					return reports.map(r => {
						const report = Object.assign({}, r)

						delete report.dump
						delete report.search

						return report
					})
				} catch (error) {
					throw new Error(error)
				}
			},
		},
		path: '/reports',
	})

	// route: GET /reports/:id
	server.route({
		method: 'GET',
		options: {
			auth: 'simple',
			handler: async (request, h) => {
				const id = Number(request.params.id)

				try {
					const report = await server.app.db.reports.find(id)

					delete report.dump
					delete report.search

					return report
				} catch (error) {
					throw new Error(error)
				}
			},
		},
		path: '/reports/{id}',
	})

	// route: PATCH /reports/:id
	server.route({
		method: 'PATCH',
		options: {
			auth: 'simple',
			handler: async (request, h) => {
				const id = Number(request.params.id)

				try {
					const report = await server.app.db.reports.find(id)
					const closedAt = report.open ? new Date() : null

					report.open = !report.open
					report.closed_at = closedAt

					return await server.app.db.reports.save(report)
				} catch (error) {
					throw new Error(error)
				}
			},
		},
		path: '/reports/{id}',
	})

	// route: DELETE /reports/:id
	server.route({
		method: 'DELETE',
		options: {
			auth: 'simple',
			handler: async (request, h) => {
				const id = Number(request.params.id)

				try {
					return await server.app.db.reports.destroy(id)
				} catch (error) {
					throw new Error(error)
				}
			},
		},
		path: '/reports/{id}',
	})

	// route: GET /reports/:id/dump
	server.route({
		method: 'GET',
		options: {
			auth: 'simple',
			handler: async (request, h) => {
				const id = Number(request.params.id)
				const name = `crash-${id}.dmp`

				try {
					const report = await server.app.db.reports.find(id)

					return h
						.response(report.dump)
						.header('content-disposition', `attachment; filename=${name}`)
						.type('application/x-dmp')
				} catch (error) {
					throw new Error(error)
				}
			},
			path: '/reports/{id}/dump',
		},
	})

	// Server client side javascript
	server.route({
		method: 'GET',
		options: {
			handler: (request, h) => {
				return h.file(resolve('client', request.params.path))
			},
		},
		path: '/client/{path}',
	})

	// Serve static assets
	server.route({
		method: 'GET',
		options: {
			handler: (request, h) =>
				h.file(resolve(__dirname, 'public', request.params.path)),
		},
		path: '/{path}',
	})

	// Start server
	try {
		await server.start()
	} catch (error) {
		throw new Error(error)
	}

	console.log(`Server running at: ${server.info.uri}`)

	return server
}

main()
