<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Bell, Collection, DataLine, Expand, Fold, House, Monitor, SwitchButton } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const sidebarCollapsed = ref(false)
const activeMenu = computed(() => route.path)
const pageTitle = computed(() => String(route.meta.title || 'SNMP Monitor'))
const userInitial = computed(() => authStore.displayName.slice(0, 1).toUpperCase())
const asideWidth = computed(() => (sidebarCollapsed.value ? '76px' : '232px'))

async function handleLogout(): Promise<void> {
  authStore.signOut()
  ElMessage.success('已退出登录')
  await router.replace('/login')
}
</script>

<template>
  <el-container class="app-shell" :class="{ 'app-shell--collapsed': sidebarCollapsed }">
    <el-aside :width="asideWidth" class="app-sidebar">
      <div class="brand">
        <div class="brand__logo">S</div>
        <div class="brand__text">
          <div class="brand__name">SNMP Monitor</div>
          <div class="brand__sub">Go + Fastify + PostgreSQL</div>
        </div>
      </div>

      <el-button class="sidebar-toggle" text @click="sidebarCollapsed = !sidebarCollapsed">
        <el-icon>
          <Expand v-if="sidebarCollapsed" />
          <Fold v-else />
        </el-icon>
        <span class="sidebar-toggle__text">{{ sidebarCollapsed ? '展开菜单' : '收起菜单' }}</span>
      </el-button>

      <el-menu :default-active="activeMenu" :collapse="sidebarCollapsed" router class="side-menu">
        <el-menu-item index="/dashboard">
          <el-icon><House /></el-icon>
          <span>监控概览</span>
        </el-menu-item>
        <el-menu-item index="/devices">
          <el-icon><Monitor /></el-icon>
          <span>设备管理</span>
        </el-menu-item>
        <el-menu-item index="/metrics">
          <el-icon><Collection /></el-icon>
          <span>指标管理</span>
        </el-menu-item>
        <el-menu-item index="/alerts">
          <el-icon><Bell /></el-icon>
          <span>告警中心</span>
        </el-menu-item>
        <el-menu-item index="/latest">
          <el-icon><DataLine /></el-icon>
          <span>最新数据</span>
        </el-menu-item>
      </el-menu>

      <div class="sidebar-user">
        <div class="sidebar-user__avatar">{{ userInitial }}</div>
        <div class="sidebar-user__meta">
          <div class="sidebar-user__name">{{ authStore.displayName }}</div>
          <div class="sidebar-user__role">系统管理员</div>
        </div>
        <el-button :icon="SwitchButton" circle plain class="sidebar-user__logout" @click="handleLogout" />
      </div>
    </el-aside>

    <el-container>
      <el-header class="app-header">
        <div>
          <h1 class="app-header__title">{{ pageTitle }}</h1>
          <p class="app-header__desc">高性能 SNMP 采集引擎管理控制台</p>
        </div>
      </el-header>

      <el-main class="app-main">
        <RouterView />
      </el-main>
    </el-container>
  </el-container>
</template>
