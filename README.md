# SNMP Monitoring Platform

当前发布版本：**v1.6.1**。本版升级 PostgreSQL 18、Go、Node、Alpine 和数据库驱动，更新 Windows 离线安装及备份恢复工具。完整变更与升级说明见 [v1.6.1 发布说明](docs/releases/v1.6.1.md)。端口流量、三列关注卡片、邮件配置和独立采集调度继续保留。

这是一个基于 Docker 编排的 SNMP 网络设备监控平台骨架，包含 Go SNMP 采集器、Fastify API 网关、Vue 3 管理前端和 PostgreSQL 数据库。

## 技术栈

### 独立端口流量详情

设备详情的端口列表支持搜索、分页、批量流量摘要，点击端口进入 `/devices/:deviceId/interfaces/:interfaceId`。告警端口和拓扑链路的明确端口关联也可跳转。详情页支持端口切换、浏览器本地关注、独立业务备注、1h/6h/24h 和最多 7 天的自定义查询、方向利用率、当前采样时间及相关告警；可每 60 秒自动刷新，离开页面时取消请求和计时器。

新增 `GET /api/interfaces/:id`、`GET /api/interfaces/:id/traffic-summary`、`GET /api/interfaces/:id/traffic`、`PATCH /api/interfaces/:id/note`。GET 支持 `deviceId` 校验归属；traffic 支持 `range` 或 ISO `start/end`。接口列表可用 `metadataOnly=true` 只读取端口元信息。告警事件可按 `interfaceId` 筛选。

`006_port_detail.sql` 增量补齐端口名称、设备备注、管理状态、速率、64 位计数器、计数器重置标识和错误/丢弃指标，绑定内置通用与华为模板。自定义模板可在指标管理中按需绑定这些指标。用户备注保存在 `user_note`，不会被 SNMP 备注覆盖。

列表、详情和现有流量图查询复用统一计算：使用实际采样时差，优先 64 位计数器并保留整数精度；32 位仅在已知速率与采样间隔可排除多次回绕时计算。计数器重置、数据源切换、间隔超过 180 秒及不合理速率产生断点。超过 3 分钟的样本标为过期，当前值为 null。利用率按入/出方向分别计算，速率未知时不显示利用率。均值按有效覆盖时间加权，峰值取原始有效采样速率；趋势超过 600 点才降采样，统计先于降采样计算。当前使用原始样本查询（默认接口保留 15 天），不把计数器 rollup 的末值当作速率峰值。错误和丢弃指标采集后保留在接口样本中，当前详情未将它们转换为告警规则。

采集器会先探测设备 SNMP 可达性，无响应设备不继续遍历各列。设备端口类型和 ifIndex 在设备重置后可能变化，应核对身份和新采样；端口不存在时返回 404。

- **采集引擎**：Go + `gosnmp`
- **API 网关**：Node.js + Fastify
- **前端界面**：Vue 3 + TypeScript + Element Plus + Vite + Nginx
- **数据库**：PostgreSQL 18（当前工作区）；已发布的 v1.6.0 离线包仍为 PostgreSQL 16
- **部署方式**：Docker Compose

当前工作区基础环境：Go 1.27.1 / Alpine 3.24.2，Node 24.21.0 / Alpine 3.24，pgx/v5 5.11.0、gosnmp 1.45.0、x/text 0.42.0。API 使用 Fastify 5.12.5、pg 8.23.1、CORS 11.3.0、JWT 10.2.2；前端构建也使用 Node 24。依赖锁文件固定实际安装版本。pgx v5 使用 pgxpool.New，并保留 Ping 和运行表结构检查，确保连接失败时启动立即报错。旧 pgx/v4、pgproto3/v2 和不再需要的 x/crypto 依赖已移除。已有发布包保持原样，升级后的基础环境需重新构建镜像；修改宿主机工具版本不会更新运行中的容器。

升级验证涵盖 Go 测试与竞态检测、PostgreSQL 18 SCRAM/批量写入/Counter64 精度、Linux 本地 SMTP STARTTLS/隐式 TLS/拒绝未受信证书、隔离 SNMP→采集→数据库→API→页面、发现任务及本地通知队列。TLS 回归测试使用临时证书和回环 SMTP，不连接外部邮件服务。Go Docker 构建恢复默认模块校验数据库，不再设置 GOSUMDB=off。

## 项目结构

```text
.
├── api-gateway/          # Fastify API 网关
├── collector-go/         # Go SNMP 采集器
├── postgres/             # PostgreSQL schema、迁移脚本与默认数据
│   └── migrations/       # 增量数据库迁移 SQL
├── scripts/              # 本地辅助脚本
├── web-vue3/             # Vue 3 前端
├── docker-compose.yml    # Docker Compose 编排
└── README.md             # 项目说明
```

## Docker 快速启动

Linux 服务器首次部署、备份、版本升级和回滚的完整说明见：

- [`docs/linux-deployment-and-upgrade.md`](docs/linux-deployment-and-upgrade.md)

仓库提供 `.env.example` 开发配置示例，首次克隆后复制为 `.env`；`.env` 不纳入版本控制。生产环境请设置独立的 `JWT_SECRET` 和首次初始化用的 `ADMIN_PASSWORD`。已有部署应保留原 `.env`，尤其是用于邮件密码解密的 JWT 密钥。

首次启动时，系统会使用 `.env` 中的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 初始化数据库管理员账号。初始化完成后，管理员密码保存在 PostgreSQL 的 `admin_users` 表中，可在页面左下角“修改密码”入口修改；后续修改 `.env` 中的 `ADMIN_PASSWORD` 不会覆盖已经存在的数据库管理员密码。

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d --build
```

启动过程中会先运行一次性数据库迁移容器 `snmp-monitor-migrator`。它只负责补齐数据库结构和内置默认数据，执行成功后会退出；在 `docker compose ps -a` 中看到 `snmp-monitor-migrator` 为 `Exited (0)` 是正常状态，不代表服务异常。

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

## Docker 升级与数据库迁移

当前工作区已迁移至 PostgreSQL 18，使用独立的 `postgres18-data` 卷，挂载到 `/var/lib/postgresql`。已有 PostgreSQL 16 环境必须先完成逻辑备份恢复，不能直接换镜像标签或仅执行 `up`。迁移和回退边界见 [PostgreSQL 18 迁移说明](docs/postgresql18-migration.md)。采集器的磁盘保护也挂载新卷。

客户通过 Docker 方式升级时，核心原则是保留 PostgreSQL 数据卷。不要执行 `docker compose down -v`、`docker volume rm ...postgres-data` 或 `docker system prune --volumes`，否则会删除设备、拓扑、告警和历史样本数据。

以下常规升级流程仅适用于已完成 PostgreSQL 18 数据迁移的环境。v1.6.0 的 PostgreSQL 16 用户须先按迁移说明完成逻辑备份恢复，不能直接执行下面的镜像替换步骤：

```powershell
docker compose stop api-gateway web-vue3 collector-go discovery-worker notifier
docker compose exec -T postgres pg_dump -U snmp -d snmp_monitor -Fc -f /tmp/snmp_monitor_backup.dump
docker cp snmp-monitor-postgres:/tmp/snmp_monitor_backup.dump .\snmp_monitor_backup.dump
docker compose down
git fetch --tags
git checkout v1.6.1
docker compose up -d --build
docker compose ps -a
```

`snmp-monitor-migrator` 会在 PostgreSQL 健康后自动执行：

1. 确保 `schema_migrations` 迁移记录表存在。
2. 执行当前 `postgres/schema.sql` 作为 `001_baseline_v1_5_3`，用于补齐旧版本数据库结构。
3. 按编号执行 `postgres/migrations/` 中尚未执行过的增量 SQL。
4. 每个迁移成功后写入 `schema_migrations`，后续启动不会重复执行同一版本。

如果迁移失败，`snmp-monitor-migrator` 会以非 0 状态退出，依赖它的 API、采集器、自动发现和通知服务不会继续启动。此时先查看日志并修复问题：

```powershell
docker logs snmp-monitor-migrator
```

迁移成功后的常见状态：

```text
snmp-monitor-migrator   Exited (0)
snmp-monitor-api        Up
snmp-monitor-collector  Up
snmp-monitor-web        Up
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
- `postgres/seed.sql`：初始化空种子，不写入演示设备

**核心表**

| 表名 | 说明 |
| --- | --- |
| `devices` | 网络设备配置，例如名称、IP、端口、SNMP v2c community、SNMP v3 认证参数、是否启用 |
| `admin_users` | 系统管理员账号和密码哈希，首次启动由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 初始化 |
| `device_groups` | 设备分组配置，绑定 OID 模板 |
| `oid_templates` | OID 模板配置，包含厂商和设备类型元数据 |
| `oid_template_definitions` | OID 模板和指标定义的绑定关系，支持单项启停和必选标记 |
| `metric_definitions` | SNMP OID 指标定义，例如 `sysUpTime`、`ifNumber`，包含显示名、值类型、倍率、精度、图表/告警能力标记 |
| `metric_samples` | 采集结果样本，按设备和指标保存 |
| `device_interfaces` | 设备接口清单，按 `ifIndex` 维护最新接口信息 |
| `interface_metric_samples` | 接口表采集样本，按设备、接口和指标保存 |
| `alert_rules` | 告警规则，例如 CPU 阈值、接口 Down |
| `alert_events` | 告警事件，记录 active/resolved 状态 |
| `alert_notifications` | 告警通知记录，预留 Web/邮件/企业 IM 等渠道 |
| `schema_migrations` | 数据库迁移记录，记录已经执行过的 baseline 和增量 SQL |
| `topology_maps` | 拓扑图配置，当前内置默认拓扑 |
| `topology_nodes` | 拓扑节点，支持绑定设备或自定义节点 |
| `topology_links` | 拓扑连线，支持手动链路和接口引用 |

### `snmp-monitor-migrator`

一次性数据库迁移任务容器。

**构建目录**

- `api-gateway/`

**主要功能**

- 在 PostgreSQL 健康后运行。
- 执行 `postgres/schema.sql` 作为 `001_baseline_v1_5_3`，兼容旧版本数据库升级。
- 执行 `postgres/migrations/` 中未执行过的增量迁移。
- 将成功执行的版本写入 `schema_migrations`。
- 执行成功后正常退出，`Exited (0)` 是预期状态。

**环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://snmp:snmp@postgres:5432/snmp_monitor?sslmode=disable` | 数据库连接地址 |
| `MIGRATION_BASELINE_SQL` | `/app/schema.sql` | baseline SQL 文件路径 |
| `MIGRATIONS_DIR` | `/app/migrations` | 增量迁移目录 |

新增数据库变更时，优先在 `postgres/migrations/` 中增加形如 `002_xxx.sql` 的文件。`001` 已保留给当前 baseline，不要在增量目录中使用。

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
- 接口表指标和通用 Walk 指标优先使用 GetBulk，失败时自动回退到普通 Walk
- 支持采集周期、超时、重试、worker 数量配置

**环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://snmp:snmp@postgres:5432/snmp_monitor?sslmode=disable` | 数据库连接地址 |
| `COLLECT_INTERVAL_SECONDS` | `60` | 采集周期，单位秒 |
| `DEVICE_COLLECT_TIMEOUT_SECONDS` | `45` | 单设备快速任务总预算，含模板读取、SNMP、保存和告警；网络阶段预留最多 5 秒供保存使用 |
| `NEIGHBOR_INTERVAL_SECONDS` | `600` | LLDP/CDP 邻居低频采集周期 |
| `NEIGHBOR_TIMEOUT_SECONDS` | `15` | 邻居任务总预算 |
| `DEVICE_REFRESH_SECONDS` | `5` | 启用设备及连接配置刷新周期 |
| `DATABASE_TIMEOUT_SECONDS` | `10` | 设备目录读取超时 |
| `MAINTENANCE_TIMEOUT_SECONDS` | `120` | 每次存储保护检查、聚合或清理的耗时上限 |
| `CLEANUP_INTERVAL_SECONDS` | `3600` | 历史数据清理周期，单位秒；小于等于 `0` 表示关闭 |
| `METRIC_SAMPLE_RETENTION_DAYS` | `30` | 标量样本保留天数；小于等于 `0` 表示不清理 |
| `INTERFACE_SAMPLE_RETENTION_DAYS` | `30` | 接口样本保留天数；小于等于 `0` 表示不清理 |
| `RESOLVED_ALERT_RETENTION_DAYS` | `90` | 已恢复告警事件保留天数；小于等于 `0` 表示不清理 |
| `ALERT_NOTIFICATION_RETENTION_DAYS` | `90` | 告警通知记录保留天数；小于等于 `0` 表示不清理 |
| `DISCOVERY_HISTORY_RETENTION_DAYS` | `30` | 已完成、失败或取消的自动发现任务保留天数；小于等于 `0` 表示不清理 |
| `CLEANUP_BATCH_SIZE` | `5000` | 单批删除行数，避免一次清理大表锁太久 |
| `STORAGE_GUARD_PATH` | `/postgres-data` | 存储保护检查路径；Docker 部署中只读挂载 PostgreSQL 数据卷用于判断磁盘水位 |
| `STORAGE_GUARD_WARNING_USED_PERCENT` | `85` | 磁盘使用率达到该百分比后输出 warning 日志 |
| `STORAGE_GUARD_READONLY_USED_PERCENT` | `90` | 磁盘使用率达到该百分比后进入保护模式，暂停本轮采集写入 |
| `STORAGE_GUARD_CLEANUP_USED_PERCENT` | `90` | 磁盘使用率达到该百分比后触发紧急旧数据清理 |
| `STORAGE_GUARD_RECOVERY_USED_PERCENT` | `85` | 磁盘使用率恢复到该百分比以下后退出保护模式 |
| `STORAGE_GUARD_CLEANUP_COOLDOWN_SECONDS` | `600` | 紧急清理冷却时间，避免短时间重复清理 |
| `EMERGENCY_METRIC_SAMPLE_RETENTION_DAYS` | `7` | 紧急清理时标量样本至少保留天数 |
| `EMERGENCY_INTERFACE_SAMPLE_RETENTION_DAYS` | `7` | 紧急清理时接口样本至少保留天数 |
| `EMERGENCY_RESOLVED_ALERT_RETENTION_DAYS` | `30` | 紧急清理时已恢复告警至少保留天数 |
| `EMERGENCY_ALERT_NOTIFICATION_RETENTION_DAYS` | `30` | 紧急清理时通知记录至少保留天数 |
| `EMERGENCY_DISCOVERY_HISTORY_RETENTION_DAYS` | `7` | 紧急清理时自动发现历史至少保留天数 |
| `EMERGENCY_CLEANUP_BATCH_SIZE` | `10000` | 紧急清理单批删除行数 |
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

1. 启动固定工作池，每台启用设备按稳定偏移在首个采集周期内启动，避免集中请求。
2. 每台设备独立安排 `COLLECT_INTERVAL_SECONDS` 周期；慢设备不阻塞整批，过期时间槽跳过，不补采历史。
3. 查询 `devices.enabled = true` 的设备。
4. 按设备分组加载绑定的 OID 模板。
5. 标量指标执行 SNMP `Get`，通用 Walk 指标按聚合方式写入单个样本，接口表指标优先执行 SNMP `BulkWalk`，失败时回退到 `Walk`。
6. 写入 `metric_samples`、`device_interfaces` 和 `interface_metric_samples`。
7. 根据 CPU 阈值和接口 Down 规则生成或恢复告警事件。
8. 邮件通知启用时，告警首次触发和恢复会写入 `alert_notifications` 队列。
9. 独立维护循环负责存储检查、聚合和分批清理，与采集调度并行；维护任务之间串行且有超时。
10. 流量样本保存后，另行低频采集 LLDP/CDP 邻居。同一设备最多一个执行任务，无无界队列；快速任务优先使用工作池。端口名称、别名、状态和带宽仍随快速任务刷新，保证容量变化及时可见。
11. 失败设备按 2/4/8 倍周期退避，成功后恢复正常周期。设备删除、停用或连接配置变更时取消在途任务，配置变更在旧任务实际结束后再启动新任务。
12. 检测到数据库数据卷磁盘高水位时，先执行紧急旧数据清理；达到只读保护阈值后暂停本轮采集写入，避免继续压垮 PostgreSQL。

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
- `SMTP_TLS_MODE=starttls` 会显式执行 STARTTLS 握手；`implicit` 用于 465 端口隐式 TLS；`none` 用于无 TLS 的内网 SMTP。
- 告警中心的“发送测试邮件”按钮会创建一条测试通知，并通过同一个 notifier 队列发送，结果可在邮件通知记录中查看。

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
- 展示设备列表，设备名称可点击进入单设备监控详情，并可在列表中直接调整设备分组
- 添加 SNMP 设备
- 管理 OID 模板、设备分组绑定模板和接口表数据
- 展示最新采集样本
- 支持从 LLDP/CDP 邻居自动生成网络拓扑节点和链路，也可手工维护画布布局
- 左侧侧边栏支持收起和展开，用户信息固定在侧边栏底部
- 通过 Nginx 反向代理访问 API Gateway

**前端页面**

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/login` | 登录页 | 管理员登录，默认首次初始化账号 `admin / admin123` |
| `/dashboard` | 监控概览 | 展示 API 状态、统计卡片、CPU、接口流量、接口状态和采集趋势 |
| `/devices` | 设备管理 | 查询设备、搜索设备、添加设备、修改设备分组，点击设备名称进入详情 |
| `/discovery` | 自动发现 | 创建 SNMP v2c CIDR 发现任务，查看结果并手动导入设备 |
| `/topology` | 网络拓扑 | 自动同步 LLDP/CDP 邻居生成节点和链路，也支持手动添加设备/自定义节点 |
| `/devices/:id` | 设备监控 | 展示单设备 CPU、接口状态、采集趋势、接口清单和各接口流量图 |
| `/metrics` | 指标管理 | 管理 OID 模板、设备分组绑定模板和接口表数据 |
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

#### `PATCH /api/devices/:id`

更新设备信息。页面当前用于调整设备分组，`group_id` 传 `null` 可清空分组。

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
| `display_name` | string | 页面显示名，未设置时回退为 `name` |
| `description` | string | 指标说明 |
| `metric_kind` | string | 指标类型，`scalar`、`walk` 或 `interface` |
| `table_oid` | string | 接口表基础 OID |
| `value_type` | string | 值类型，例如 `gauge`、`counter`、`status`、`string`、`timeticks` |
| `scale` | number/string | 采集值入库前的倍率，默认 `1` |
| `precision` | number | 数值显示和入库格式化精度，默认 `2` |
| `aggregate_method` | string | Walk 指标聚合方式，例如 `max`、`avg`、`sum`、`latest`、`first` |
| `display_group` | string | 图表归类，例如 `cpu`、`memory` |
| `vendor` | string | 厂商标识，例如 `huawei` |
| `chartable` | boolean | 是否适合作为图表指标 |
| `alertable` | boolean | 是否适合作为告警指标 |
| `enabled` | boolean | 是否启用 |

#### `GET /api/metrics/templates`

查询 OID 模板列表。

#### `POST /api/metrics/templates`

新增 OID 模板，字段包括 `name`、`description`、`vendor`、`device_type`、`enabled`。

#### `GET /api/metrics/templates/:id/definitions`

查询模板绑定的指标定义，返回指标定义字段以及绑定字段 `sort_order`、`binding_enabled`、`required`。

#### `POST /api/metrics/templates/:id/definitions`

向模板加入指标定义，字段包括 `metric_id`、`sort_order`、`enabled`、`required`。

#### `PATCH /api/metrics/templates/:id/definitions/:metricId`

更新模板内某个指标绑定，支持修改 `sort_order`、`enabled`、`required`。采集器只会读取模板中 `enabled=true` 的绑定项。

#### `GET /api/device-groups`

查询设备分组列表，包含绑定模板和设备数量。

#### `POST /api/device-groups`

新增设备分组，字段包括 `name`、`description`、`template_id`。

#### `PATCH /api/device-groups/:id`

更新设备分组，支持修改绑定模板，`template_id` 传 `null` 可清空模板绑定。

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

#### `GET /api/charts/memory`

查询内存使用率趋势，可使用 `deviceId`、`range` 过滤。`range` 支持 `1h`、`6h`、`24h`。

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

查看邮件通知配置，包括启用开关、SMTP 地址/端口/加密方式、账号、发件邮箱、收件邮箱、主题前缀和恢复通知。只返回密码是否已配置，不返回密码或密文。

#### `PATCH /api/alerts/notification-config`

管理员可在“告警中心”顶部或“邮件通知记录”旁点击“邮件配置”，填写后保存。支持 STARTTLS（通常 587）、SSL/TLS（通常 465）和内部服务器不加密模式；邮箱服务通常使用 SMTP 授权码。收件邮箱支持多个，使用换行、逗号或分号分隔。

配置保存在 PostgreSQL 的 `email_notification_config` 表，由 `005_email_notification_config.sql` 增量迁移创建。尚未在页面保存时沿用环境变量；首次保存后数据库配置优先。采集器产生通知时读取新配置，notifier 每次轮询读取 SMTP 配置，无需重启容器。关闭通知开关会停止生成新的告警邮件，已经入队的邮件和手动测试邮件仍会发送。

密码使用 AES-256-GCM 加密保存，API 和 notifier 使用相同的 `JWT_SECRET` 派生密钥。页面密码留空时保留原值；勾选“清除已保存的密码”时清除，输入新授权码时替换。更换 `JWT_SECRET` 后需要在页面重新填写授权码。配置 API 使用现有 JWT 登录保护。

“保存并发送测试邮件”会先保存当前表单，再加入邮件队列；入队成功不代表投递成功，最终结果和错误可在“邮件通知记录”查看。本地配置入口不会自动发送邮件。

#### `POST /api/alerts/notifications/test-email`

发送测试邮件。默认使用页面保存的收件邮箱，未保存时使用 `.env` 中的 `ALERT_EMAIL_TO`，也可以传入 `target` 或 `targets` 覆盖收件人。接口会把测试通知写入 `alert_notifications` 队列，由 `snmp-monitor-notifier` 异步发送。

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
| `huaweiCpuUsage` | `.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5` | `%` |
| `huaweiMemoryUsage` | `.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7` | `%` |

默认模板会包含 Huawei CPU/内存 Walk 指标，已有默认分组设备升级后也会自动尝试采集；同时内置 `华为 SNMP 模板`，后续可按厂商或设备类型创建新模板，把对应 OID 以 `walk + 聚合方式` 维护进去。

指标定义支持显示名、说明、值类型、倍率、精度、图表能力和告警能力等元数据。模板绑定支持单项启停和必选标记，采集器会跳过模板中已停用的绑定项；`scale` 会在样本写入前应用，适合处理部分厂商把百分比、容量或计数值按固定倍率返回的场景。

### 默认样本与告警

默认不写入任何模拟样本、模拟接口清单或模拟告警事件。Dashboard、设备详情和最新数据页的数据由 `snmp-monitor-collector` 从你接入的真实 SNMP 设备采集后写入。

默认保留告警规则配置，例如 CPU 阈值和接口 Down 规则；告警事件只会由真实采集结果触发。

## TimescaleDB 是否需要

当前 MVP 可以继续使用普通 PostgreSQL：部署更简单，演示环境和小规模设备采集完全够用。

v1.5.1 已内置 PostgreSQL 历史数据保留策略，默认保留：

- 标量样本 `metric_samples`：`30` 天。
- 接口样本 `interface_metric_samples`：`30` 天。
- 已恢复告警 `alert_events(status='resolved')`：`90` 天。
- 告警通知 `alert_notifications`：`90` 天。
- 自动发现历史 `discovery_jobs` / `discovery_results`：`30` 天。

采集器每 `CLEANUP_INTERVAL_SECONDS` 秒执行一次清理，并按 `CLEANUP_BATCH_SIZE` 分批删除，适合普通 PostgreSQL 的中小规模部署。

### 普通 PostgreSQL 聚合表

当前改造中，采集器会在不更换数据库容器的前提下，把近期原始样本旁路聚合到 5 分钟粒度的普通 PostgreSQL 表：

- `metric_sample_rollups`：标量指标聚合结果。
- `interface_metric_sample_rollups`：接口维度指标聚合结果。

聚合表会保存每个时间桶内的 `min_value`、`max_value`、`avg_value`、`last_value` 和 `sample_count`。默认配置如下：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ROLLUP_ENABLED` | `true` | 是否启用普通 PostgreSQL 聚合表写入 |
| `ROLLUP_INTERVAL_SECONDS` | `300` | 聚合任务执行间隔 |
| `ROLLUP_BUCKET_SECONDS` | `300` | 聚合时间桶大小，默认 5 分钟 |
| `ROLLUP_LOOKBACK_SECONDS` | `900` | 每次回看最近多久的数据，默认 15 分钟 |

当前聚合功能仍保留原始样本写入：采集器会照常写入 `metric_samples` 和 `interface_metric_samples`，同时生成聚合表。最近 1 小时图表继续使用原始样本，大范围图表自动切换到聚合表。

大范围图表查询会优先使用聚合表：

- `1h`：继续查询原始样本表，保留最近细节。
- `6h`、`24h`、`7d`、`30d`：查询 5 分钟聚合表，降低大范围查询对原始样本表的压力。

默认 Docker 部署中，接口原始样本保留期为 `15` 天，聚合样本保留期为 `365` 天。可通过以下环境变量调整：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INTERFACE_SAMPLE_RETENTION_DAYS` | `15` | 接口原始样本保留天数 |
| `ROLLUP_SAMPLE_RETENTION_DAYS` | `365` | 聚合样本保留天数 |
| `EMERGENCY_ROLLUP_SAMPLE_RETENTION_DAYS` | `90` | 存储保护紧急清理时聚合样本保留天数 |

升级前可在 Linux 服务器上执行备份脚本：

```bash
sh scripts/backup-before-upgrade.sh
```

脚本会导出 `.env`、`docker-compose.yml`、容器状态、版本信息和 PostgreSQL 压缩备份。

### 存储保护模式

Docker 部署中，采集器会只读挂载 PostgreSQL 数据卷到 `/postgres-data`，并用该路径判断数据库所在文件系统的磁盘水位。

默认策略：

- 使用率达到 `85%`：输出磁盘水位 warning 日志。
- 使用率达到 `90%`：执行紧急旧数据清理，并进入保护模式。
- 保护模式下：采集器暂停本轮 SNMP 采集和写库，设备配置、拓扑、模板和已有历史数据仍保留。
- 使用率恢复到 `85%` 以下：自动退出保护模式，恢复采集。

紧急清理只处理历史数据，不会删除设备、分组、模板、拓扑和告警规则：

- `interface_metric_samples`
- `metric_samples`
- 已恢复的 `alert_events`
- `alert_notifications`
- 已完成、失败或取消的 `discovery_jobs` 及其结果

也可以通过 API 手动触发一次旧数据清理：

```bash
curl -X POST http://localhost:13000/api/system/cleanup \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"metricSamplesDays":7,"interfaceSamplesDays":7,"resolvedAlertsDays":30,"alertNotificationsDays":30,"discoveryHistoryDays":7,"batchSize":10000}'
```

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

### Windows 离线发布包

设备详情页增加“关注端口”三列卡片区，位于 CPU、内存和接口状态图下方。卡片展示业务备注、当前入/出速率、利用率、最近一小时迷你趋势与数据状态，点击进入现有端口详情，星标取消关注；可通过“选择关注端口”搜索并批量选择，全部端口表也提供关注按钮。关注记录沿用浏览器 `netlooker-port-favorites`，详情页、列表和卡片共享响应式状态，同一设备只展示属于它的端口，其他设备的关注记录保留。当前仍是浏览器本地收藏，不随账号跨电脑同步。

设备页每 60 秒在可见且空闲时刷新，选择窗口打开时暂停自动刷新。仅已关注端口加载趋势，最多三个并发请求，切换设备、变更关注列表和离开页面时取消过期趋势请求。数据过期时当前速率显示 `—`，无有效样本显示空状态；采集样本趋势和最新采集数据移入默认折叠的“采集诊断”，展开才加载。三列布局随内容宽度降为两列或单列。

执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/build-release.ps1 -ReleaseVersion 1.6.1` 导出七个运行镜像并生成对应 ZIP。本版使用 PostgreSQL 18；历史 v1.6.0 及本地包保持原样，不能用新数据库镜像覆盖同版本附件。`-SkipBuild` 仅用于镜像已由当前源码构建的情况。镜像清单、postgresMajor 和 SHA256 位于 VERSION.json，ZIP 外有同名校验文件；发布目录不包含当前 `.env` 或数据库内容。

目标 Windows x64 电脑需预装并启动 Docker Desktop/Linux containers，Compose 至少 2.20。解压后依次运行 install.ps1、start.ps1、status.ps1，无需公网拉取镜像或安装开发依赖。首次安装生成独立密码和密钥；详细部署、更新、数据库迁移和备份恢复见 [部署说明](deploy/windows/部署说明.md)。发布 Compose 只开放网页端口，设置固定项目名、重启策略和日志轮转。脚本兼容 Windows PowerShell 5.1，保留原开发 Compose 方式。

当前项目是可运行骨架，适合继续扩展。

建议后续增强：

- API Gateway 增加真实登录、JWT 和权限控制
- 设备管理增加删除、批量启停、SNMP v3 参数配置
- 采集器增加 `GetBulk`、批量写入、失败重试记录
- PostgreSQL 指标样本表增加时间分区或 TimescaleDB
- 前端增加趋势图、告警中心、任务状态和采集器节点状态


### 设备独立调度的运行说明

品牌标识采用 `web-vue3/public/netlooker-logo.svg`：切角工业外框、蓝青色 N 形网络线路和数据包标记。侧栏、登录页及浏览器图标共用 SVG，在不同尺寸保持清晰；旧 PNG 保留供历史引用。品牌副标题改为 `NETWORK OBSERVABILITY`，适配侧栏宽度。

运行 `docker compose up -d --build collector-go` 即可更新采集器，不增加容器，不变更数据库结构。使用 `docker compose logs --tail=100 collector-go` 查看 `scheduler started` 和 `collection finished`，后者包含设备 ID、是否邻居任务、成功状态和耗时。其他服务保持原有部署方式。

时间预算是上限，实际安全退出依赖 SNMP 和数据库调用遵循 context；SNMP 客户端已绑定任务 context。网络超时后可以保存已完成的部分样本，但任务仍视为失败并退避。存储保护和紧急清理只有一个维护循环持有状态。周期与并发数应按设备规模及实际 Walk 耗时调整；当前仍是单采集器实例，不支持多个采集器抢占同一设备。
