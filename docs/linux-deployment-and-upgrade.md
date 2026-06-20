# NetLooker Linux 部署与升级指南

本文适用于使用 Docker Compose 在 Linux 服务器上部署和升级 NetLooker。当前示例版本为 `v1.5.5`。

## 1. 部署架构

Docker Compose 会启动以下服务：

| 服务 | 作用 | 状态说明 |
| --- | --- | --- |
| `snmp-monitor-postgres` | PostgreSQL 数据库 | 长期运行 |
| `snmp-monitor-migrator` | 数据库结构迁移 | 执行成功后显示 `Exited (0)` |
| `snmp-monitor-api` | Fastify API 服务 | 长期运行 |
| `snmp-monitor-web` | Vue 管理页面 | 长期运行 |
| `snmp-monitor-collector` | SNMP 指标采集 | 长期运行 |
| `snmp-monitor-discovery-worker` | 自动发现任务 | 长期运行 |
| `snmp-monitor-notifier` | 邮件告警通知 | 长期运行 |

默认端口：

| 端口 | 用途 |
| --- | --- |
| `15173/tcp` | Web 管理页面 |
| `13000/tcp` | API Gateway |
| `5432/tcp` | PostgreSQL；生产环境不建议向公网开放 |

服务器还需要能够访问被监控设备的 `UDP 161` 端口。

## 2. 服务器建议

- Linux：Ubuntu 22.04/24.04、Debian 12、Rocky Linux 9 等。
- CPU：至少 2 核，建议 4 核以上。
- 内存：至少 4 GB，建议 8 GB 以上。
- 磁盘：至少 50 GB，生产建议独立数据盘并预留 20% 空间。
- 时间同步：启用 NTP/chrony。
- 网络：服务器能够路由到所有被监控设备。

## 3. 安装 Docker

Ubuntu/Debian 可使用 Docker 官方安装脚本：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

重新登录后验证：

```bash
docker version
docker compose version
git --version
```

如果没有 Git：

```bash
sudo apt update
sudo apt install -y git
```

Rocky/RHEL 系统可改用：

```bash
sudo dnf install -y git
```

## 4. 首次部署

### 4.1 下载指定版本

建议始终部署正式标签，不要直接部署开发中的 `main`：

```bash
sudo mkdir -p /opt/netlooker
sudo chown -R "$USER":"$USER" /opt/netlooker
git clone https://github.com/fansboyu/snmp.git /opt/netlooker/app
cd /opt/netlooker/app
git fetch --tags
git checkout v1.5.5
```

确认版本：

```bash
git describe --tags --always
```

### 4.2 修改环境变量

项目根目录自带 `.env`。生产部署至少修改：

```bash
cd /opt/netlooker/app
nano .env
```

建议配置：

```env
JWT_SECRET=替换为至少32位随机字符串
JWT_EXPIRES_IN=8h
ADMIN_USERNAME=admin
ADMIN_PASSWORD=替换为首次登录密码

ALERT_EMAIL_ENABLED=false
```

可生成随机 JWT 密钥：

```bash
openssl rand -hex 32
```

`ADMIN_PASSWORD` 只用于数据库中没有管理员时的首次初始化。管理员初始化完成后，应在页面左下角修改密码；再次修改 `.env` 不会覆盖数据库里的管理员密码。

### 4.3 启动服务

```bash
docker compose up -d --build
docker compose ps -a
```

正常状态应类似：

```text
snmp-monitor-postgres           Up (healthy)
snmp-monitor-api                Up
snmp-monitor-web                Up
snmp-monitor-collector          Up
snmp-monitor-discovery-worker   Up
snmp-monitor-notifier           Up
snmp-monitor-migrator           Exited (0)
```

`snmp-monitor-migrator` 显示 `Exited (0)` 是正常现象，它只在启动阶段执行数据库迁移。

### 4.4 验证服务

```bash
curl http://127.0.0.1:13000/health
docker compose logs --tail=100 api-gateway
docker compose logs --tail=100 collector-go
```

浏览器访问：

```text
http://服务器IP:15173
```

首次登录使用 `.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。

### 4.5 防火墙

UFW 示例：

```bash
sudo ufw allow 15173/tcp
sudo ufw allow from 管理网段 to any port 13000 proto tcp
```

通常只需向用户开放 `15173/tcp`。数据库端口 `5432` 不应开放到公网。

## 5. 数据持久化和存储保护

PostgreSQL 数据保存在 Compose 创建的 `postgres-data` 命名卷中。实际卷名会带项目名前缀，例如 `snmp_postgres-data` 或 `snmp-for_postgres-data`，应以当前服务器查询结果为准。

查看 PostgreSQL 实际挂载的卷：

```bash
docker volume ls | grep postgres
docker inspect snmp-monitor-postgres \
  --format '{{range .Mounts}}{{println .Name "->" .Destination}}{{end}}'
```

以下命令会删除客户数据，日常运维禁止执行：

```bash
docker compose down -v
docker volume rm 实际的PostgreSQL卷名
docker system prune --volumes
```

正常停止使用：

```bash
docker compose down
```

`v1.5.5` 提供存储保护：磁盘达到高水位时自动清理旧历史数据并暂停采集写入。该功能用于避免磁盘继续被写满，但不能保证磁盘已经 100% 满时 PostgreSQL 一定不会退出。因此仍需监控磁盘并提前扩容。

检查磁盘和 Docker 占用：

```bash
df -h
docker system df
docker exec snmp-monitor-postgres du -sh /var/lib/postgresql/data
```

## 6. 数据库备份

### 6.1 手动备份

```bash
cd /opt/netlooker/app
mkdir -p backups
docker exec snmp-monitor-postgres \
  pg_dump -U snmp -d snmp_monitor -Fc \
  > "backups/snmp_monitor_$(date +%Y%m%d_%H%M%S).dump"
```

确认备份文件不是空文件：

```bash
ls -lh backups/
```

建议将备份复制到另一台服务器、NAS 或对象存储。只保存在同一块磁盘上不能防止磁盘故障。

### 6.2 恢复备份

恢复会覆盖目标数据库内容，应先停止应用写入：

```bash
docker compose stop api-gateway collector-go discovery-worker notifier
docker exec snmp-monitor-postgres \
  dropdb -U snmp --if-exists snmp_monitor
docker exec snmp-monitor-postgres \
  createdb -U snmp -O snmp snmp_monitor
cat backups/备份文件.dump | docker exec -i snmp-monitor-postgres \
  pg_restore -U snmp -d snmp_monitor --clean --if-exists
docker compose up -d
```

执行恢复前必须确认备份文件和目标服务器，避免覆盖错误数据库。

## 7. Linux 版本升级

下面以从旧版本升级到 `v1.5.5` 为例。升级过程中保留 PostgreSQL 数据卷，原有设备、模板、拓扑、告警和历史数据都会继续保留。

### 7.1 升级前检查

```bash
cd /opt/netlooker/app
docker compose ps -a
df -h
git status --short
```

如果 `git status` 显示本地修改，先记录或备份，不要直接覆盖客户配置。

### 7.2 备份数据库和配置

```bash
mkdir -p backups
docker exec snmp-monitor-postgres \
  pg_dump -U snmp -d snmp_monitor -Fc \
  > "backups/pre_upgrade_$(date +%Y%m%d_%H%M%S).dump"
cp .env "backups/env_$(date +%Y%m%d_%H%M%S).backup"
```

### 7.3 下载新版本

```bash
git fetch origin --tags --prune
git checkout v1.5.5
```

如果 `.env` 是本地配置文件，确认内容没有被改变：

```bash
git status --short
grep -E '^(ADMIN_USERNAME|ALERT_EMAIL_ENABLED|STORAGE_GUARD_)' .env
```

### 7.4 构建并启动

不需要先删除数据库卷：

```bash
docker compose up -d --build
docker compose ps -a
```

升级时 `migrator` 会：

1. 等待 PostgreSQL 健康。
2. 检查 `schema_migrations`。
3. 按编号执行尚未执行的迁移。
4. 成功后退出，并允许其他服务启动。

查看迁移日志：

```bash
docker compose logs --tail=200 migrator
```

成功日志示例：

```text
Migration 002 admin_users applied
Database migrations completed
```

重复启动时显示 `already applied` 也是正常的。

### 7.5 升级后验证

```bash
curl http://127.0.0.1:13000/health
docker compose ps -a
docker compose logs --tail=100 api-gateway
docker compose logs --tail=100 collector-go
```

页面验证：

- 能正常登录。
- 设备列表仍然存在。
- 原有拓扑仍然存在。
- 指标模板和分组仍然存在。
- 修改密码功能正常。
- 采集器日志没有数据库连接或迁移错误。

## 8. 升级失败处理

### 8.1 Migrator 失败

如果 `snmp-monitor-migrator` 显示非 0 退出状态：

```bash
docker compose logs --tail=300 migrator
```

不要反复删除数据库卷。保留现场日志和升级前备份，先解决 SQL 或数据库空间问题。

### 8.2 回滚应用版本

如果数据库迁移是向后兼容的，可以先回滚应用代码：

```bash
git checkout 上一个版本标签
docker compose up -d --build
```

如果新版本已经执行了不兼容的数据库迁移，单纯切回旧代码可能无法工作，应恢复升级前数据库备份。

### 8.3 恢复升级前数据库

```bash
docker compose stop api-gateway collector-go discovery-worker notifier
docker exec snmp-monitor-postgres dropdb -U snmp --if-exists snmp_monitor
docker exec snmp-monitor-postgres createdb -U snmp -O snmp snmp_monitor
cat backups/pre_upgrade_xxx.dump | docker exec -i snmp-monitor-postgres \
  pg_restore -U snmp -d snmp_monitor --clean --if-exists
git checkout 上一个版本标签
docker compose up -d --build
```

## 9. 常用运维命令

```bash
# 查看状态
docker compose ps -a

# 查看全部服务日志
docker compose logs --tail=200

# 持续查看采集器日志
docker compose logs -f collector-go

# 重启单个服务
docker compose restart api-gateway

# 重新构建单个服务
docker compose up -d --build api-gateway

# 正常停止全部服务
docker compose down

# 启动全部服务
docker compose up -d
```

## 10. 客户交付检查表

- [ ] 已修改默认管理员密码。
- [ ] 已修改 `JWT_SECRET`。
- [ ] 已确认服务器可以访问设备 UDP 161。
- [ ] 已确认 `15173/tcp` 防火墙策略。
- [ ] 已确认 PostgreSQL 数据卷位置和可用容量。
- [ ] 已配置数据库定期备份并复制到其他存储。
- [ ] 已记录当前 Git 标签和部署日期。
- [ ] 已验证设备、模板、拓扑和告警页面。
- [ ] 已告知客户禁止执行 `docker compose down -v`。
