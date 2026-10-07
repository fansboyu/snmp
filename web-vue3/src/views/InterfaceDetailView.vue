<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { EChartsOption } from 'echarts'
import EChartCard from '../components/EChartCard.vue'
import MetricCard from '../components/MetricCard.vue'
import { getPort, getPortTraffic, getPortSummary, listInterfaces, listAlertEvents, savePortNote, type DeviceInterface, type PortTrafficResult, type PortTrafficSummary, type AlertEvent } from '../services/api'
import { formatRate, localTime, dataStatusNames, qualityNames } from '../services/traffic-format'
import { usePortFavorites } from '../services/port-favorites'
const route=useRoute(),router=useRouter()
const deviceId=computed(()=>String(route.params.deviceId)),portId=computed(()=>String(route.params.interfaceId))
const port=ref<DeviceInterface|null>(null),traffic=ref<PortTrafficResult|null>(null),summary=ref<PortTrafficSummary|null>(null)
const siblings=ref<DeviceInterface[]>([]),events=ref<AlertEvent[]>([]),loading=ref(false),error=ref('')
const range=ref('1h'),custom=ref<[Date,Date]|null>(null),measure=ref('rate'),autoRefresh=ref(true),note=ref(''),saving=ref(false)
const favorites=usePortFavorites()
const favorite=computed(()=>favorites.ids.value.includes(portId.value))
let controller:AbortController|null=null,sequence=0,siblingSequence=0
function toggleFavorite(){try{favorites.toggle(portId.value)}catch{ElMessage.error('无法保存关注端口，请检查浏览器存储设置')}}
const name=computed(()=>port.value?.if_name||port.value?.if_descr||`ifIndex ${port.value?.if_index??''}`)
const admin=computed(()=>port.value?.admin_status==='1'?'启用':port.value?.admin_status==='2'?'管理关闭':'未知')
const oper=computed(()=>port.value?.oper_status==='1'?'UP':port.value?.oper_status==='2'?'DOWN':'UNKNOWN')
const dataHint=computed(()=>summary.value?.data_status==='stale'?'最后流量样本已超过 3 分钟，当前速率不再显示历史值':`${dataStatusNames[summary.value?.data_status||'no_data']}：入方向 ${qualityNames[summary.value?.in_quality||'insufficient']}；出方向 ${qualityNames[summary.value?.out_quality||'insufficient']}`)
const usage=(v:number|null|undefined)=>v==null?'利用率未知':`利用率 ${v.toFixed(2)}%`
const errorCounters=computed(()=>['ifInErrors','ifOutErrors','ifInDiscards','ifOutDiscards'].map((key,i)=>{
 const sample=port.value?.error_counters?.find(c=>c.name===key)
 return {name:['累计入错误','累计出错误','累计入丢弃','累计出丢弃'][i],value:sample?.value??'未采集',sampled_at:sample?.sampled_at,status:!sample?'未采集':Date.now()-Date.parse(sample.sampled_at)>180000?'过期':'正常'}
}))
const chart=computed<EChartsOption>(()=>({
  color:['#2563eb','#0f9f82'],tooltip:{trigger:'axis',valueFormatter:(v)=>v==null?'—':measure.value==='rate'?formatRate(Number(v)):`${Number(v).toFixed(2)}%`},
  legend:{data:['入方向','出方向'],top:0},grid:{left:72,right:24,top:45,bottom:60},
  xAxis:{type:'category',boundaryGap:false,data:traffic.value?.points.map(p=>localTime(p.time))||[]},
  yAxis:{type:'value',min:0,name:measure.value==='rate'?'速率':'利用率 %',axisLabel:{formatter:(v:number)=>measure.value==='rate'?formatRate(v):`${v}%`}},
  dataZoom:[{type:'inside'},{type:'slider',height:18,bottom:5}],
  series:['in','out'].map((dir,i)=>({name:i?'出方向':'入方向',type:'line',connectNulls:false,showSymbol:true,symbolSize:6,lineStyle:{type:i?'dashed':'solid'},data:traffic.value?.points.map(p=>measure.value==='rate'?p[dir==='in'?'in_bps':'out_bps']??null:p[dir==='in'?'in_utilization':'out_utilization']??null)||[]}))
}))
async function load(){
  const current=++sequence;controller?.abort();controller=new AbortController();const signal=controller.signal
  loading.value=true;error.value=''
  const params:Record<string,string>={deviceId:deviceId.value,range:range.value}
  if(custom.value){params.start=custom.value[0].toISOString();params.end=custom.value[1].toISOString()}
  try{
    const [p,t,s]=await Promise.all([getPort(portId.value,deviceId.value,signal),getPortTraffic(portId.value,params,signal),getPortSummary(portId.value,deviceId.value,signal)])
    if(current!==sequence)return
    port.value=p;traffic.value=t;summary.value=s;note.value=p.user_note||''
    const e=await listAlertEvents({interfaceId:portId.value,deviceId:deviceId.value,limit:30})
    if(current===sequence)events.value=e
  }catch(e){if(current===sequence&&!signal.aborted){error.value=e instanceof Error?e.message:'加载失败';port.value=null;traffic.value=null;summary.value=null;events.value=[]}}
  finally{if(current===sequence)loading.value=false}
}
async function loadSiblings(){const seq=++siblingSequence;try{const result=await listInterfaces({deviceId:deviceId.value,metadataOnly:'true'});if(seq===siblingSequence)siblings.value=result}catch{siblings.value=[]}}
async function saveNote(){const id=portId.value,value=note.value;saving.value=true;try{await savePortNote(id,value);if(port.value&&portId.value===id)port.value.user_note=value;ElMessage.success('业务备注已保存')}catch(e){ElMessage.error(e instanceof Error?e.message:'保存失败')}finally{saving.value=false}}
function changePort(id:string){router.push(`/devices/${deviceId.value}/interfaces/${id}`)}
function changeRange(){custom.value=null;load()}
watch([deviceId,portId],()=>{port.value=null;traffic.value=null;summary.value=null;events.value=[];load();loadSiblings()},{immediate:true})
const timer=setInterval(()=>{if(autoRefresh.value&&!loading.value&&!saving.value&&note.value===(port.value?.user_note||'')&&!document.hidden)load()},60000)
onUnmounted(()=>{sequence++;siblingSequence++;controller?.abort();clearInterval(timer)})
</script>
<template>
 <div v-loading="loading">
  <div class="page-toolbar"><div><el-button link @click="router.push(`/devices/${deviceId}`)">← 返回设备详情</el-button><h2 class="page-title">{{name}} · 端口流量</h2><p class="page-subtitle">{{port?.device_name}} · {{port?.device_host}} · 入 / 出方向相对本设备</p></div><div class="toolbar-actions"><el-button @click="toggleFavorite">{{favorite?'★ 已关注':'☆ 关注端口'}}</el-button><el-switch v-model="autoRefresh" active-text="每 60 秒刷新" /><el-button type="primary" @click="load">刷新</el-button></div></div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
  <template v-if="port">
   <el-card class="page-card"><div class="port-identity"><el-select :model-value="portId" filterable placeholder="切换端口" @change="changePort"><el-option v-for="p in siblings" :key="p.id" :value="String(p.id)" :label="`${p.if_name||p.if_descr} · ${p.user_note||p.if_alias||''}`" /></el-select><el-tag :type="oper==='UP'?'success':oper==='DOWN'?'danger':'info'">{{oper}}</el-tag><span>管理状态：{{admin}}</span><span>端口速率：{{formatRate(Number(port.speed_bps)||null)}}</span><el-tag :type="summary?.data_status==='fresh'?'success':'warning'">{{dataStatusNames[summary?.data_status||'no_data']}}</el-tag></div><div class="port-note"><span>业务备注</span><el-input v-model="note" maxlength="200" placeholder="例如 办公区上联；独立于设备 SNMP 备注" /><el-button :loading="saving" @click="saveNote">保存</el-button></div><p class="port-meta">设备备注：{{port.if_alias||'—'}} · 最后流量采样：{{localTime(summary?.sampled_at)}} · 实际采样间隔：{{summary?.sample_interval_seconds?`${summary.sample_interval_seconds.toFixed(0)} 秒`:'—'}}</p></el-card>
   <el-row :gutter="16" class="dashboard-row"><el-col :xs="24" :sm="8"><MetricCard title="当前入速率" :value="formatRate(summary?.in_bps)" :description="usage(summary?.in_utilization)" /></el-col><el-col :xs="24" :sm="8"><MetricCard title="当前出速率" :value="formatRate(summary?.out_bps)" :description="usage(summary?.out_utilization)" /></el-col><el-col :xs="24" :sm="8"><MetricCard title="所选时段入峰值" :value="formatRate(traffic?.stats.in.peak_bps)" description="最大有效采样平均速率" /></el-col></el-row>
   <el-alert v-if="summary?.data_status!=='fresh'" class="dashboard-row" type="warning" :closable="false" :title="dataHint" />
   <el-card class="page-card dashboard-row"><div class="port-tools"><el-radio-group v-model="range" @change="changeRange"><el-radio-button value="1h">1 小时</el-radio-button><el-radio-button value="6h">6 小时</el-radio-button><el-radio-button value="24h">24 小时</el-radio-button></el-radio-group><el-date-picker v-model="custom" type="datetimerange" start-placeholder="开始时间" end-placeholder="结束时间" @change="load" /><el-radio-group v-model="measure"><el-radio-button value="rate">速率</el-radio-button><el-radio-button value="util">利用率</el-radio-button></el-radio-group></div><p class="port-meta">{{localTime(traffic?.start)}} — {{localTime(traffic?.end)}} · {{traffic?.resolution}}</p></el-card>
   <EChartCard v-if="traffic?.points.length" title="端口入 / 出流量趋势" description="拖动时间轴或滚轮缩放；缺失区间保留断点" :options="chart" :height="340" />
   <el-card v-else class="page-card"><el-empty description="所选时段暂无流量样本，请等待连续采集或调整时间范围" /></el-card>
   <el-card class="page-card dashboard-row"><template #header>所选时段统计</template><el-table :data="[{name:'入方向',...traffic?.stats.in},{name:'出方向',...traffic?.stats.out}]"><el-table-column prop="name" label="方向" /><el-table-column label="时间加权平均速率"><template #default="{row}">{{formatRate(row.average_bps)}}</template></el-table-column><el-table-column label="最大采样平均速率"><template #default="{row}">{{formatRate(row.peak_bps)}}</template></el-table-column><el-table-column label="有效覆盖"><template #default="{row}">{{Math.round((row.coverage_seconds||0)/60)}} 分钟 / {{row.sample_count||0}} 个有效样本</template></el-table-column></el-table></el-card>
   <el-card class="page-card dashboard-row"><template #header>错误与丢弃 · 累计计数，不代表当前速率</template><el-table :data="errorCounters"><el-table-column prop="name" label="指标"/><el-table-column prop="value" label="累计值"/><el-table-column prop="status" label="数据状态"/><el-table-column label="最后采集"><template #default="{row}">{{localTime(row.sampled_at)}}</template></el-table-column></el-table></el-card>
   <el-card class="page-card dashboard-row"><template #header>此端口的相关告警</template><el-table :data="events" empty-text="此端口暂无告警"><el-table-column prop="title" label="告警" /><el-table-column prop="status" label="状态" /><el-table-column label="最近发生"><template #default="{row}">{{localTime(row.last_seen_at)}}</template></el-table-column></el-table></el-card>
  </template>
 </div>
</template>
<style scoped>
.port-identity,.port-note,.port-tools{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.port-note{margin-top:16px}.port-note .el-input{flex:1;min-width:180px}.port-identity .el-select{width:260px}.port-meta{color:#64748b;font-size:13px;margin:14px 0 0}
</style>
