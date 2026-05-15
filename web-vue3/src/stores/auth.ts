import { defineStore } from 'pinia'
import { clearAuthToken, getAuthToken, login, setAuthToken, type AuthUser } from '../services/api'

const storageKey = 'snmp-monitor-user'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: loadUser(),
    token: getAuthToken()
  }),
  getters: {
    isLoggedIn: (state) => Boolean(state.user && state.token),
    displayName: (state) => state.user?.displayName || state.user?.username || '系统管理员'
  },
  actions: {
    async signIn(username: string, password: string) {
      if (!username || !password) {
        throw new Error('请输入用户名和密码')
      }

      const result = await login(username, password)
      this.user = result.user
      this.token = result.token
      setAuthToken(result.token)
      localStorage.setItem(storageKey, JSON.stringify(result.user))
    },
    signOut() {
      this.user = null
      this.token = ''
      clearAuthToken()
      localStorage.removeItem(storageKey)
    },
    changeAdminPassword(_currentPassword: string, _newPassword: string) {
      throw new Error('管理员密码由后端环境变量 ADMIN_PASSWORD 管理')
    }
  }
})

function loadUser(): AuthUser | null {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return null

  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    localStorage.removeItem(storageKey)
    return null
  }
}
