# 从原源码 Docker 部署升级到 v1.6.8

把 `upgrade-source.sh` 下载到客户电脑，在 WSL/Linux Bash 中执行。需要 Docker Engine、Docker Compose、Python 3.9+、curl、tar、sha256sum 和 flock。Ubuntu 通常已带齐，脚本会检查缺失项。不是 Windows PowerShell 脚本，也不适用于离线安装包或 PostgreSQL 16→18 主版本迁移。

客户原目录仍为 `/opt/netlooker/source-v1.6.1` 时：

```bash
bash /mnt/c/Users/user/Downloads/upgrade-source.sh /opt/netlooker/source-v1.6.1
```

如果原目录叫 snmp-for，替换最后的路径即可。脚本也可从数据库容器标签自动定位原目录：

```bash
bash /mnt/c/Users/user/Downloads/upgrade-source.sh
```

默认下载 GitHub v1.6.8，保留原项目名，使用新的独立源码目录，不覆盖原目录。只尝试启动原数据库容器一次，默认最多等待 10 分钟恢复到可连接且非 recovery 状态。恢复失败时停止，不会清空数据库或重建 PostgreSQL。

如需先预检：

```bash
CHECK_ONLY=1 bash /mnt/c/Users/user/Downloads/upgrade-source.sh /opt/netlooker/source-v1.6.1
```

预检会检查/必要时启动原数据库、下载源码并生成独立目录，但不会构建、停止应用或执行迁移。正式运行会创建另一份新目录，不复用半成品。

## 执行过程

1. 检查 Docker、原目录、项目标签和 PostgreSQL 18。
2. 保留原 Compose 的有效配置，确认其中数据卷与实际 PostgreSQL 挂载一致，并将原卷声明为 external，避免误创建空卷。
3. 下载源码并核对前后端版本。仅把构建上下文、迁移 SQL 挂载切换到新源码；保留原端口、环境参数、数据库连接、网络和其他自定义挂载。
4. 给旧容器镜像增加备份标签，再构建新镜像。此时原应用继续运行。
5. 停止五个应用服务，数据库保持运行；生成数据库 dump、验证目录清单并计算校验值。
6. 非交互执行迁移，成功后启动应用；重启 Web 并验证 API、网页健康和 API 版本。

原目录旁的 `backups/upgrade-v1.6.8-*` 保存配置、设备数量、数据库备份和旧镜像标签清单。**里面含密码和密钥，不要发到公开群或上传 GitHub。**

## 升级后

使用原网页地址，刷新确认登录页/侧栏显示 v1.6.8，核对原设备数量、历史流量和告警。之后从脚本输出的新目录管理服务：

```bash
cd /脚本输出的新目录
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail 100 api-gateway collector-go
```

新目录的 `docker-compose.yml` 是 JSON 格式的有效 Compose 配置快照，含原密码。以后修改配置，应编辑其中的 environment；单独修改 `.env` 不会改变已展开的配置。原目录中的自定义挂载文件仍可能被使用，所以不要删除原目录。脚本不更换 PostgreSQL 镜像，也不拉取新数据库镜像。

构建失败时不会停止原应用。停止应用之后若备份、迁移或验证失败，脚本保留现场并报告失败阶段，不自动恢复数据库；请携带报错排查，不能直接删除数据卷重新安装。不要执行 `down -v`、seed 初始化或 `pg_resetwal`。本脚本仅支持标准服务名、单个 PostgreSQL 命名数据卷与默认 snmp/snmp_monitor 数据库；其他部署需要适配。

此脚本随 v1.6.8 发布；使用前请先备份数据库与配置，并阅读本说明中的适用范围和限制。
