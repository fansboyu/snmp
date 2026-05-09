<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Lock, Monitor, User } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const loading = ref(false)

const form = reactive({
  username: 'admin',
  password: 'admin123'
})

async function submit(): Promise<void> {
  loading.value = true
  try {
    authStore.signIn(form.username, form.password)
    ElMessage.success('登录成功')
    await router.replace(String(route.query.redirect || '/dashboard'))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-hero">
      <div class="login-brand">
        <div class="login-brand__logo">
          <el-icon><Monitor /></el-icon>
        </div>
        <div>
          <h1>SNMP Monitor</h1>
          <p>高性能网络设备采集与监控平台</p>
        </div>
      </div>
      <div class="login-copy">
        <h2>Go Collector · Fastify Gateway · PostgreSQL</h2>
        <p>统一管理设备、OID 指标、采集样本和运行状态。</p>
      </div>
    </section>

    <el-card class="login-card" shadow="never">
      <h2>登录控制台</h2>
      <p class="login-card__desc">演示账号已预填，后续可对接真实认证接口。</p>

      <el-form :model="form" label-position="top" @submit.prevent="submit">
        <el-form-item label="用户名">
          <el-input v-model="form.username" size="large" :prefix-icon="User" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" size="large" type="password" show-password :prefix-icon="Lock" />
        </el-form-item>
        <el-button class="login-button" type="primary" size="large" :loading="loading" @click="submit">
          登录
        </el-button>
      </el-form>

      <el-alert class="login-tip" title="默认账号：admin / admin123" type="info" :closable="false" />
    </el-card>
  </main>
</template>
