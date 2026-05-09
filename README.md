# SNMP Monitoring Platform

这是一个基于 Docker 编排的 SNMP 网络设备监控平台骨架，包含 Go SNMP 采集器、Fastify API 网关、Vue 3 管理前端和 PostgreSQL 数据库。

## 技术栈

- **采集引擎**：Go + `gosnmp`
- **API 网关**：Node.js + Fastify
- **前端界面**：Vue 3 + TypeScript + Element Plus + Vite + Nginx
- **数据库**：PostgreSQL 16
- **部署方式**：Docker Compose

## 项目结构

```text
.
├── api-gateway/          # Fastify API 网关
├── collector-go/         # Go SNMP 采集器
├── postgres/             # PostgreSQL schema 与默认数据
├── scripts/              # 本地辅助脚本
├── web-vue3/             # Vue 3 前端
├── docker-compose.yml    # Docker Compose 编排
└── README.md             # 项目说明
```

## Docker 快速启动

```powershell
docker compose up -d --build
```

启动后访问：

- Web UI：`http://localhost:15173`
- API Gateway：`http://localhost:13000`
- API Health：`http://localhost:13000/health`
- PostgreSQL：`localhost:5432`

停止服务：

```powershell
docker compose down
```

停止服务并清理数据库卷：

```powershell
docker compose down -v
```

## 容器说明

### `snmp-monitor-postgres`

PostgreSQL 数据库容器。

**镜像**

- `postgres:16-alpine`

**端口**

- 容器内：`5432`
- 宿主机：`5432`

**数据库连接**

- database：`snmp_monitor`
- username：`snmp`
- password：`snmp`
- URL：`postgres://snmp:snmp@localhost:5432/snmp_monitor?sslmode=disable`

**主要功能**

- 保存设备配置
- 保存 OID 指标定义
- 保存 SNMP 采集样本
- 为 API Gateway 提供查询数据
- 为 Go Collector 提供采集任务与写入目标

**初始化脚本**

- `postgres/schema.sql`：创建表结构和索引
- `postgres/seed.sql`：写入默认演示数据

**核心表**

| 表名 | 说明 |
| --- | --- |
| `devices` | 网络设备配置，例如名称、IP、端口、community、是否启用 |
| `metric_definitions` | SNMP OID 指标定义，例如 `sysUpTime`、`ifNumber` |
| `metric_samples` | 采集结果样本，按设备和指标保存 |

### `snmp-monitor-api`

Node.js Fastify API 网关容器。

**构建目录**

- `api-gateway/`

**端口**

- 容器内：`3000`
- 宿主机：`13000`

**主要功能**

- 对外提供 HTTP API
- 连接 PostgreSQL 查询设备、指标和样本数据
- 给 Vue 前端提供统一后端接口
- 处理跨域配置
- 后续可扩展登录、JWT、权限、告警、任务管理等能力

**环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Fastify 监听端口 |
| `HOST` | `0.0.0.0` | Fastify 监听地址 |
| `DATABASE_URL` | `postgres://snmp:snmp@postgres:5432/snmp_monitor?sslmode=disable` | 容器内数据库连接地址 |
| `WEB_ORIGIN` | `http://localhost:15173` | 前端跨域来源 |

### `snmp-monitor-collector`

Go SNMP 采集器容器。

**构建目录**

- `collector-go/`

**主要功能**

- 从 PostgreSQL 读取启用的设备
- 从 PostgreSQL 读取启用的 OID 指标定义
- 使用 `gosnmp` 连接设备执行 SNMP 采集
- 将采集结果写入 `metric_samples`
- 使用 worker pool 控制并发采集数量
- 支持采集周期、超时、重试、worker 数量配置

**环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://snmp:snmp@postgres:5432/snmp_monitor?sslmode=disable` | 数据库连接地址 |
| `COLLECT_INTERVAL_SECONDS` | `60` | 采集周期，单位秒 |
| `SNMP_TIMEOUT_SECONDS` | `3` | SNMP 请求超时，单位秒 |
| `SNMP_RETRIES` | `1` | SNMP 请求重试次数 |
| `WORKER_COUNT` | `16` | 并发采集 worker 数量 |
| `SNMP_COMMUNITY` | `public` | 默认 community，设备未单独配置时使用 |

**当前采集逻辑**

1. 启动后立即执行一次采集。
2. 按 `COLLECT_INTERVAL_SECONDS` 周期循环采集。
3. 查询 `devices.enabled = true` 的设备。
4. 查询 `metric_definitions.enabled = true` 的 OID。
5. 对每台设备执行 SNMP `Get`。
6. 将结果写入 `metric_samples`。

> 默认 seed 数据中的设备 `enabled=false`，这是为了避免本机没有 SNMP 服务时采集器持续输出连接失败日志。你可以通过 API 或数据库把设备启用后进行真实采集。

### `snmp-monitor-web`

Vue 3 前端容器。

**构建目录**

- `web-vue3/`

**端口**

- 容器内：`80`
- 宿主机：`15173`

**主要功能**

- 提供 Web 管理控制台
- 提供本地演示登录页
- 展示监控概览
- 展示设备列表
- 添加 SNMP 设备
- 展示最新采集样本
- 通过 Nginx 反向代理访问 API Gateway

**前端页面**

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/login` | 登录页 | 本地演示登录，默认账号 `admin / admin123` |
| `/dashboard` | 监控概览 | 展示 API 状态、设备数量、指标数量、最新样本 |
| `/devices` | 设备管理 | 查询设备、搜索设备、添加设备 |
| `/latest` | 最新数据 | 展示最近采集样本 |

**Nginx 代理**

前端容器内 Nginx 会把下面路径代理到 API Gateway：

| 前端访问路径 | 转发目标 |
| --- | --- |
| `/api/*` | `http://api-gateway:3000/api/*` |
| `/health` | `http://api-gateway:3000/health` |

## API 接口

API Gateway 对外地址：

```text
http://localhost:13000
```

前端容器代理地址：

```text
http://localhost:15173
```

### 健康检查

#### `GET /health`

检查 API Gateway 和 PostgreSQL 是否可用。

**示例**

```powershell
curl http://localhost:13000/health
```

**响应**

```json
{
  "status": "ok",
  "databaseTime": "2026-05-09T09:25:37.475Z"
}
```

### 设备接口

#### `GET /api/devices`

查询设备列表。

**示例**

```powershell
curl http://localhost:13000/api/devices
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 设备 ID |
| `name` | string | 设备名称 |
| `host` | string | 设备 IP |
| `port` | number | SNMP 端口 |
| `enabled` | boolean | 是否启用采集 |
| `created_at` | string | 创建时间 |

#### `POST /api/devices`

新增设备。

**请求体**

```json
{
  "name": "Core Switch 02",
  "host": "192.0.2.20",
  "port": 161,
  "community": "public",
  "enabled": false
}
```

**说明**

- `name`：必填，设备名称
- `host`：必填，设备 IP
- `port`：可选，默认 `161`
- `community`：可选，默认 `public`
- `enabled`：可选，默认 `true`

**示例**

```powershell
curl -X POST http://localhost:13000/api/devices `
  -H "Content-Type: application/json" `
  -d "{\"name\":\"Core Switch 02\",\"host\":\"192.0.2.20\",\"port\":161,\"community\":\"public\",\"enabled\":false}"
```

#### `PATCH /api/devices/:id`

更新设备。

**请求体**

```json
{
  "name": "Core Switch 02",
  "host": "192.0.2.20",
  "port": 161,
  "community": "public",
  "enabled": true
}
```

所有字段都是可选字段，只会更新传入的字段。

**示例**

```powershell
curl -X PATCH http://localhost:13000/api/devices/1 `
  -H "Content-Type: application/json" `
  -d "{\"enabled\":true}"
```

### 指标接口

#### `GET /api/metrics/definitions`

查询 SNMP OID 指标定义。

**示例**

```powershell
curl http://localhost:13000/api/metrics/definitions
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 指标 ID |
| `name` | string | 指标名称 |
| `oid` | string | SNMP OID |
| `unit` | string | 单位 |
| `enabled` | boolean | 是否启用 |

#### `GET /api/metrics/samples`

查询采集样本。

**查询参数**

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | number | 空 | 按设备 ID 过滤 |
| `limit` | number | `200` | 返回条数 |

**示例**

```powershell
curl "http://localhost:13000/api/metrics/samples?limit=10"
```

按设备过滤：

```powershell
curl "http://localhost:13000/api/metrics/samples?deviceId=1&limit=20"
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `created_at` | string | 采集时间 |
| `device_name` | string | 设备名称 |
| `metric_name` | string | 指标名称 |
| `unit` | string | 单位 |
| `value_text` | string | 采集值 |

## 默认数据

Docker 初始化 PostgreSQL 时会自动写入默认数据。

### 默认设备

| 名称 | IP | SNMP 端口 | Community | 是否启用 |
| --- | --- | --- | --- | --- |
| `Demo Router` | `127.0.0.1` | `161` | `public` | `false` |
| `Core Switch 01` | `192.0.2.10` | `161` | `public` | `false` |
| `Edge Switch 01` | `192.0.2.11` | `161` | `public` | `false` |

### 默认指标定义

| 名称 | OID | 单位 |
| --- | --- | --- |
| `sysUpTime` | `.1.3.6.1.2.1.1.3.0` | `ticks` |
| `ifNumber` | `.1.3.6.1.2.1.2.1.0` | `count` |

### 默认样本

默认会写入 6 条演示样本，用于前端 Dashboard 和最新数据页展示。

## 常用验证命令

查看容器状态：

```powershell
docker compose ps
```

查看 API 健康状态：

```powershell
curl http://localhost:13000/health
```

查看设备列表：

```powershell
curl http://localhost:13000/api/devices
```

查看最新样本：

```powershell
curl "http://localhost:13000/api/metrics/samples?limit=10"
```

查看数据库数据量：

```powershell
docker exec snmp-monitor-postgres psql -U snmp -d snmp_monitor -c "select (select count(*) from devices) as devices, (select count(*) from metric_definitions) as metric_definitions, (select count(*) from metric_samples) as metric_samples;"
```

查看采集器日志：

```powershell
docker logs snmp-monitor-collector --tail 100
```

查看 API 日志：

```powershell
docker logs snmp-monitor-api --tail 100
```

查看 Web 日志：

```powershell
docker logs snmp-monitor-web --tail 100
```

## 本地开发

### API Gateway

```powershell
cd api-gateway
npm install
npm run dev
```

本地 API 默认监听：

```text
http://localhost:3000
```

### Web UI

```powershell
cd web-vue3
npm install
npm run dev
```

本地 Vite 默认监听：

```text
http://localhost:5173
```

> 注意：Docker 里的 Web UI 使用 `15173`，本地 Vite 开发使用 `5173`。

### Go Collector

```powershell
cd collector-go
go mod tidy
go run .
```

如果本机 Go 没加入 PATH，可以使用完整路径：

```powershell
& "C:\Program Files\Go\bin\go.exe" run .
```

## 当前限制与后续建议

当前项目是可运行骨架，适合继续扩展。

建议后续增强：

- API Gateway 增加真实登录、JWT 和权限控制
- 设备管理增加删除、批量启停、SNMP v3 参数配置
- 指标管理增加 OID 模板、设备分组、接口表采集
- 采集器增加 `GetBulk`、批量写入、失败重试记录
- PostgreSQL 指标样本表增加时间分区或 TimescaleDB
- 前端增加趋势图、告警中心、任务状态和采集器节点状态
