#!/usr/bin/env bash
# 服务器一键部署
#
#   curl 或 scp 把整个目录传上服务器，然后：
#     bash deploy.sh
#
# 前提：装好 Docker 和 docker compose 插件

set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "没装 Docker。先装： https://docs.docker.com/engine/install/"
  exit 1
fi

if [ ! -f .env ]; then
  echo "生成访问令牌…"
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  sed "s/change-me-to-a-random-string/$TOKEN/" .env.example > .env
  echo ""
  echo "  已生成 .env，访问令牌是： $TOKEN"
  echo "  （记下来，打开控制台要用）"
  echo ""
fi

echo "启动容器（首次会构建镜像，几分钟）…"
docker compose up -d --build

PORT=$(grep -E '^CONSOLE_PORT=' .env | cut -d= -f2)
PORT=${PORT:-7799}
TOKEN=$(grep -E '^CONSOLE_TOKEN=' .env | cut -d= -f2)

echo ""
echo "  起来了。"
echo ""
echo "  控制台： http://<服务器IP>:$PORT/?token=$TOKEN"
echo "  NapCat： 用 SSH 隧道访问 http://127.0.0.1:6099"
echo "           ssh -L 6099:127.0.0.1:6099 用户@服务器"
echo ""
echo "  看日志： docker compose logs -f app"
