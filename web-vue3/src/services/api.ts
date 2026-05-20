export interface Device {
  id: string
  name: string
  host: string
  port: number
  group_id?: string | null
  group_name?: string | null
  community?: string | null
  snmp_version: '2c' | '3'
  snmp_v3_username?: string | null
  snmp_v3_security_level?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv'
  snmp_v3_auth_protocol?: string | null
  snmp_v3_auth_passphrase?: string | null
  snmp_v3_priv_protocol?: string | null
  snmp_v3_priv_passphrase?: string | null
  snmp_v3_context_name?: string | null
  enabled: boolean
  online_status?: 'online' | 'offline'
  last_seen_at?: string | null
  created_at?: string
}

export interface MetricDefinition {
  id: string
  name: string
  oid: string
  unit: string
  metric_kind: 'scalar' | 'interface' | 'walk'
  table_oid?: string | null
  aggregate_method?: 'latest' | 'max' | 'avg' | 'sum' | 'first' | string
  display_group?: string | null
  vendor?: string | null
  enabled: boolean
  sort_order?: number
}

export interface DeviceGroup {
  id: string
  name: string
  description?: string | null
  template_id?: string | null
  template_name?: string | null
  device_count?: number
}

export interface OidTemplate {
  id: string
  name: string
  description?: string | null
  enabled: boolean
  definition_count?: number
}

export interface MetricSample {
  created_at: string
  device_name: string
  metric_name: string
  unit: string
  value_text: string
}

export interface HealthStatus {
  status: string
  databaseTime: string
}

export interface AuthUser {
  username: string
  displayName: string
}

export interface LoginResponse {
  token: string
  user: AuthUser
}

export interface CreateDevicePayload {
  name: string
  host: string
  port?: number
  group_id?: string | null
  community?: string
  snmp_version?: '2c' | '3'
  snmp_v3_username?: string | null
  snmp_v3_security_level?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv'
  snmp_v3_auth_protocol?: string | null
  snmp_v3_auth_passphrase?: string | null
  snmp_v3_priv_protocol?: string | null
  snmp_v3_priv_passphrase?: string | null
  snmp_v3_context_name?: string | null
  enabled?: boolean
}

export interface DeviceInterface {
  id: string
  device_id: string
  device_name: string
  group_id?: string | null
  group_name?: string | null
  if_index: number
  if_descr?: string | null
  if_name?: string | null
  if_alias?: string | null
  oper_status?: string | null
  last_seen_at?: string
}

export interface InterfaceMetricSample {
  created_at: string
  device_id: string
  device_name: string
  interface_id: string
  if_index: number
  interface_name: string
  metric_name: string
  unit: string
  value_text: string
}

export interface ChartPoint {
  time: string
  value?: number | null
  count?: number
  in_bps?: number
  out_bps?: number
}

export interface InterfaceStatusPoint {
  status: 'up' | 'down' | 'unknown'
  count: number
}

export interface AlertSummary {
  active_count: number
  resolved_count: number
  critical_count: number
  warning_count: number
}

export interface AlertRule {
  id: string
  name: string
  rule_type: string
  severity: 'warning' | 'critical' | 'info'
  device_id?: string | null
  device_name?: string | null
  interface_id?: string | null
  interface_name?: string | null
  metric_name?: string | null
  operator?: string | null
  threshold?: string | number | null
  duration_seconds: number
  enabled: boolean
  created_at?: string
  updated_at?: string
}

export interface AlertEvent {
  id: string
  rule_id?: string | null
  rule_name?: string | null
  device_id?: string | null
  device_name?: string | null
  interface_id?: string | null
  interface_name?: string | null
  severity: 'warning' | 'critical' | 'info'
  status: 'active' | 'resolved'
  title: string
  message?: string | null
  value_text?: string | null
  triggered_at: string
  last_seen_at: string
  resolved_at?: string | null
}

export interface AlertNotification {
  id: string
  event_id: string
  event_title?: string | null
  severity?: 'warning' | 'critical' | 'info'
  event_status?: 'active' | 'resolved'
  device_name?: string | null
  channel: string
  target?: string | null
  status: 'pending' | 'sending' | 'sent' | 'failed'
  subject?: string | null
  message?: string | null
  error?: string | null
  retry_count: number
  created_at: string
  sent_at?: string | null
  updated_at?: string
}

export interface DiscoveryJob {
  id: string
  cidr: string
  port: number
  snmp_version: '2c'
  community?: string
  timeout_ms: number
  retries: number
  concurrency: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled'
  total_hosts: number
  scanned_hosts: number
  discovered_hosts: number
  error_message?: string | null
  started_at?: string | null
  finished_at?: string | null
  created_at: string
  updated_at: string
}

export interface DiscoveryResult {
  id: string
  job_id: string
  host: string
  port: number
  snmp_version: '2c'
  sys_name?: string | null
  sys_descr?: string | null
  sys_object_id?: string | null
  response_ms?: number | null
  status: 'discovered' | 'imported'
  device_id?: string | null
  device_name?: string | null
  error_message?: string | null
  discovered_at: string
  imported_at?: string | null
}

export interface TopologyMap {
  id: string
  name: string
  description?: string | null
  is_default: boolean
  created_at?: string
  updated_at?: string
}

export interface TopologyNode {
  id: string
  map_id: string
  device_id?: string | null
  device_name?: string | null
  device_host?: string | null
  device_enabled?: boolean | null
  group_name?: string | null
  label: string
  node_type: 'device' | 'network' | 'custom'
  x: string | number
  y: string | number
  width: string | number
  height: string | number
  created_at?: string
  updated_at?: string
}

export interface TopologyLink {
  id: string
  map_id: string
  source_node_id: string
  target_node_id: string
  source_interface_id?: string | null
  source_interface_name?: string | null
  target_interface_id?: string | null
  target_interface_name?: string | null
  label?: string | null
  link_type: 'manual' | 'lldp' | 'cdp'
  status: 'unknown' | 'up' | 'down'
  discovery_protocol?: string | null
  neighbor_id?: string | null
  auto_discovered?: boolean
  last_seen_at?: string | null
  created_at?: string
  updated_at?: string
}

export interface TopologyData {
  map: TopologyMap
  nodes: TopologyNode[]
  links: TopologyLink[]
}

export interface DeviceNeighbor {
  id: string
  device_id: string
  device_name: string
  device_host: string
  local_interface_id?: string | null
  local_interface_name?: string | null
  local_if_index?: number | null
  local_port_id?: string | null
  local_port_descr?: string | null
  protocol: 'lldp' | 'cdp'
  remote_chassis_id?: string | null
  remote_device_name?: string | null
  remote_port_id?: string | null
  remote_port_descr?: string | null
  remote_mgmt_address?: string | null
  remote_sys_name?: string | null
  remote_sys_descr?: string | null
  remote_device_id?: string | null
  remote_device_name_matched?: string | null
  remote_interface_id?: string | null
  remote_interface_name?: string | null
  first_seen_at: string
  last_seen_at: string
  stale: boolean
}

export interface AutoSyncTopologyResponse {
  created_nodes: number
  updated_links: number
  topology: TopologyData
}

export interface CreateDiscoveryJobPayload {
  cidr: string
  port: number
  community: string
  timeout_ms: number
  retries: number
  concurrency: number
}

export interface ImportDiscoveryResultsPayload {
  resultIds: string[]
  group_id?: string | null
  enabled?: boolean
}

export interface ImportDiscoveryResultsResponse {
  imported: Device[]
  skipped: Array<{ resultId: string; reason: string; deviceId?: string }>
}

export async function getHealth(): Promise<HealthStatus> {
  return request('/health')
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  return request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
}

export async function getCurrentUser(): Promise<{ user: AuthUser }> {
  return request('/api/auth/me')
}

export async function listDevices(): Promise<Device[]> {
  return request('/api/devices')
}

export async function createDevice(payload: CreateDevicePayload): Promise<Device> {
  return request('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function updateDevice(id: string, payload: Partial<CreateDevicePayload>): Promise<Device> {
  return request(`/api/devices/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function deleteDevice(id: string): Promise<Device> {
  return request(`/api/devices/${id}`, {
    method: 'DELETE'
  })
}

export async function listDeviceGroups(): Promise<DeviceGroup[]> {
  return request('/api/device-groups')
}

export async function createDeviceGroup(payload: Pick<DeviceGroup, 'name' | 'description' | 'template_id'>): Promise<DeviceGroup> {
  return request('/api/device-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function updateDeviceGroup(id: string, payload: Partial<Pick<DeviceGroup, 'name' | 'description' | 'template_id'>>): Promise<DeviceGroup> {
  return request(`/api/device-groups/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function listMetricDefinitions(): Promise<MetricDefinition[]> {
  return request('/api/metrics/definitions')
}

export async function listOidTemplates(): Promise<OidTemplate[]> {
  return request('/api/metrics/templates')
}

export async function createOidTemplate(payload: Pick<OidTemplate, 'name' | 'description' | 'enabled'>): Promise<OidTemplate> {
  return request('/api/metrics/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function listTemplateDefinitions(templateId: string): Promise<MetricDefinition[]> {
  return request(`/api/metrics/templates/${templateId}/definitions`)
}

export async function addTemplateDefinition(templateId: string, metricId: string, sortOrder = 0): Promise<unknown> {
  return request(`/api/metrics/templates/${templateId}/definitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metric_id: metricId, sort_order: sortOrder })
  })
}

export async function listMetricSamples(params: Record<string, string | number> = {}): Promise<MetricSample[]> {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => query.set(key, String(value)))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request(`/api/metrics/samples${suffix}`)
}

export async function listInterfaces(params: Record<string, string | number> = {}): Promise<DeviceInterface[]> {
  return request(`/api/interfaces${querySuffix(params)}`)
}

export async function listInterfaceSamples(params: Record<string, string | number> = {}): Promise<InterfaceMetricSample[]> {
  return request(`/api/interfaces/samples${querySuffix(params)}`)
}

export async function getCpuChart(params: Record<string, string | number> = {}): Promise<ChartPoint[]> {
  return request(`/api/charts/cpu${querySuffix(params)}`)
}

export async function getMemoryChart(params: Record<string, string | number> = {}): Promise<ChartPoint[]> {
  return request(`/api/charts/memory${querySuffix(params)}`)
}

export async function getInterfaceTrafficChart(params: Record<string, string | number> = {}): Promise<ChartPoint[]> {
  return request(`/api/charts/interface-traffic${querySuffix(params)}`)
}

export async function getInterfaceStatusChart(params: Record<string, string | number> = {}): Promise<InterfaceStatusPoint[]> {
  return request(`/api/charts/interface-status${querySuffix(params)}`)
}

export async function getCollectionTrendChart(params: Record<string, string | number> = {}): Promise<ChartPoint[]> {
  return request(`/api/charts/collection-trend${querySuffix(params)}`)
}

export async function getAlertSummary(): Promise<AlertSummary> {
  return request('/api/alerts/summary')
}

export async function listAlertRules(): Promise<AlertRule[]> {
  return request('/api/alerts/rules')
}

export async function createAlertRule(payload: Partial<AlertRule>): Promise<AlertRule> {
  return request('/api/alerts/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function updateAlertRule(id: string, payload: Partial<AlertRule>): Promise<AlertRule> {
  return request(`/api/alerts/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function listAlertEvents(params: Record<string, string | number> = {}): Promise<AlertEvent[]> {
  return request(`/api/alerts/events${querySuffix(params)}`)
}

export async function resolveAlertEvent(id: string): Promise<AlertEvent> {
  return request(`/api/alerts/events/${id}/resolve`, {
    method: 'PATCH'
  })
}

export async function listAlertNotifications(params: Record<string, string | number> = {}): Promise<AlertNotification[]> {
  return request(`/api/alerts/notifications${querySuffix(params)}`)
}

export async function retryAlertNotification(id: string): Promise<AlertNotification> {
  return request(`/api/alerts/notifications/${id}/retry`, {
    method: 'PATCH'
  })
}

export async function createDiscoveryJob(payload: CreateDiscoveryJobPayload): Promise<DiscoveryJob> {
  return request('/api/discovery/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function listDiscoveryJobs(params: Record<string, string | number> = {}): Promise<DiscoveryJob[]> {
  return request(`/api/discovery/jobs${querySuffix(params)}`)
}

export async function getDiscoveryJob(id: string): Promise<DiscoveryJob> {
  return request(`/api/discovery/jobs/${id}`)
}

export async function cancelDiscoveryJob(id: string): Promise<DiscoveryJob> {
  return request(`/api/discovery/jobs/${id}/cancel`, {
    method: 'PATCH'
  })
}

export async function listDiscoveryResults(jobId: string, params: Record<string, string | number> = {}): Promise<DiscoveryResult[]> {
  return request(`/api/discovery/jobs/${jobId}/results${querySuffix(params)}`)
}

export async function importDiscoveryResults(payload: ImportDiscoveryResultsPayload): Promise<ImportDiscoveryResultsResponse> {
  return request('/api/discovery/results/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function getDefaultTopology(): Promise<TopologyData> {
  return request('/api/topology/default')
}

export async function listTopologyNeighbors(params: Record<string, string | number> = {}): Promise<DeviceNeighbor[]> {
  return request(`/api/topology/neighbors${querySuffix(params)}`)
}

export async function syncAutoTopology(): Promise<AutoSyncTopologyResponse> {
  return request('/api/topology/default/auto-sync', {
    method: 'POST'
  })
}

export async function createTopologyNode(payload: Partial<TopologyNode>): Promise<TopologyNode> {
  return request('/api/topology/default/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function updateTopologyNode(id: string, payload: Partial<TopologyNode>): Promise<TopologyNode> {
  return request(`/api/topology/nodes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function deleteTopologyNode(id: string): Promise<{ id: string }> {
  return request(`/api/topology/nodes/${id}`, {
    method: 'DELETE'
  })
}

export async function createTopologyLink(payload: Partial<TopologyLink>): Promise<TopologyLink> {
  return request('/api/topology/default/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function updateTopologyLink(id: string, payload: Partial<TopologyLink>): Promise<TopologyLink> {
  return request(`/api/topology/links/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function deleteTopologyLink(id: string): Promise<{ id: string }> {
  return request(`/api/topology/links/${id}`, {
    method: 'DELETE'
  })
}

export async function saveTopologyLayout(nodes: Array<{ id: string; x: number; y: number; width?: number; height?: number }>): Promise<TopologyData> {
  return request('/api/topology/default/layout', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes })
  })
}

function querySuffix(params: Record<string, string | number>): string {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => query.set(key, String(value)))
  return query.toString() ? `?${query.toString()}` : ''
}

export const authTokenKey = 'snmp-monitor-token'

export function getAuthToken(): string {
  return localStorage.getItem(authTokenKey) || ''
}

export function setAuthToken(token: string): void {
  localStorage.setItem(authTokenKey, token)
}

export function clearAuthToken(): void {
  localStorage.removeItem(authTokenKey)
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers)
  const token = getAuthToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(path, {
    ...options,
    headers
  })
  if (!response.ok) {
    if (response.status === 401) {
      clearAuthToken()
    }
    const error = await response.json().catch(() => null)
    if (error?.message) {
      throw new Error(error.message)
    }
    throw new Error(`请求失败：${response.status}`)
  }
  return response.json() as Promise<T>
}
