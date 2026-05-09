import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import BasicLayout from '../layouts/BasicLayout.vue'
import DashboardView from '../views/DashboardView.vue'
import DevicesView from '../views/DevicesView.vue'
import LatestDataView from '../views/LatestDataView.vue'
import LoginView from '../views/LoginView.vue'

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true, title: '登录' } },
  {
    path: '/',
    component: BasicLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: DashboardView, meta: { title: '监控概览' } },
      { path: 'devices', name: 'devices', component: DevicesView, meta: { title: '设备管理' } },
      { path: 'latest', name: 'latest', component: LatestDataView, meta: { title: '最新数据' } }
    ]
  },
  { path: '/metrics', redirect: '/latest' },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
]

export const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to) => {
  const authStore = useAuthStore()

  if (to.meta.public) {
    if (to.name === 'login' && authStore.isLoggedIn) {
      return '/dashboard'
    }
    return true
  }

  if (!authStore.isLoggedIn) {
    return {
      path: '/login',
      query: { redirect: to.fullPath }
    }
  }

  return true
})
