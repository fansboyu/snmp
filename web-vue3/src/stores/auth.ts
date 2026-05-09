import { defineStore } from 'pinia'

interface UserInfo {
  username: string
  displayName: string
}

const storageKey = 'snmp-monitor-user'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: loadUser()
  }),
  getters: {
    isLoggedIn: (state) => Boolean(state.user),
    displayName: (state) => state.user?.displayName || state.user?.username || '管理员'
  },
  actions: {
    signIn(username: string, password: string) {
      if (!username || !password) {
        throw new Error('请输入用户名和密码')
      }

      this.user = {
        username,
        displayName: username === 'admin' ? '系统管理员' : username
      }
      localStorage.setItem(storageKey, JSON.stringify(this.user))
    },
    signOut() {
      this.user = null
      localStorage.removeItem(storageKey)
    }
  }
})

function loadUser(): UserInfo | null {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return null

  try {
    return JSON.parse(raw) as UserInfo
  } catch {
    localStorage.removeItem(storageKey)
    return null
  }
}
