<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { StarFilled } from '@element-plus/icons-vue'
import type { DeviceInterface, PortTrafficResult } from '../services/api'
import { formatRate, localTime, dataStatusNames } from '../services/traffic-format'

const props = defineProps<{
  port: DeviceInterface
  traffic?: PortTrafficResult
  loading?: boolean
  error?: string
}>()
const emit = defineEmits<{ open: []; unfollow: [] }>()
const name = computed(() => props.port.if_name || props.port.if_descr || `ifIndex ${props.port.if_index}`)
const summary = computed(() => props.traffic?.summary || props.port.traffic_summary)
const status = computed(() => props.error ? '加载失败' : dataStatusNames[summary.value?.data_status || 'no_data'])
const oper = computed(() => ['1', 'up'].includes(props.port.oper_status || '') ? 'UP' : ['2', 'down'].includes(props.port.oper_status || '') ? 'DOWN' : 'UNKNOWN')
const plotRef = ref<HTMLDivElement | null>(null)
const hasPoints = computed(() => Boolean(props.traffic?.points.some(point => point.in_bps != null || point.out_bps != null)))
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | undefined
const usage = (value: number | null | undefined) => value == null ? '利用率未知' : `利用率 ${value.toFixed(2)}%`

function render(): void {
  if (!plotRef.value) return
  if (!hasPoints.value) { chart?.dispose(); chart = null; return }
  chart ||= echarts.init(plotRef.value)
  const points = props.traffic?.points || []
  chart.setOption({
    color: ['#2563eb', '#0f9f82'], animation: false,
    grid: { left: 64, right: 12, top: 12, bottom: 30 },
    xAxis: { type: 'category', boundaryGap: false, data: points.map(point => localTime(point.time).split(' ').pop()), axisLabel: { fontSize: 11, showMinLabel: true, showMaxLabel: true } },
    yAxis: { type: 'value', min: 0, splitNumber: 2, axisLabel: { fontSize: 11, formatter: (value: number) => formatRate(value) } },
    series: ['in', 'out'].map((direction, index) => ({
      name: index ? '出方向' : '入方向', type: 'line', connectNulls: false,
      showSymbol: points.length <= 2, symbolSize: 4,
      lineStyle: { width: 2, type: index ? 'dashed' : 'solid' },
      data: points.map(point => point[direction === 'in' ? 'in_bps' : 'out_bps'] ?? null)
    }))
  }, true)
}
onMounted(() => {
  render()
  observer = new ResizeObserver(() => chart?.resize())
  if (plotRef.value) observer.observe(plotRef.value)
})
watch(() => props.traffic, render, { flush: 'post' })
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose() })
</script>

<template>
  <el-card class="followed-port-card" shadow="never">
    <div class="followed-port-heading">
      <button class="followed-port-target" type="button" :aria-label="`查看 ${name} 的端口流量详情`" @click="emit('open')">{{ name }}</button>
      <el-tooltip content="取消关注" placement="top">
        <el-button class="followed-port-star" text :aria-label="`取消关注 ${name}`" @click.stop="emit('unfollow')"><el-icon><StarFilled /></el-icon></el-button>
      </el-tooltip>
    </div>
    <p class="followed-port-note">{{ port.user_note || port.if_alias || '暂无业务备注' }}</p>
    <div class="followed-port-flags">
      <el-tag size="small" :type="oper === 'UP' ? 'success' : oper === 'DOWN' ? 'danger' : 'info'">{{ oper }}</el-tag>
      <span>{{ formatRate(Number(port.speed_bps) || null) }}</span>
      <el-tag size="small" :type="error ? 'danger' : summary?.data_status === 'fresh' ? 'success' : 'warning'">{{ status }}</el-tag>
    </div>
    <div class="followed-port-rates">
      <div><span>↓ 当前入速率</span><strong>{{ error ? '—' : formatRate(summary?.in_bps) }}</strong><small>{{ usage(error ? null : summary?.in_utilization) }}</small></div>
      <div><span>↑ 当前出速率</span><strong>{{ error ? '—' : formatRate(summary?.out_bps) }}</strong><small>{{ usage(error ? null : summary?.out_utilization) }}</small></div>
    </div>
    <div class="followed-port-plot" ref="plotRef" />
    <div v-if="!hasPoints" class="followed-port-empty">{{ loading ? '加载端口趋势…' : error ? '趋势加载失败，请刷新重试' : '最近 1 小时暂无有效流量样本' }}</div>
    <div v-if="hasPoints" class="followed-port-legend"><span class="in">入方向</span><span class="out">出方向</span></div>
    <div class="followed-port-foot"><span>最后采样 {{ localTime(summary?.sampled_at) }}</span><span>{{ summary?.data_status === 'stale' ? '历史数据' : '最近 1 小时' }} · 查看详情 →</span></div>
  </el-card>
</template>

<style scoped>
.followed-port-card{position:relative;min-width:0;border-radius:14px;border-color:#e2e8f0;transition:border-color .15s ease;container-type:inline-size}
.followed-port-card:hover{border-color:#409eff}
.followed-port-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.followed-port-target{padding:0;border:0;background:transparent;color:#2563eb;font:inherit;font-weight:600;text-align:left;cursor:pointer;overflow-wrap:anywhere}
.followed-port-target:after{content:'';position:absolute;inset:0;border-radius:14px;cursor:pointer}
.followed-port-target:focus-visible:after{outline:2px solid #2563eb;outline-offset:-3px}
.followed-port-star{position:relative;z-index:1;color:#2563eb}
.followed-port-note{margin:4px 0 12px;font-size:13px;color:#64748b;min-height:20px;overflow-wrap:anywhere}
.followed-port-flags{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:#64748b;font-size:12px}
.followed-port-rates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:16px 0 8px}
.followed-port-rates span,.followed-port-rates small{display:block;color:#64748b;font-size:12px}
.followed-port-rates strong{display:block;font-size:clamp(18px,1.7vw,24px);font-weight:600;color:#172033;margin:5px 0;font-variant-numeric:tabular-nums;white-space:nowrap}
.followed-port-plot{height:128px;width:100%;min-width:0}
.followed-port-empty{margin-top:-128px;height:128px;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:12px}
.followed-port-legend{display:flex;justify-content:center;gap:16px;font-size:12px;color:#64748b}
.followed-port-legend span:before{content:'';display:inline-block;width:14px;height:2px;background:#2563eb;vertical-align:middle;margin-right:6px}
.followed-port-legend .out:before{background:#0f9f82}
.followed-port-foot{border-top:1px solid #e2e8f0;margin-top:14px;padding-top:12px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;color:#64748b;font-size:12px}
@media(prefers-reduced-motion:reduce){.followed-port-card{transition:none}}
@container(max-width:260px){.followed-port-rates{grid-template-columns:minmax(0,1fr)}.followed-port-rates strong{font-size:22px}}
</style>
