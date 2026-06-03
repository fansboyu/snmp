import Fastify from 'fastify'
import cors from '@fastify/cors'
import env from '@fastify/env'
import jwt from '@fastify/jwt'
import { dbPlugin } from './plugins/db.js'
import { alertRoutes } from './routes/alerts.js'
import { authRoutes } from './routes/auth.js'
import { chartRoutes } from './routes/charts.js'
import { healthRoutes } from './routes/health.js'
import { deviceGroupRoutes } from './routes/device-groups.js'
import { deviceRoutes } from './routes/devices.js'
import { discoveryRoutes } from './routes/discovery.js'
import { interfaceRoutes } from './routes/interfaces.js'
import { metricRoutes } from './routes/metrics.js'
import { systemRoutes } from './routes/system.js'
import { topologyRoutes } from './routes/topology.js'

const app = Fastify({
  logger: true
})

await app.register(env, {
  schema: {
    type: 'object',
    properties: {
      PORT: { type: 'string', default: '3000' },
      HOST: { type: 'string', default: '0.0.0.0' },
      DATABASE_URL: { type: 'string', default: 'postgres://snmp:snmp@localhost:5432/snmp_monitor?sslmode=disable' },
      WEB_ORIGIN: { type: 'string', default: 'http://localhost:5173' },
      JWT_SECRET: { type: 'string', default: 'change-this-dev-secret' },
      JWT_EXPIRES_IN: { type: 'string', default: '8h' },
      ADMIN_USERNAME: { type: 'string', default: 'admin' },
      ADMIN_PASSWORD: { type: 'string', default: 'admin123' }
    }
  },
  dotenv: true
})

await app.register(cors, {
  origin: app.config.WEB_ORIGIN,
  allowedHeaders: ['Content-Type', 'Authorization']
})

await app.register(jwt, {
  secret: app.config.JWT_SECRET,
  sign: {
    expiresIn: app.config.JWT_EXPIRES_IN
  }
})

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/') || request.url.startsWith('/api/auth/')) {
    return
  }

  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ message: '未登录或登录已过期' })
  }
})

await app.register(dbPlugin)
await app.register(healthRoutes, { prefix: '/health' })
await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(alertRoutes, { prefix: '/api/alerts' })
await app.register(chartRoutes, { prefix: '/api/charts' })
await app.register(deviceGroupRoutes, { prefix: '/api/device-groups' })
await app.register(deviceRoutes, { prefix: '/api/devices' })
await app.register(discoveryRoutes, { prefix: '/api/discovery' })
await app.register(interfaceRoutes, { prefix: '/api/interfaces' })
await app.register(metricRoutes, { prefix: '/api/metrics' })
await app.register(systemRoutes, { prefix: '/api/system' })
await app.register(topologyRoutes, { prefix: '/api/topology' })

const port = Number(app.config.PORT)
const host = app.config.HOST

try {
  await app.listen({ port, host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
