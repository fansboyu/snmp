#!/usr/bin/env bash
# Run in Linux/WSL. Downloads tagged source; never initializes or deletes data.
set -Eeuo pipefail
umask 077

VERSION="${2:-v1.6.10}"
PG_CONTAINER="${PG_CONTAINER:-snmp-monitor-postgres}"
WAIT_SECONDS="${WAIT_SECONDS:-600}"
phase='preflight'
backup_dir=''
new_dir=''
apps_stopped=false
fail() { printf 'ERROR: %s\n' "$*" >&2; return 1; }
on_error() {
  local rc=$?
  trap - ERR
  printf '\n升级停止，阶段：%s，退出码：%s\n' "$phase" "$rc" >&2
  printf '备份目录：%s\n新版目录：%s\n' "${backup_dir:-尚未创建}" "${new_dir:-尚未创建}" >&2
  if $apps_stopped; then
    echo '应用可能保持停止。不要清空数据或重跑初始化；请保留错误日志排查。脚本不会自动恢复数据库。' >&2
  else
    echo '尚未停止应用服务。' >&2
  fi
  exit "$rc"
}
trap on_error ERR

[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '版本格式应为 vX.Y.Z'
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] && (( WAIT_SECONDS >= 10 && WAIT_SECONDS <= 3600 )) || fail 'WAIT_SECONDS 应在 10 到 3600 之间'
for command in docker curl tar python3 sha256sum flock; do
  command -v "$command" >/dev/null || fail "缺少命令：$command"
done
docker info >/dev/null
docker compose version >/dev/null

if [[ -n "${1:-}" ]]; then
  old_dir=$(cd -- "$1" && pwd -P)
else
  old_dir=$(docker inspect "$PG_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
  [[ -n "$old_dir" && "$old_dir" != '<no value>' ]] || fail '无法定位部署目录，请把原目录作为第一个参数'
  old_dir=$(cd -- "$old_dir" && pwd -P)
fi
old_file="$old_dir/docker-compose.yml"
[[ -f "$old_file" ]] || fail '仅支持含 docker-compose.yml 的源码部署；不适用于离线安装包'
project=$(docker inspect "$PG_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project" }}')
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail '无法确认原 Compose 项目名'
exec 9>"$old_dir/.netlooker-upgrade.lock"
flock -n 9 || fail '另一个升级脚本正在执行'

root_dir=$(dirname -- "$old_dir")
mkdir -p "$root_dir/backups"
backup_dir=$(mktemp -d "$root_dir/backups/upgrade-${VERSION}-XXXXXX")
printf '%s\n' "$old_dir" > "$backup_dir/old-directory.txt"
printf '%s\n' "$project" > "$backup_dir/project-name.txt"
docker inspect "$PG_CONTAINER" > "$backup_dir/postgres-inspect.json"
# Preserve the original effective configuration, including automatic overrides.
docker compose --project-directory "$old_dir" -p "$project" config --format json > "$backup_dir/original-compose.json"
api_container=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=api-gateway' | head -n 1)
if [[ -n "$api_container" ]]; then
  docker inspect "$api_container" > "$backup_dir/api-inspect.json"
fi
cp -p -- "$old_file" "$backup_dir/docker-compose.yml"
[[ ! -f "$old_dir/.env" ]] || cp -p -- "$old_dir/.env" "$backup_dir/config.env"

echo "目标版本：$VERSION；沿用项目：$project"
echo "原目录：$old_dir"
echo "备份目录：$backup_dir（包含配置与密钥，请勿公开）"

phase='database recovery'
if [[ "$(docker inspect "$PG_CONTAINER" --format '{{.State.Running}}')" != true ]]; then
  echo '正在启动原 PostgreSQL 容器；只启动一次，不反复重启。'
  docker start "$PG_CONTAINER" >/dev/null
fi
deadline=$((SECONDS + WAIT_SECONDS))
while :; do
  if [[ "$(docker inspect "$PG_CONTAINER" --format '{{.State.Running}}')" != true ]]; then
    docker logs --since 15m --tail 100 "$PG_CONTAINER" >&2
    fail 'PostgreSQL 启动后退出。先修复数据库，再升级'
  fi
  result=$(docker exec "$PG_CONTAINER" psql -X -U snmp -d snmp_monitor -Atq \
    -c "select current_setting('server_version_num')||'|'||pg_is_in_recovery()::text" 2>/dev/null || true)
  if [[ "$result" =~ ^([0-9]+)\|false$ ]]; then
    pg_version="${BASH_REMATCH[1]}"
    (( pg_version >= 180000 && pg_version < 190000 )) || fail '仅支持 PostgreSQL 18；其他主版本需单独迁移'
    break
  fi
  if (( SECONDS >= deadline )); then
    docker logs --since 15m --tail 100 "$PG_CONTAINER" >&2
    fail '等待数据库完成恢复超时；未执行升级，也未删除数据'
  fi
  echo '数据库尚未就绪，5 秒后再检查……'
  sleep 5
done
docker exec "$PG_CONTAINER" psql -X -U snmp -d snmp_monitor -Atq \
  -c 'select count(*) from devices' > "$backup_dir/device-count-before.txt"

phase='download source'
curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 \
  "https://github.com/fansboyu/snmp/archive/refs/tags/${VERSION}.tar.gz" \
  --output "$backup_dir/source.tar.gz"
sha256sum "$backup_dir/source.tar.gz" > "$backup_dir/source.tar.gz.sha256"
new_dir=$(mktemp -d "$root_dir/source-${VERSION}-XXXXXX")
python3 - "$backup_dir/source.tar.gz" "$new_dir" <<'PY'
import pathlib, sys, tarfile
destination = pathlib.Path(sys.argv[2])
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    roots = {pathlib.PurePosixPath(m.name).parts[0] for m in members if m.name}
    if len(roots) != 1:
        raise SystemExit('源码压缩包目录结构异常')
    for m in members:
        parts = pathlib.PurePosixPath(m.name).parts
        if m.name.startswith('/') or '..' in parts or not (m.isfile() or m.isdir()):
            raise SystemExit('源码压缩包包含不支持的路径或链接')
        if len(parts) < 2:
            continue
        target = destination.joinpath(*parts[1:])
        if m.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(m) as src, target.open('wb') as dst:
                dst.write(src.read())
            target.chmod(m.mode & 0o777)
PY

phase='preserve deployment configuration'
# Generate a standalone Compose file from the old effective configuration.
# Only build contexts and migrator SQL bindings move to the new source.
python3 - "$backup_dir/original-compose.json" "$backup_dir/postgres-inspect.json" "$new_dir" "$VERSION" <<'PY'
import json, pathlib, sys
config = json.load(open(sys.argv[1]))
pg = json.load(open(sys.argv[2]))[0]
dest, version = pathlib.Path(sys.argv[3]), sys.argv[4].removeprefix('v')
for folder in ('api-gateway', 'web-vue3'):
    if json.loads((dest / folder / 'package.json').read_text())['version'] != version:
        raise SystemExit('下载源码的版本号不匹配')
services = config['services']
contexts = {'api-gateway':'api-gateway', 'migrator':'api-gateway', 'collector-go':'collector-go',
            'notifier':'collector-go', 'discovery-worker':'collector-go', 'web-vue3':'web-vue3'}
if 'postgres' not in services or any(s not in services for s in contexts):
    raise SystemExit('原编排缺少标准服务；需要人工适配，未停止原应用')
mounts = [m for m in pg['Mounts'] if m['Destination'] in ('/var/lib/postgresql','/var/lib/postgresql/data')]
if len(mounts) != 1 or mounts[0]['Type'] != 'volume':
    raise SystemExit('仅支持 PostgreSQL 单一命名数据卷；当前部署需人工适配')
actual = mounts[0]
volumes = services['postgres'].get('volumes', [])
data_mount = [v for v in volumes if v.get('target') == actual['Destination']]
if len(data_mount) != 1 or data_mount[0].get('type') != 'volume':
    raise SystemExit('原 Compose 的数据目录与实际容器不匹配')
key = data_mount[0]['source']
configured_name = config.get('volumes',{}).get(key,{}).get('name')
if configured_name != actual['Name']:
    raise SystemExit('Compose 项目或数据卷名与实际容器不一致；停止，避免连接空数据库')
config.setdefault('volumes',{})[key] = {'external':True,'name':actual['Name']}
actual_env = dict(v.split('=',1) for v in pg['Config'].get('Env',[]) if '=' in v)
for key in ('POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD'):
    declared = services['postgres'].get('environment',{}).get(key)
    if declared is not None and declared != actual_env.get(key):
        raise SystemExit('原配置与数据库容器的 '+key+' 不一致；请先核对原配置')
api_inspect=pathlib.Path(sys.argv[1]).parent/'api-inspect.json'
if api_inspect.exists():
    runtime=json.loads(api_inspect.read_text())[0]
    runtime_env=dict(v.split('=',1) for v in runtime['Config'].get('Env',[]) if '=' in v)
    declared_env=services['api-gateway'].get('environment',{})
    for key in ('DATABASE_URL','JWT_SECRET','ADMIN_USERNAME','ADMIN_PASSWORD','SMTP_PASSWORD'):
        if key in runtime_env or key in declared_env:
            if declared_env.get(key) != runtime_env.get(key):
                raise SystemExit('原配置与 API 容器的 '+key+' 不一致，请先恢复原 .env；不会重置密钥')
for service, folder in contexts.items():
    build = services[service].get('build')
    if not isinstance(build,dict):
        raise SystemExit('只支持源码构建部署：'+service+' 没有 build 配置')
    build['context'] = str(dest / folder)
bindings = services['migrator'].get('volumes',[])
for v in bindings:
    if v.get('target') == '/app/schema.sql':
        v['source'] = str(dest / 'postgres/schema.sql')
    if v.get('target') == '/app/migrations':
        v['source'] = str(dest / 'postgres/migrations')
if not all(any(v.get('target')==target and v.get('type')=='bind' for v in bindings)
           for target in ('/app/schema.sql','/app/migrations')):
    raise SystemExit('无法确认数据库迁移挂载位置')
# Compose interpolates dollar signs even in JSON strings. Preserve literal secrets.
def escape(value):
    if isinstance(value,str): return value.replace('$','$$')
    if isinstance(value,list): return [escape(v) for v in value]
    if isinstance(value,dict): return {k:escape(v) for k,v in value.items()}
    return value
(dest/'docker-compose.yml').write_text(json.dumps(escape(config),ensure_ascii=False,indent=2)+'\n')
(dest/'docker-compose.yml').chmod(0o600)
print('配置已保留，原数据库卷已固定为 external；不会创建替代数据卷。')
PY
[[ ! -f "$old_dir/.env" ]] || cp -p -- "$old_dir/.env" "$new_dir/.env"
python3 - "$new_dir/.env" "$project" <<'PY'
import pathlib, re, sys
p=pathlib.Path(sys.argv[1])
s=p.read_text() if p.exists() else ''
s=re.sub(r'^\s*(?:export\s+)?COMPOSE_(?:PROJECT_NAME|FILE)\s*=.*$', '', s, flags=re.M)
p.write_text(s+'\nCOMPOSE_PROJECT_NAME='+sys.argv[2]+'\n')
p.chmod(0o600)
PY
compose() { docker compose --project-directory "$new_dir" -p "$project" -f "$new_dir/docker-compose.yml" "$@"; }
compose config --quiet
if [[ "${CHECK_ONLY:-0}" == 1 ]]; then
  printf '\n预检成功，未构建镜像、停止应用或执行迁移。\n新版目录：%s\n' "$new_dir"
  exit 0
fi

phase='preserve previous images'
stamp="$(date +%Y%m%d%H%M%S)-$RANDOM"
for service in api-gateway collector-go discovery-worker notifier web-vue3 migrator; do
  cid=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service" | head -n 1)
  [[ -n "$cid" ]] || continue
  image_id=$(docker inspect "$cid" --format '{{.Image}}')
  tag="netlooker-upgrade-backup/$service:$stamp"
  docker image tag "$image_id" "$tag"
  printf '%s %s %s\n' "$service" "$image_id" "$tag" >> "$backup_dir/previous-images.txt"
done
phase='build new images'
compose build </dev/null

phase='stop application and backup database'
apps=(api-gateway web-vue3 collector-go discovery-worker notifier)
apps_stopped=true
compose stop "${apps[@]}"
# Binary output stays inside the container until docker cp; no shell encoding risk.
dump_path="/tmp/netlooker-$stamp.dump"
docker exec "$PG_CONTAINER" pg_dump -U snmp -d snmp_monitor -Fc -f "$dump_path"
docker exec "$PG_CONTAINER" pg_restore --list "$dump_path" > "$backup_dir/database-contents.txt"
docker cp "$PG_CONTAINER:$dump_path" "$backup_dir/database.dump"
test -s "$backup_dir/database.dump"
sha256sum "$backup_dir/database.dump" > "$backup_dir/database.dump.sha256"
docker exec "$PG_CONTAINER" rm -f "$dump_path"

phase='database migrations'
compose run --interactive=false -T --rm --no-deps migrator </dev/null
phase='start updated application'
# Do not recreate PostgreSQL, change its image, or trigger initialization scripts.
compose up -d --no-deps "${apps[@]}" </dev/null
compose restart web-vue3 </dev/null

phase='health verification'
api_id=$(compose ps -q api-gateway)
web_id=$(compose ps -q web-vue3)
healthy=false
for attempt in $(seq 1 30); do
  if docker exec "$api_id" node -e 'fetch("http://127.0.0.1:3000/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1 \
    && docker exec "$web_id" wget -q -O /dev/null http://127.0.0.1/health >/dev/null 2>&1; then
    healthy=true; break
  fi
  sleep 2
done
$healthy || fail '网页/API 健康检查失败；请保留现场，查看新版目录 compose logs'
api_version=$(docker exec "$api_id" node -p 'require("./package.json").version')
[[ "$api_version" == "${VERSION#v}" ]] || fail '运行中的 API 版本与目标版本不一致'
docker exec "$PG_CONTAINER" psql -X -U snmp -d snmp_monitor -Atq \
  -c 'select count(*) from devices' > "$backup_dir/device-count-after.txt"
compose ps
printf '\n升级成功：%s\n新目录：%s\n备份：%s\n原项目：%s\n' "$VERSION" "$new_dir" "$backup_dir" "$project"
echo '请沿用原网页地址，刷新后检查版本号、设备数量和历史流量。以后从新目录管理服务。'
echo '新目录 Compose 是保留原配置的独立快照（含密钥）；修改配置请编辑其中 environment，不能仅修改 .env。请保留原目录及其中的自定义挂载文件。'
