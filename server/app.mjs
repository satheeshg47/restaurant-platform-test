import { createServer } from 'node:http'
import { handleAdminApplications } from './admin/applications.mjs'
import { handleAdminOwners } from './admin/owners.mjs'
import { handleAdminAuditEvents } from './admin/audit-events.mjs'
import { handleOwnerInvitations } from './admin/owner-invitations.mjs'
import { handleCommunications } from './communications/routes.mjs'
import { handleRestaurantRoutes } from './restaurant/routes.mjs'

export function createApiServer(config, { database = null, logger = console, authenticateAdmin = null, authenticateIdentity = null } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cache-Control', 'no-store')

    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname.startsWith('/restaurant/')) {
      const handled = await handleRestaurantRoutes(request, response, { database, authenticateIdentity, objectStorage: config.objectStorage })
      if (handled) return
    }

    if (pathname === '/admin/owner-invitations' || (pathname.startsWith('/admin/owner-invitations/') && pathname.endsWith('/revoke')) || pathname === '/owner/invitations/accept') {
      await handleOwnerInvitations(request, response, { database, authenticateAdmin, authenticateIdentity })
      return
    }

    if (pathname === '/admin/owners') {
      await handleAdminOwners(request, response, { database, authenticateAdmin })
      return
    }

    if (pathname === '/admin/applications') {
      await handleAdminApplications(request, response, { database, authenticateAdmin })
      return
    }

    if (pathname.startsWith('/admin/communications') || pathname.startsWith('/owner/communications')) {
      await handleCommunications(request, response, { database, authenticateAdmin, authenticateIdentity });
      return
    }

    if (pathname === '/admin/audit-events') {
      await handleAdminAuditEvents(request, response, { database, authenticateAdmin })
      return
    }

    if (request.method === 'GET' && request.url === '/admin/session') {
      if (!config.adminAuthConfigured || !authenticateAdmin) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'admin_auth_not_configured' }))
        return
      }
      try {
        const admin = await authenticateAdmin(request)
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ authenticated: true, admin }))
      } catch (error) {
        const status = error.statusCode === 403 ? 403 : 401
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: status === 403 ? 'forbidden' : 'unauthorized' }))
      }
      return
    }

    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        status: 'ok',
        service: 'platform-core-api',
        environment: config.environment,
        checks: { process: 'ok', database: database ? 'configured' : 'not_configured' },
      }))
      return
    }

    if (request.method === 'GET' && request.url === '/ready') {
      if (!database) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({
          status: 'not_ready',
          checks: { database: 'not_configured' },
        }))
        return
      }

      try {
        await database.query('SELECT 1')
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({
          status: 'ready',
          checks: { database: 'ok' },
        }))
      } catch {
        logger.error?.('Database readiness check failed')
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({
          status: 'not_ready',
          checks: { database: 'unavailable' },
        }))
      }
      return
    }

    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'not_found' }))
  })
}
