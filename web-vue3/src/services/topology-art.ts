export const assetNames: Record<string, string> = {
  auto: '自动 / 未识别',
  device: '通用设备',
  router: '路由器',
  switch: '交换机',
  firewall: '防火墙',
  ac: '无线控制器',
  ap: '无线 AP',
  cloud: '互联网 / 云',
  unknown: '未知邻居',
}

const assetKinds = new Set(Object.keys(assetNames))

export function deviceIcon(kind: string): string {
  const safeKind = assetKinds.has(kind) && kind !== 'auto' ? kind : kind === 'auto' ? 'unknown' : 'device'
  return `/icons/devices/${safeKind}.svg`
}
