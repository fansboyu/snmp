export async function deviceRoutes(app) {
  app.get('/', async () => {
    const result = await app.db.query(`
      select
        d.id,
        d.name,
        d.host,
        d.port,
        d.group_id,
        g.name as group_name,
        d.community,
        d.snmp_version,
        d.snmp_v3_username,
        d.snmp_v3_security_level,
        d.snmp_v3_auth_protocol,
        d.snmp_v3_auth_passphrase,
        d.snmp_v3_priv_protocol,
        d.snmp_v3_priv_passphrase,
        d.snmp_v3_context_name,
        d.enabled,
        d.created_at
      from devices d
      left join device_groups g on g.id = d.group_id
      order by d.id desc
    `)
    return result.rows
  })

  app.post('/', async (request, reply) => {
    const {
      name,
      host,
      port = 161,
      group_id = null,
      community = 'public',
      snmp_version = '2c',
      snmp_v3_username = null,
      snmp_v3_security_level = 'noAuthNoPriv',
      snmp_v3_auth_protocol = null,
      snmp_v3_auth_passphrase = null,
      snmp_v3_priv_protocol = null,
      snmp_v3_priv_passphrase = null,
      snmp_v3_context_name = null,
      enabled = true
    } = request.body
    const result = await app.db.query(
      `
        insert into devices (
          name,
          host,
          port,
          group_id,
          community,
          snmp_version,
          snmp_v3_username,
          snmp_v3_security_level,
          snmp_v3_auth_protocol,
          snmp_v3_auth_passphrase,
          snmp_v3_priv_protocol,
          snmp_v3_priv_passphrase,
          snmp_v3_context_name,
          enabled
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, nullif($9, ''), nullif($10, ''), nullif($11, ''), nullif($12, ''), nullif($13, ''), $14)
        returning
          id,
          name,
          host,
          port,
          group_id,
          community,
          snmp_version,
          snmp_v3_username,
          snmp_v3_security_level,
          snmp_v3_auth_protocol,
          snmp_v3_auth_passphrase,
          snmp_v3_priv_protocol,
          snmp_v3_priv_passphrase,
          snmp_v3_context_name,
          enabled,
          created_at,
          updated_at
      `,
      [
        name,
        host,
        port,
        group_id,
        community,
        snmp_version,
        snmp_v3_username,
        snmp_v3_security_level,
        snmp_v3_auth_protocol,
        snmp_v3_auth_passphrase,
        snmp_v3_priv_protocol,
        snmp_v3_priv_passphrase,
        snmp_v3_context_name,
        enabled
      ]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/:id', async (request) => {
    const { id } = request.params
    const {
      name,
      host,
      port,
      group_id,
      community,
      snmp_version,
      snmp_v3_username,
      snmp_v3_security_level,
      snmp_v3_auth_protocol,
      snmp_v3_auth_passphrase,
      snmp_v3_priv_protocol,
      snmp_v3_priv_passphrase,
      snmp_v3_context_name,
      enabled
    } = request.body
    const result = await app.db.query(
      `
        update devices
        set
          name = coalesce($2, name),
          host = coalesce($3, host),
          port = coalesce($4, port),
          group_id = coalesce($5, group_id),
          community = coalesce($6, community),
          snmp_version = coalesce($7, snmp_version),
          snmp_v3_username = coalesce($8, snmp_v3_username),
          snmp_v3_security_level = coalesce($9, snmp_v3_security_level),
          snmp_v3_auth_protocol = coalesce(nullif($10, ''), snmp_v3_auth_protocol),
          snmp_v3_auth_passphrase = coalesce(nullif($11, ''), snmp_v3_auth_passphrase),
          snmp_v3_priv_protocol = coalesce(nullif($12, ''), snmp_v3_priv_protocol),
          snmp_v3_priv_passphrase = coalesce(nullif($13, ''), snmp_v3_priv_passphrase),
          snmp_v3_context_name = coalesce(nullif($14, ''), snmp_v3_context_name),
          enabled = coalesce($15, enabled),
          updated_at = now()
        where id = $1
        returning
          id,
          name,
          host,
          port,
          group_id,
          community,
          snmp_version,
          snmp_v3_username,
          snmp_v3_security_level,
          snmp_v3_auth_protocol,
          snmp_v3_auth_passphrase,
          snmp_v3_priv_protocol,
          snmp_v3_priv_passphrase,
          snmp_v3_context_name,
          enabled,
          created_at,
          updated_at
      `,
      [
        id,
        name,
        host,
        port,
        group_id,
        community,
        snmp_version,
        snmp_v3_username,
        snmp_v3_security_level,
        snmp_v3_auth_protocol,
        snmp_v3_auth_passphrase,
        snmp_v3_priv_protocol,
        snmp_v3_priv_passphrase,
        snmp_v3_context_name,
        enabled
      ]
    )
    return result.rows[0]
  })

  app.delete('/:id', async (request, reply) => {
    const { id } = request.params
    const result = await app.db.query(
      `
        delete from devices
        where id = $1
        returning id, name
      `,
      [id]
    )

    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'device not found' }
    }

    return result.rows[0]
  })
}
