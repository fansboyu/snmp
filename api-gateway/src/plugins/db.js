import fp from 'fastify-plugin'
import pg from 'pg'

export const dbPlugin = fp(async (app) => {
  const pool = new pg.Pool({
    connectionString: app.config.DATABASE_URL
  })

  app.decorate('db', pool)

  app.addHook('onClose', async () => {
    await pool.end()
  })
})

