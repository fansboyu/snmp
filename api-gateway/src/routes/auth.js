function userPayload(username) {
  return {
    username,
    displayName: username === 'admin' ? '系统管理员' : username
  }
}

export async function authRoutes(app) {
  app.post('/login', async (request, reply) => {
    const { username = '', password = '' } = request.body ?? {}
    const expectedUsername = app.config.ADMIN_USERNAME
    const expectedPassword = app.config.ADMIN_PASSWORD

    if (!String(username).trim() || !String(password)) {
      reply.code(400)
      return { message: '请输入用户名和密码' }
    }

    if (String(username).trim() !== expectedUsername || String(password) !== expectedPassword) {
      reply.code(401)
      return { message: '用户名或密码不正确' }
    }

    const user = userPayload(expectedUsername)
    const token = app.jwt.sign(user)
    return { token, user }
  })

  app.get('/me', async (request) => {
    await request.jwtVerify()
    return { user: userPayload(request.user.username) }
  })
}
