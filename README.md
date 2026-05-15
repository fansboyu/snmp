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

仓库根目录已内置默认 `.env`，克隆后可直接构建启动；生产环境建议至少修改 `JWT_SECRET` 和 `ADMIN_PASSWORD`。

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

> `docker compose down -v` 会清空数据库卷。若只是想重新加载初始化数据，可优先执行：
>
> ```powershell
> docker exec snmp-monitor-postgres psql -U snmp -d snmp_monitor -f /docker-entrypoint-initdb.d/002-seed.sql
> docker restart snmp-monitor-collector
> ```

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
- `postgres/seed.sql`：初始化空种子，不写入演示设备

**核心表**

| 表名 | 说明 |
| --- | --- |
| `devices` | 网络设备配置，例如名称、IP、端口、SNMP v2c community、SNMP v3 认证参数、是否启用 |
| `device_groups` | 设备分组配置，绑定 OID 模板 |
| `oid_templates` | OID 模板配置 |
| `oid_template_definitions` | OID 模板和指标定义的绑定关系 |
| `metric_definitions` | SNMP OID 指标定义，例如 `sysUpTime`、`ifNumber` |
| `metric_samples` | 采集结果样本，按设备和指标保存 |
| `device_interfaces` | 设备接口清单，按 `ifIndex` 维护最新接口信息 |
| `interface_metric_samples` | 接口表采集样本，按设备、接口和指标保存 |
| `alert_rules` | 告警规则，例如 CPU 阈值、接口 Down |
| `alert_events` | 告警事件，记录 active/resolved 状态 |
| `alert_notifications` | 告警通知记录，预留 Web/邮件/企业 IM 等渠道 |
| `topology_maps` | 拓扑图配置，当前内置默认拓扑 |
| `topology_nodes` | 拓扑节点，支持绑定设备或自定义节点 |
| `topology_links` | 拓扑连线，支持手动链路和接口引用 |

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
- 支持 SNMP v2c 与 SNMP v3（noAuthNoPriv、authNoPriv、authPriv）
- 使用 worker pool 控制并发采集数量
- 接口表指标优先使用 GetBulk，失败时自动回退到普通 Walk
- 支持采集周期、超时、重试、worker 数量配置

**环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://snmp:snmp@postgres:5432/snmp_monitor?sslmode=disable` | 数据库连接地址 |
| `COLLECT_INTERVAL_SECONDS` | `60` | 采集周期，单位秒 |
| `CLEANUP_INTERVAL_SECONDS` | `3600` | 历史数据清理周期，单位秒；小于等于 `0` 表示关闭 |
| `METRIC_SAMPLE_RETENTION_DAYS` | `30` | 标量样本保留天数；小于等于 `0` 表示不清理 |
| `INTERFACE_SAMPLE_RETENTION_DAYS` | `30` | 接口样本保留天数；小于等于 `0` 表示不清理 |
| `RESOLVED_ALERT_RETENTION_DAYS` | `90` | 已恢复告警事件保留天数；小于等于 `0` 表示不清理 |
| `CLEANUP_BATCH_SIZE` | `5000` | 单批删除行数，避免一次清理大表锁太久 |
| `SNMP_TIMEOUT_SECONDS` | `3` | SNMP 请求超时，单位秒 |
| `SNMP_RETRIES` | `1` | SNMP 请求重试次数 |
| `WORKER_COUNT` | `16` | 并发采集 worker 数量 |
| `GETBULK_MAX_REPETITIONS` | `25` | 接口表 GetBulk 每次请求最大重复数；设为 `0` 使用 `gosnmp` 默认值 |
| `SNMP_COMMUNITY` | `public` | 默认 community，设备未单独配置时使用 |
| `ALERT_EMAIL_ENABLED` | `false` | 是否在告警触发时写入邮件通知队列 |
| `ALERT_EMAIL_TO` | 空 | 告警邮件收件人，多个邮箱用英文逗号分隔 |
| `ALERT_EMAIL_SEND_RESOLVED` | `true` | 告警恢复时是否写入恢复邮件通知 |
| `ALERT_EMAIL_SUBJECT_PREFIX` | `[SNMP Monitor]` | 告警邮件标题前缀 |

**当前采集逻辑**

1. 启动后立即执行一次采集。
2. 按 `COLLECT_INTERVAL_SECONDS` 周期循环采集。
3. 查询 `devices.enabled = true` 的设备。
4. 按设备分组加载绑定的 OID 模板。
5. 标量指标执行 SNMP `Get`，接口表指标优先执行 SNMP `BulkWalk`，失败时回退到 `Walk`。
6. 写入 `metric_samples`、`device_interfaces` 和 `interface_metric_samples`。
7. 根据 CPU 阈值和接口 Down 规则生成或恢复告警事件。
8. 邮件通知启用时，告警首次触发和恢复会写入 `alert_notifications` 队列。
9. 按保留策略定时分批清理历史样本和已恢复告警事件。

> 默认不包含内置 SNMP Agent 容器。请先在 `devices` 中添加你自己的 SNMP 设备，采集器才会开始产生样本。

### `snmp-monitor-notifier`

邮件通知发送器容器。

**构建目录**

- `collector-go/`
- 使用 `collector-go/Dockerfile.notifier`

**主要功能**

- 轮询 `alert_notifications` 中的 `email/pending` 任务。
- 通过 SMTP 发送邮件。
- 发送成功标记为 `sent`，失败后按 1 分钟、5 分钟、15 分钟重试，超过次数标记为 `failed`。
- 启动时会把超时卡住的 `sending` 任务重置为 `pending`。

**环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://snmp:snmp@postgres:5432/snmp_monitor?sslmode=disable` | 数据库连接地址 |
| `SMTP_HOST` | 空 | SMTP 服务器地址 |
| `SMTP_PORT` | `587` | SMTP 端口 |
| `SMTP_USERNAME` | 空 | SMTP 用户名 |
| `SMTP_PASSWORD` | 空 | SMTP 密码 |
| `SMTP_FROM` | 空 | 发件人地址 |
| `SMTP_TLS_MODE` | `starttls` | TLS 模式，支持 `starttls`、`implicit`、`none` |
| `SMTP_TIMEOUT_SECONDS` | `10` | SMTP 连接超时 |
| `SMTP_POLL_INTERVAL_SECONDS` | `10` | 通知队列轮询周期 |
| `SMTP_BATCH_SIZE` | `50` | 每轮最多处理通知数 |
| `SMTP_MAX_RETRIES` | `3` | 最大发送尝试次数 |

示例：

```powershell
$env:ALERT_EMAIL_ENABLED="true"
$env:ALERT_EMAIL_TO="ops@example.com,admin@example.com"
$env:SMTP_HOST="smtp.example.com"
$env:SMTP_PORT="587"
$env:SMTP_USERNAME="monitor@example.com"
$env:SMTP_PASSWORD="your-password"
$env:SMTP_FROM="monitor@example.com"
docker compose up -d --build
```

### `snmp-monitor-discovery-worker`

SNMP 自动发现任务执行器容器。

**构建目录**

- `collector-go/`
- 使用 `collector-go/Dockerfile.discovery`

**主要功能**

- 轮询 `discovery_jobs` 中的 `pending` 任务。
- 按 CIDR 扫描 SNMP v2c 设备，当前 MVP 支持单 community。
- 读取 `sysName`、`sysDescr`、`sysObjectID` 并写入 `discovery_results`。
- 更新任务进度，发现结果需要在前端手动导入为设备。

**环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://snmp:snmp@postgres:5432/snmp_monitor?sslmode=disable` | 数据库连接地址 |
| `DISCOVERY_POLL_INTERVAL_SECONDS` | `5` | 发现任务轮询周期 |
| `DISCOVERY_STALE_RUNNING_SECONDS` | `1800` | running 任务卡住后的失败判定时间 |

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
- 展示监控概览、CPU 趋势、接口流量、接口状态和采集趋势图表
- 展示设备列表，设备名称可点击进入单设备监控详情
- 添加 SNMP 设备
- 管理 OID 模板、设备分组和接口表数据
- 展示最新采集样本
- 支持从 LLDP/CDP 邻居自动生成网络拓扑节点和链路，也可手工维护画布布局
- 左侧侧边栏支持收起和展开，用户信息固定在侧边栏底部
- 通过 Nginx 反向代理访问 API Gateway

**前端页面**

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/login` | 登录页 | 本地演示登录，默认账号 `admin / admin123` |
| `/dashboard` | 监控概览 | 展示 API 状态、统计卡片、CPU、接口流量、接口状态和采集趋势 |
| `/devices` | 设备管理 | 查询设备、搜索设备、添加设备，点击设备名称进入详情 |
| `/discovery` | 自动发现 | 创建 SNMP v2c CIDR 发现任务，查看结果并手动导入设备 |
| `/topology` | 网络拓扑 | 自动同步 LLDP/CDP 邻居生成节点和链路，也支持手动添加设备/自定义节点 |
| `/devices/:id` | 设备监控 | 展示单设备 CPU、接口状态、采集趋势、接口清单和各接口流量图 |
| `/metrics` | 指标管理 | 管理 OID 模板、设备分组和接口表数据 |
| `/alerts` | 告警中心 | 查看告警统计、当前/历史事件，管理告警规则 |
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
| `group_id` | string | 设备分组 ID |
| `group_name` | string | 设备分组名称 |
| `community` | string | SNMP v2c community |
| `snmp_version` | string | SNMP 版本，当前支持 `2c`、`3` |
| `snmp_v3_username` | string | SNMP v3 用户名 |
| `snmp_v3_security_level` | string | SNMP v3 安全级别 |
| `snmp_v3_auth_protocol` | string | SNMP v3 认证算法 |
| `snmp_v3_auth_passphrase` | string | SNMP v3 认证密码 |
| `snmp_v3_priv_protocol` | string | SNMP v3 加密算法 |
| `snmp_v3_priv_passphrase` | string | SNMP v3 加密密码 |
| `snmp_v3_context_name` | string | SNMP v3 ContextName，可选 |
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
  "group_id": "1",
  "snmp_version": "2c",
  "community": "public",
  "enabled": false
}
```

**说明**

- `name`：必填，设备名称
- `host`：必填，设备 IP
- `port`：可选，默认 `161`
- `group_id`：可选，设备分组 ID
- `snmp_version`：可选，默认 `2c`，可填 `2c` 或 `3`
- `community`：可选，默认 `public`
- `snmp_v3_username`：SNMP v3 用户名，`snmp_version=3` 时必填
- `snmp_v3_security_level`：SNMP v3 安全级别，支持 `noAuthNoPriv`、`authNoPriv`、`authPriv`
- `snmp_v3_auth_protocol`：认证算法，支持 `MD5`、`SHA`、`SHA224`、`SHA256`、`SHA384`、`SHA512`
- `snmp_v3_auth_passphrase`：认证密码，`authNoPriv` 和 `authPriv` 时填写
- `snmp_v3_priv_protocol`：加密算法，支持 `DES`、`AES`、`AES192`、`AES256`、`AES192C`、`AES256C`
- `snmp_v3_priv_passphrase`：加密密码，`authPriv` 时填写
- `snmp_v3_context_name`：可选，部分设备或 VRF 场景需要
- `enabled`：可选，默认 `true`

**示例**

```powershell
curl -X POST http://localhost:13000/api/devices `
  -H "Content-Type: application/json" `
  -d "{\"name\":\"Core Switch 02\",\"host\":\"192.0.2.20\",\"port\":161,\"snmp_version\":\"2c\",\"community\":\"public\",\"enabled\":false}"
```

**SNMP v3 示例**

noAuthNoPriv：

```powershell
curl -X POST http://localhost:13000/api/devices `
  -H "Content-Type: application/json" `
  -d "{\"name\":\"Router v3 NoAuth\",\"host\":\"192.0.2.31\",\"snmp_version\":\"3\",\"snmp_v3_username\":\"monitor\",\"snmp_v3_security_level\":\"noAuthNoPriv\",\"enabled\":true}"
```

authNoPriv：

```powershell
curl -X POST http://localhost:13000/api/devices `
  -H "Content-Type: application/json" `
  -d "{\"name\":\"Router v3 Auth\",\"host\":\"192.0.2.32\",\"snmp_version\":\"3\",\"snmp_v3_username\":\"monitor\",\"snmp_v3_security_level\":\"authNoPriv\",\"snmp_v3_auth_protocol\":\"SHA256\",\"snmp_v3_auth_passphrase\":\"auth-password\",\"enabled\":true}"
```

authPriv：

```powershell
curl -X POST http://localhost:13000/api/devices `
  -H "Content-Type: application/json" `
  -d "{\"name\":\"Router v3 Priv\",\"host\":\"192.0.2.33\",\"snmp_version\":\"3\",\"snmp_v3_username\":\"monitor\",\"snmp_v3_security_level\":\"authPriv\",\"snmp_v3_auth_protocol\":\"SHA256\",\"snmp_v3_auth_passphrase\":\"auth-password\",\"snmp_v3_priv_protocol\":\"AES\",\"snmp_v3_priv_passphrase\":\"priv-password\",\"enabled\":true}"
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
| `metric_kind` | string | 指标类型，`scalar` 或 `interface` |
| `table_oid` | string | 接口表基础 OID |
| `enabled` | boolean | 是否启用 |

#### `GET /api/metrics/templates`

查询 OID 模板列表。

#### `POST /api/metrics/templates`

新增 OID 模板，字段包括 `name`、`description`、`enabled`。

#### `GET /api/metrics/templates/:id/definitions`

查询模板绑定的指标定义。

#### `POST /api/metrics/templates/:id/definitions`

向模板加入指标定义，字段包括 `metric_id`、`sort_order`。

#### `GET /api/device-groups`

查询设备分组列表，包含绑定模板和设备数量。

#### `POST /api/device-groups`

新增设备分组，字段包括 `name`、`description`、`template_id`。

#### `GET /api/interfaces`

查询接口清单，可使用 `deviceId`、`groupId` 过滤。

#### `GET /api/interfaces/samples`

查询接口表样本，可使用 `deviceId`、`interfaceId`、`metric`、`limit` 过滤。

### 自动发现接口

#### `POST /api/discovery/jobs`

创建 SNMP v2c 自动发现任务。MVP 支持单 community 和 IPv4 CIDR，默认限制最大 256 个地址。

**请求体**

```json
{
  "cidr": "172.28.0.0/28",
  "port": 161,
  "community": "public",
  "timeout_ms": 1000,
  "retries": 0,
  "concurrency": 16
}
```

#### `GET /api/discovery/jobs`

查询发现任务列表。

#### `GET /api/discovery/jobs/:id`

查询单个发现任务进度。

#### `GET /api/discovery/jobs/:id/results`

查询发现结果。

#### `POST /api/discovery/results/import`

将发现结果手动导入 `devices`。默认建议 `enabled=false`，确认后再启用采集。

```json
{
  "resultIds": ["1", "2"],
  "group_id": "1",
  "enabled": false
}
```

#### `PATCH /api/discovery/jobs/:id/cancel`

取消等待中或运行中的发现任务。

### 拓扑接口

#### `GET /api/topology/default`

查询默认拓扑图，返回拓扑图元信息、节点和连线。若默认拓扑不存在，API 会自动创建。

#### `POST /api/topology/default/auto-sync`

根据已采集的 LLDP/CDP 邻居自动生成拓扑节点和连线，并返回更新后的默认拓扑数据。

#### `POST /api/topology/default/nodes`

新增拓扑节点。设备节点传入 `device_id`，自定义节点只需传入 `label` 和 `node_type`。

```json
{
  "device_id": "1",
  "label": "Core Switch",
  "node_type": "device",
  "x": 80,
  "y": 80
}
```

#### `PATCH /api/topology/nodes/:id`

更新节点名称、类型、坐标或尺寸。

#### `DELETE /api/topology/nodes/:id`

删除节点，并级联删除该节点相关连线。

#### `POST /api/topology/default/links`

新增手动连线。

```json
{
  "source_node_id": "1",
  "target_node_id": "2",
  "label": "Gi0/1 - Gi0/2",
  "status": "unknown",
  "link_type": "manual"
}
```

#### `PATCH /api/topology/links/:id`

更新连线标签、类型、状态或接口引用。

#### `DELETE /api/topology/links/:id`

删除连线。

#### `PATCH /api/topology/default/layout`

批量保存默认拓扑中节点的画布坐标和尺寸。

### 图表接口

#### `GET /api/charts/cpu`

查询 CPU 使用率趋势，可使用 `deviceId`、`range` 过滤。`range` 支持 `1h`、`6h`、`24h`。

#### `GET /api/charts/interface-traffic`

查询接口入/出流量趋势，可使用 `deviceId`、`interfaceId`、`range` 过滤。接口流量由相邻 `ifInOctets`、`ifOutOctets` 样本换算为 bps。

#### `GET /api/charts/interface-status`

查询接口状态分布，可使用 `deviceId` 过滤，返回 `up`、`down`、`unknown` 数量。

#### `GET /api/charts/collection-trend`

查询采集样本写入趋势，可使用 `deviceId`、`range` 过滤，按 5 分钟聚合。

### 告警接口

#### `GET /api/alerts/summary`

查询告警统计，包含当前告警、已恢复、严重告警和警告告警数量。

#### `GET /api/alerts/rules`

查询告警规则列表。

#### `POST /api/alerts/rules`

新增告警规则。当前支持：

- `cpu_threshold`：CPU 使用率阈值。
- `interface_down`：接口状态 Down。

#### `PATCH /api/alerts/rules/:id`

更新告警规则，例如启用/停用、调整阈值。

#### `GET /api/alerts/events`

查询告警事件，可使用 `status`、`deviceId`、`limit` 过滤。

#### `PATCH /api/alerts/events/:id/resolve`

手动标记告警事件为已恢复。

#### `GET /api/alerts/notifications`

查询告警通知记录，可使用 `status`、`eventId`、`limit` 过滤。

#### `PATCH /api/alerts/notifications/:id/retry`

将失败的通知重新放回待发送队列。

#### `GET /api/alerts/notification-config`

查看邮件通知配置摘要，不返回 SMTP 密码。

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

### 默认指标定义

| 名称 | OID | 单位 |
| --- | --- | --- |
| `sysUpTime` | `.1.3.6.1.2.1.1.3.0` | `ticks` |
| `ifNumber` | `.1.3.6.1.2.1.2.1.0` | `count` |
| `cpuUsage` | `.1.3.6.1.2.1.25.3.3.1.2.196608` | `%` |
| `ifDescr` | `.1.3.6.1.2.1.2.2.1.2` |  |
| `ifOperStatus` | `.1.3.6.1.2.1.2.2.1.8` |  |
| `ifInOctets` | `.1.3.6.1.2.1.2.2.1.10` | `bytes` |
| `ifOutOctets` | `.1.3.6.1.2.1.2.2.1.16` | `bytes` |

### 默认样本与告警

默认不写入任何模拟样本、模拟接口清单或模拟告警事件。Dashboard、设备详情和最新数据页的数据由 `snmp-monitor-collector` 从你接入的真实 SNMP 设备采集后写入。

默认保留告警规则配置，例如 CPU 阈值和接口 Down 规则；告警事件只会由真实采集结果触发。

## TimescaleDB 是否需要

当前 MVP 可以继续使用普通 PostgreSQL：部署更简单，演示环境和小规模设备采集完全够用。

v1.5.1 已内置 PostgreSQL 历史数据保留策略，默认保留：

- 标量样本 `metric_samples`：`30` 天。
- 接口样本 `interface_metric_samples`：`30` 天。
- 已恢复告警 `alert_events(status='resolved')`：`90` 天。

采集器每 `CLEANUP_INTERVAL_SECONDS` 秒执行一次清理，并按 `CLEANUP_BATCH_SIZE` 分批删除，适合普通 PostgreSQL 的中小规模部署。

当满足以下任一情况时，建议引入 TimescaleDB：

- 设备和接口数量较多，样本每天达到百万级以上。
- 需要保存 30～90 天以上历史趋势。
- Dashboard 经常查询大范围时间窗口。
- 需要自动压缩、自动保留策略或连续聚合。

TimescaleDB 的价值主要在时间序列样本表：

- `metric_samples`：标量指标历史样本。
- `interface_metric_samples`：接口维度历史样本。
- 后续可扩展到告警事件聚合、分钟/小时级预聚合视图。

### 可选接入方式

如需启用 TimescaleDB，可把 `docker-compose.yml` 中 PostgreSQL 镜像替换为兼容 PostgreSQL 16 的 TimescaleDB 镜像，例如：

```yaml
image: timescale/timescaledb:latest-pg16
```

然后在数据库初始化或迁移脚本中启用扩展：

```sql
create extension if not exists timescaledb;
```

将样本表转为 Hypertable 的示例：

```sql
select create_hypertable('metric_samples', 'created_at', if_not_exists => true);
select create_hypertable('interface_metric_samples', 'created_at', if_not_exists => true);
```

保留策略示例：

```sql
select add_retention_policy('metric_samples', interval '90 days');
select add_retention_policy('interface_metric_samples', interval '90 days');
```

压缩策略示例：

```sql
alter table metric_samples set (timescaledb.compress);
alter table interface_metric_samples set (timescaledb.compress);
select add_compression_policy('metric_samples', interval '7 days');
select add_compression_policy('interface_metric_samples', interval '7 days');
```

> 注意：TimescaleDB Hypertable 对唯一约束和主键有额外要求，唯一索引通常需要包含时间列。当前项目先不默认切换，建议在真实生产规模出现后，通过单独迁移调整样本表主键/索引再启用。

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

查看 CPU 图表数据：

```powershell
curl "http://localhost:13000/api/charts/cpu?range=1h"
```

查看单设备接口流量图表数据：

```powershell
curl "http://localhost:13000/api/charts/interface-traffic?deviceId=1&range=1h"
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
- 采集器增加 `GetBulk`、批量写入、失败重试记录
- PostgreSQL 指标样本表增加时间分区或 TimescaleDB
- 前端增加趋势图、告警中心、任务状态和采集器节点状态
