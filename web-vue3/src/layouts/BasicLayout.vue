<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DataLine, House, Monitor, SwitchButton } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const activeMenu = computed(() => route.path)
const pageTitle = computed(() => String(route.meta.title || 'SNMP Monitor'))

async function handleLogout(): Promise<void> {
  authStore.signOut()
  ElMessage.success('已退出登录')
  await router.replace('/login')
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="232px" class="app-sidebar">
      <div class="brand">
        <div class="brand__logo">S</div>
        <div>
          <div class="brand__name">SNMP Monitor</div>
          <div class="brand__sub">Go + Fastify + PostgreSQL</div>
        </div>
      </div>

      <el-menu :default-active="activeMenu" router class="side-menu">
        <el-menu-item index="/dashboard">
          <el-icon><House /></el-icon>
          <span>监控概览</span>
        </el-menu-item>
        <el-menu-item index="/devices">
          <el-icon><Monitor /></el-icon>
          <span>设备管理</span>
        </el-menu-item>
        <el-menu-item index="/latest">
          <el-icon><DataLine /></el-icon>
          <span>最新数据</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="app-header">
        <div>
          <h1 class="app-header__title">{{ pageTitle }}</h1>
          <p class="app-header__desc">高性能 SNMP 采集引擎管理控制台</p>
        </div>
        <div class="user-box">
          <span>{{ authStore.displayName }}</span>
          <el-button :icon="SwitchButton" plain @click="handleLogout">退出</el-button>
        </div>
      </el-header>

      <el-main class="app-main">
        <RouterView />
      </el-main>
    </el-container>
  </el-container>
</template>
