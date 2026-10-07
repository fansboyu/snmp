export function formatRate(value: number | null | undefined): string {
  if(value==null || !Number.isFinite(value))return '—'
  if(value>=1e9)return `${(value/1e9).toFixed(2)} Gbps`
  if(value>=1e6)return `${(value/1e6).toFixed(2)} Mbps`
  if(value>=1e3)return `${(value/1e3).toFixed(2)} Kbps`
  return `${value.toFixed(0)} bps`
}
export function localTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '—'
}
export const dataStatusNames: Record<string,string> = {fresh:'数据正常',partial:'部分方向缺失',stale:'数据过期',invalid:'暂无有效速率',no_data:'未采集'}
export const qualityNames: Record<string,string> = {ok:'正常',insufficient:'需要两次连续采样',gap:'采样间隔过长',reset:'设备或计数器重置',ambiguous32:'32 位计数器无法安全计算',unsupported:'指标未采集或不支持',source_changed:'计数器类型切换，等待下一次采样',invalid:'数值不合理'}
