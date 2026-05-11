import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import AlertsView from '../views/AlertsView.vue'
import BasicLayout from '../layouts/BasicLayout.vue'
import DashboardView from '../views/DashboardView.vue'
import DeviceDetailView from '../views/DeviceDetailView.vue'
import DevicesView from '../views/DevicesView.vue'
import DiscoveryView from '../views/DiscoveryView.vue'
import LatestDataView from '../views/LatestDataView.vue'
import LoginView from '../views/LoginView.vue'
import MetricsView from '../views/MetricsView.vue'
import TopologyView from '../views/TopologyView.vue'

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true, title: '登录' } },
  {
    path: '/',
    component: BasicLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: DashboardView, meta: { title: '监控概览' } },
      { path: 'devices', name: 'devices', component: DevicesView, meta: { title: '设备管理' } },
      { path: 'discovery', name: 'discovery', component: DiscoveryView, meta: { title: '自动发现' } },
      { path: 'topology', name: 'topology', component: TopologyView, meta: { title: '网络拓扑' } },
      { path: 'devices/:id', name: 'device-detail', component: DeviceDetailView, meta: { title: '设备监控' } },
      { path: 'metrics', name: 'metrics', component: MetricsView, meta: { title: '指标管理' } },
      { path: 'alerts', name: 'alerts', component: AlertsView, meta: { title: '告警中心' } },
      { path: 'latest', name: 'latest', component: LatestDataView, meta: { title: '最新数据' } }
    ]
  },
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
