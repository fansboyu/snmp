import Fastify from 'fastify'
import cors from '@fastify/cors'
import env from '@fastify/env'
import { dbPlugin } from './plugins/db.js'
import { alertRoutes } from './routes/alerts.js'
import { chartRoutes } from './routes/charts.js'
import { healthRoutes } from './routes/health.js'
import { deviceGroupRoutes } from './routes/device-groups.js'
import { deviceRoutes } from './routes/devices.js'
import { interfaceRoutes } from './routes/interfaces.js'
import { metricRoutes } from './routes/metrics.js'

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
      WEB_ORIGIN: { type: 'string', default: 'http://localhost:5173' }
    }
  },
  dotenv: true
})

await app.register(cors, {
  origin: app.config.WEB_ORIGIN
})

await app.register(dbPlugin)
await app.register(healthRoutes, { prefix: '/health' })
await app.register(alertRoutes, { prefix: '/api/alerts' })
await app.register(chartRoutes, { prefix: '/api/charts' })
await app.register(deviceGroupRoutes, { prefix: '/api/device-groups' })
await app.register(deviceRoutes, { prefix: '/api/devices' })
await app.register(interfaceRoutes, { prefix: '/api/interfaces' })
await app.register(metricRoutes, { prefix: '/api/metrics' })

const port = Number(app.config.PORT)
const host = app.config.HOST

try {
  await app.listen({ port, host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
