import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const keyLength = 64

function userPayload(user) {
  return {
    username: user.username,
    displayName: user.display_name || user.displayName || user.username
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = await scrypt(String(password), salt, keyLength)
  return `scrypt$${salt}$${derivedKey.toString('hex')}`
}

async function verifyPassword(password, passwordHash) {
  const [scheme, salt, expectedHex] = String(passwordHash).split('$')
  if (scheme !== 'scrypt' || !salt || !expectedHex) {
    return false
  }

  const expected = Buffer.from(expectedHex, 'hex')
  const actual = await scrypt(String(password), salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function ensureAdminUser(app) {
  const username = String(app.config.ADMIN_USERNAME || 'admin').trim()
  const password = String(app.config.ADMIN_PASSWORD || 'admin123')

  const countResult = await app.db.query('select count(*)::integer as count from admin_users')
  if (countResult.rows[0].count > 0) {
    return
  }

  await app.db.query(
    `
      insert into admin_users (username, display_name, password_hash)
      values ($1, $2, $3)
      on conflict (username) do nothing
    `,
    [username, '系统管理员', await hashPassword(password)]
  )
}

async function findUser(app, username) {
  const result = await app.db.query(
    `
      select id, username, display_name, password_hash
      from admin_users
      where username = $1
      limit 1
    `,
    [String(username).trim()]
  )
  return result.rows[0] ?? null
}

export async function authRoutes(app) {
  await ensureAdminUser(app)

  app.post('/login', async (request, reply) => {
    const { username = '', password = '' } = request.body ?? {}

    if (!String(username).trim() || !String(password)) {
      reply.code(400)
      return { message: '请输入用户名和密码' }
    }

    const user = await findUser(app, username)
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      reply.code(401)
      return { message: '用户名或密码不正确' }
    }

    const payload = userPayload(user)
    const token = app.jwt.sign(payload)
    return { token, user: payload }
  })

  app.get('/me', async (request) => {
    await request.jwtVerify()
    const user = await findUser(app, request.user.username)
    return { user: user ? userPayload(user) : userPayload(request.user) }
  })

  app.patch('/password', async (request, reply) => {
    await request.jwtVerify()

    const { currentPassword = '', newPassword = '' } = request.body ?? {}
    if (!String(currentPassword) || !String(newPassword)) {
      reply.code(400)
      return { message: '请输入当前密码和新密码' }
    }
    if (String(newPassword).length < 6) {
      reply.code(400)
      return { message: '新密码至少需要 6 位' }
    }

    const user = await findUser(app, request.user.username)
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      reply.code(401)
      return { message: '当前密码不正确' }
    }

    await app.db.query(
      `
        update admin_users
        set password_hash = $2,
            updated_at = now()
        where id = $1
      `,
      [user.id, await hashPassword(newPassword)]
    )

    return { user: userPayload(user) }
  })
}
