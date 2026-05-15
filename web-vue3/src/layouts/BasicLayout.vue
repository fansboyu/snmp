<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Bell,
  Collection,
  DataLine,
  Expand,
  Fold,
  House,
  Key,
  Monitor,
  Search,
  Share,
  SwitchButton
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const sidebarCollapsed = ref(false)
const passwordDialogVisible = ref(false)
const passwordSaving = ref(false)
const activeMenu = computed(() => route.path)
const pageTitle = computed(() => String(route.meta.title || 'netlooker'))
const asideWidth = computed(() => (sidebarCollapsed.value ? '76px' : '232px'))

const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

async function handleLogout(): Promise<void> {
  authStore.signOut()
  ElMessage.success('已退出登录')
  await router.replace('/login')
}

function openPasswordDialog(): void {
  passwordForm.currentPassword = ''
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
  passwordDialogVisible.value = true
}

function changePassword(): void {
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    ElMessage.error('两次输入的新密码不一致')
    return
  }

  passwordSaving.value = true
  try {
    authStore.changeAdminPassword(passwordForm.currentPassword, passwordForm.newPassword)
    ElMessage.success('管理员密码已更新')
    passwordDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '密码修改失败')
  } finally {
    passwordSaving.value = false
  }
}
</script>

<template>
  <el-container class="app-shell" :class="{ 'app-shell--collapsed': sidebarCollapsed }">
    <el-aside :width="asideWidth" class="app-sidebar">
      <div class="brand">
        <div class="brand__logo">
          <img src="/netlooker-logo.png" alt="netlooker logo" />
        </div>
        <div class="brand__text">
          <div class="brand__name">netlooker</div>
          <div class="brand__sub">Network monitoring console</div>
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
        <el-menu-item index="/discovery">
          <el-icon><Search /></el-icon>
          <span>自动发现</span>
        </el-menu-item>
        <el-menu-item index="/topology">
          <el-icon><Share /></el-icon>
          <span>网络拓扑</span>
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
        <div class="sidebar-user__meta">
          <div class="sidebar-user__name">{{ authStore.displayName }}</div>
          <div class="sidebar-user__role">系统管理员</div>
        </div>
        <div class="sidebar-user__actions">
          <el-tooltip content="修改密码" placement="top">
            <el-button :icon="Key" circle plain class="sidebar-user__button" @click="openPasswordDialog" />
          </el-tooltip>
          <el-tooltip content="退出登录" placement="top">
            <el-button :icon="SwitchButton" circle plain class="sidebar-user__button" @click="handleLogout" />
          </el-tooltip>
        </div>
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

  <el-dialog v-model="passwordDialogVisible" title="修改系统管理员密码" width="420px">
    <el-form label-position="top" @submit.prevent="changePassword">
      <el-form-item label="当前密码">
        <el-input v-model="passwordForm.currentPassword" type="password" show-password autocomplete="current-password" />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="passwordForm.newPassword" type="password" show-password autocomplete="new-password" />
      </el-form-item>
      <el-form-item label="确认新密码">
        <el-input v-model="passwordForm.confirmPassword" type="password" show-password autocomplete="new-password" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="passwordDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="passwordSaving" @click="changePassword">保存</el-button>
    </template>
  </el-dialog>
</template>
