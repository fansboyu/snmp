export async function healthRoutes(app) {
  app.get('/', async () => {
    const result = await app.db.query('select now() as now')
    return {
      status: 'ok',
      databaseTime: result.rows[0].now
    }
  })
}

