export interface Device {
  id: string
  name: string
  host: string
  port: number
  enabled: boolean
  created_at?: string
}

export interface MetricDefinition {
  id: string
  name: string
  oid: string
  unit: string
  enabled: boolean
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

export interface CreateDevicePayload {
  name: string
  host: string
  port?: number
  community?: string
  enabled?: boolean
}

export async function getHealth(): Promise<HealthStatus> {
  return request('/health')
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

export async function listMetricDefinitions(): Promise<MetricDefinition[]> {
  return request('/api/metrics/definitions')
}

export async function listMetricSamples(params: Record<string, string | number> = {}): Promise<MetricSample[]> {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => query.set(key, String(value)))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request(`/api/metrics/samples${suffix}`)
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options)
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`)
  }
  return response.json() as Promise<T>
}
