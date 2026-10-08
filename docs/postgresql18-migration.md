# PostgreSQL 18 迁移说明

当前 Compose 使用 postgres:18-alpine；Docker 官方镜像的数据目录为 /var/lib/postgresql/18/docker，命名卷 postgres18-data 挂载到 /var/lib/postgresql。采集器在 /postgres-data 只读挂载同一个新卷，用于磁盘保护。旧 PostgreSQL 16 的 postgres-data 卷保留，不能直接给 18 使用。

## 已运行环境的迁移

1. 拉取并核验 PostgreSQL 18 镜像。保存旧 Compose、运行配置和原数据库镜像 ID，备份目录应限制访问权限。
2. 停止 API、网页、采集器、发现服务及通知服务，避免最终备份期间产生新写入。保持 PostgreSQL 16 运行。
3. 在旧数据库容器执行 pg_dump -Fc，将归档用 docker cp 复制到宿主机；不要通过 Windows PowerShell 文本管道传递二进制。保存原 JWT_SECRET，以便读取已有加密邮件密码。现有离线包可使用其 backup.ps1。
4. 停止旧数据库，创建独立的新 PostgreSQL 18 卷。不能删除、重命名内容或覆盖旧卷。使用新的默认目录布局；逻辑恢复允许新集群启用默认的数据页校验。
5. 将归档复制进新容器，使用 PostgreSQL 18 pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error 恢复到 snmp_monitor。项目只使用 snmp 角色；存在额外角色或授权的客户环境需另外迁移角色和权限。
6. 比较所有业务表、序列及 schema_migrations；检查账号、设备、接口、历史样本、告警、邮件配置。执行 ANALYZE，并在应用写入暂停时运行 migrator。
7. 启动应用，验证登录、图表、Go 数据库读写、保留策略、备份恢复、磁盘检查挂载和重启持久化。设备 SNMP 不可达与数据库兼容性应分别判断。

## 回退

新库恢复或验收失败且尚未恢复正式写入时，停止新环境，使用保存的旧 Compose、原镜像和原 postgres-data 卷启动 16。新库开始写入后，旧卷不包含新数据，需要先确定可接受的数据边界；不要盲目回退。18 的备份不保证可以恢复到 16。

## 发布与备份

已发布的 v1.6.0 包保持 PostgreSQL 16，不覆盖历史附件。新的离线构建应使用新的发布版本号。VERSION.json 记录 postgresMajor=18 及镜像 ID；运行备份记录实际服务器版本，归档导入记录来源版本和 pg_dump 版本。当前恢复工具只支持经过验证的 16/18 备份到 18，不支持向旧主版本降级。

postgres:18-alpine 是主版本滚动标签；发布时镜像 ID 与离线清单固定具体内容，部署不得重新拉取来替换已验证镜像。数据库主版本不应再从应用版本号推断。
