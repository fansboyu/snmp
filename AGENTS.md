# AGENTS.md

## 项目定位

这是一个基于 Docker Compose 的 SNMP 网络设备监控平台，包含：

- **PostgreSQL**：保存设备、OID 模板、采集样本、接口表、告警和图表数据来源。
- **Fastify API Gateway**：提供设备管理、指标管理、接口查询、图表查询、告警中心等 HTTP API。
- **Go Collector**：使用 `gosnmp` 读取启用设备和模板指标，写入标量指标、接口表样本并评估告警。
- **Vue 3 管理前端**：提供登录、监控概览、设备管理、设备详情、指标管理、告警中心和最新数据页面。

## 目录速览

| 路径 | 说明 |
| --- | --- |
| `docker-compose.yml` | 本地 Docker 编排入口 |
| `postgres/schema.sql` | 数据库表结构、索引和默认模板/指标 |
| `postgres/seed.sql` | 默认设备、CPU、接口、告警和演示样本 |
| `api-gateway/src/` | Fastify API 服务 |
| `collector-go/internal/` | SNMP 采集器核心逻辑 |
| `web-vue3/src/` | Vue 3 前端源码 |
| `README.md` | 项目使用、接口和运行说明 |

## 常用命令

### Docker 运行

```powershell
docker compose up -d --build
docker compose ps
```

### 停止服务

```powershell
docker compose down
```

> 如非明确要求，不要执行 `docker compose down -v`，避免删除 PostgreSQL 数据卷。

### API 验证

```powershell
curl http://localhost:13000/health
curl http://localhost:13000/api/devices
curl "http://localhost:13000/api/charts/cpu?range=1h"
```

### 前端构建

```powershell
cd web-vue3
npm run build
```

### Go 采集器校验

```powershell
cd collector-go
go test ./...
```

### API 语法检查

```powershell
cd api-gateway
node --check src/server.js
node --check src/routes/<route-file>.js
```

## 当前核心能力

- 设备管理：新增设备、删除设备、按名称/IP/分组搜索，支持 SNMP v2c 与 SNMP v3 参数。
- 设备详情：点击设备名称进入 `/devices/:id`，查看 CPU、接口状态、采集趋势和接口流量图。
- 指标管理：维护 OID 模板、设备分组、模板指标和接口表数据。
- 告警中心：维护 CPU 阈值和接口 Down 规则，查看 active/resolved 告警事件。
- 图表展示：Dashboard 展示 CPU、接口入/出流量、接口状态、采集样本趋势。
- SNMP 采集：按设备分组绑定的模板采集标量指标和接口表指标。

## 数据库约定

- `devices` 是设备主表，`group_id` 关联 `device_groups`。
- `devices.snmp_version` 支持 `2c` 和 `3`；SNMP v3 字段使用 `snmp_v3_*` 前缀。
- `device_groups` 绑定 `oid_templates`，采集器按分组模板加载指标。
- `metric_definitions.metric_kind` 使用：
  - `scalar`：普通 SNMP `Get` 指标。
  - `interface`：接口表 `Walk` 指标。
- `device_interfaces` 以 `(device_id, if_index)` 作为唯一接口标识。
- `interface_metric_samples` 保存接口维度历史样本。
- `alert_rules` 保存告警规则，当前支持 `cpu_threshold` 和 `interface_down`。
- `alert_events` 保存告警事件，`status` 使用 `active` 或 `resolved`。
- 删除设备时依赖外键级联删除相关样本、接口数据和告警数据。

## API 开发约定

- 新路由放在 `api-gateway/src/routes/`。
- 新路由需要在 `api-gateway/src/server.js` 中注册。
- 查询参数保持小驼峰风格，例如 `deviceId`、`interfaceId`。
- 返回字段尽量与数据库字段一致，前端类型在 `web-vue3/src/services/api.ts` 中同步维护。
- 对新增接口至少执行：

```powershell
node --check src/server.js
node --check src/routes/<route-file>.js
```

## 前端开发约定

- 页面放在 `web-vue3/src/views/`。
- 通用组件放在 `web-vue3/src/components/`。
- API 类型和请求方法统一维护在 `web-vue3/src/services/api.ts`。
- 路由统一维护在 `web-vue3/src/router/index.ts`。
- UI 使用 Element Plus，图表使用 ECharts。
- 菜单布局在 `web-vue3/src/layouts/BasicLayout.vue`，侧边栏支持收起/展开。
- 修改前端后必须运行：

```powershell
npm run build
```

## Go 采集器约定

- 采集入口在 `collector-go/internal/collector/engine.go`。
- PostgreSQL 读写实现在 `collector-go/internal/database/postgres.go`。
- 类型定义在 `collector-go/internal/collector/types.go`。
- SNMP v3 连接参数在 `engine.snmpClient` 中转换为 `gosnmp` 配置。
- 新增采集类型时，应同步更新：
  - 数据库表结构或字段。
  - `collector.Store` 接口。
  - PostgreSQL 实现。
  - 采集器保存逻辑。
- 修改 Go 代码后运行：

```powershell
gofmt -w internal\collector\*.go internal\database\*.go
go test ./...
```

## 文档维护要求

当新增或修改以下内容时，需要同步更新 `README.md`：

- Docker 运行方式或端口。
- 数据库表结构或默认数据。
- API 路由、请求参数、返回字段。
- 前端页面、菜单、交互入口。
- 采集器行为或环境变量。

## 实施原则

- 优先使用 Docker Compose 验证完整链路。
- 保持改动聚焦，不顺手重构无关模块。
- 不删除用户数据卷，除非用户明确要求。
- 不提交 Git commit，除非用户明确要求。
- 修复中文乱码时优先重写相关文件为 UTF-8 文本。
- 新功能尽量先做可用 MVP，再逐步增强权限、通知、聚合和告警能力。

## 后续建议

- 权限系统：替换本地演示登录，增加 JWT 和角色权限。
- 采集增强：增加失败重试记录、GetBulk 优化、SNMP v3 凭据加密保存。
- 数据增强：按生产规模评估 TimescaleDB、分区、压缩和保留策略。
- 前端优化：ECharts 按需加载，降低首屏 JS 包体积。
