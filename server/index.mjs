import { createApiServer } from './app.mjs'
import { loadConfig } from './config.mjs'
import { createDatabasePool } from './db/pool.mjs'
import { createAdminTokenVerifier } from './security/admin-authorization.mjs'
import { createOidcIdentityVerifier } from './security/identity-authorization.mjs'

const config = loadConfig()
const database = process.env.DATABASE_URL ? createDatabasePool() : null
const authenticateAdmin = config.adminAuthConfigured ? createAdminTokenVerifier(config) : null
const authenticateIdentity = config.adminAuthConfigured ? createOidcIdentityVerifier(config) : null
const server = createApiServer(config, { database, authenticateAdmin, authenticateIdentity })

server.listen(config.port, config.host, () => {
  console.log(`Platform Core API listening on http://${config.host}:${config.port}`)
})

let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received; closing HTTP server`)
  server.close(() => {
    Promise.resolve(database?.end())
      .then(() => process.exit(0))
      .catch(() => {
        console.error('Database pool shutdown failed')
        process.exit(1)
      })
  })
  setTimeout(() => process.exit(1), 10000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
