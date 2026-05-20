export async function deviceGroupRoutes(app) {
  app.get('/', async () => {
    const result = await app.db.query(`
      select
        g.id,
        g.name,
        g.description,
        g.template_id,
        t.name as template_name,
        count(d.id)::integer as device_count,
        g.created_at,
        g.updated_at
      from device_groups g
      left join oid_templates t on t.id = g.template_id
      left join devices d on d.group_id = g.id
      group by g.id, t.name
      order by g.id
    `)
    return result.rows
  })

  app.post('/', async (request, reply) => {
    const { name, description = null, template_id = null } = request.body
    const result = await app.db.query(
      `
        insert into device_groups (name, description, template_id)
        values ($1, $2, $3)
        returning id, name, description, template_id, created_at, updated_at
      `,
      [name, description, template_id]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/:id', async (request) => {
    const { id } = request.params
    const { name, description, template_id } = request.body
    const hasTemplateId = Object.prototype.hasOwnProperty.call(request.body, 'template_id')
    const result = await app.db.query(
      `
        update device_groups
        set
          name = coalesce($2, name),
          description = coalesce($3, description),
          template_id = case when $4::boolean then $5 else template_id end,
          updated_at = now()
        where id = $1
        returning id, name, description, template_id, created_at, updated_at
      `,
      [id, name, description, hasTemplateId, template_id]
    )
    return result.rows[0]
  })
}
