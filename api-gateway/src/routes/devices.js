export async function deviceRoutes(app) {
  app.get('/', async () => {
    const result = await app.db.query(`
      select id, name, host, port, enabled, created_at
      from devices
      order by id desc
    `)
    return result.rows
  })

  app.post('/', async (request, reply) => {
    const { name, host, port = 161, community = 'public', enabled = true } = request.body
    const result = await app.db.query(
      `
        insert into devices (name, host, port, community, enabled)
        values ($1, $2, $3, $4, $5)
        returning id, name, host, port, enabled, created_at
      `,
      [name, host, port, community, enabled]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/:id', async (request) => {
    const { id } = request.params
    const { name, host, port, community, enabled } = request.body
    const result = await app.db.query(
      `
        update devices
        set
          name = coalesce($2, name),
          host = coalesce($3, host),
          port = coalesce($4, port),
          community = coalesce($5, community),
          enabled = coalesce($6, enabled),
          updated_at = now()
        where id = $1
        returning id, name, host, port, enabled, updated_at
      `,
      [id, name, host, port, community, enabled]
    )
    return result.rows[0]
  })
}

