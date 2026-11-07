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
export function deviceIcon(kind: string) {
  const symbols: Record<string, string> = {
    router:
      '<path d="M40 12v24m-8-16 8-8 8 8M28 38H8m8-8-8 8 8 8m36-8h20m-8-8 8 8-8 8M40 64V46m-8 10 8 8 8-8"/>',
    firewall:
      '<path d="M40 9 65 20v20c0 17-25 27-25 27S15 57 15 40V20z"/><path d="M20 30h40M18 43h44M28 20v10m20 0v13M31 43v13"/>',
    ap: '<path d="M17 27a33 33 0 0 1 46 0M25 36a22 22 0 0 1 30 0M33 45a10 10 0 0 1 14 0"/><circle cx="40" cy="55" r="3"/>',
    cloud:
      '<circle cx="40" cy="38" r="26"/><ellipse cx="40" cy="38" rx="12" ry="26"/><path d="M14 38h52M19 24h42M19 52h42"/>',
    unknown:
      '<rect x="9" y="22" width="62" height="34" rx="5"/><path d="M34 32c0-9 17-9 15 1-1 5-9 4-9 11m0 5v2"/>',
    device: '<rect x="10" y="20" width="60" height="38" rx="5"/><path d="M20 32h40M20 44h24"/>',
  }
  const symbol =
    symbols[kind] ||
    '<path d="m10 25 10-10h40l10 10v30H10zM10 25h60"/><path d="M20 36h5v7h-5zm12 0h5v7h-5zm12 0h5v7h-5zm12 0h5v7h-5z"/>'
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="76" viewBox="0 0 80 76"><g fill="#eef4fa" stroke="#507394" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">${symbol}</g></svg>`,
    )
  )
}
