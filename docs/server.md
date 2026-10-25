# 部署到服务器

> 适用：用户自己有一台 Linux 服务器（1 核 2G 就够），想让机器人 7×24 在线，不再依赖自己电脑开机。

## 为什么值得

电脑关机、断网、出差，机器人就死了。放到服务器上，这些都不影响。

## 先看清代价（重要）

这条路可行，但有三个必须认的事实：

| 事实 | 说明 |
|---|---|
| **镜像很大** | NapCat 容器约 600MB，加系统盘至少留 5GB |
| **必须锁版本** | NapCat 最新版有已知问题：登录会被风控检测导致频繁掉线（[issue #1728](https://github.com/NapNeko/NapCatQQ/issues/1728)）。社区经验是锁某个版本长期稳定，追新反而一两天掉一次。`docker-compose.yml` 里已经锁了 `v4.18.41`，**不要改成 latest** |
| **门槛在 SSH** | 会装系统、会用命令行的人不到 1%。如果你的用户是"有电脑但不会服务器"的人，这条路对他们等于不存在 |

换句话说：**它把"装一个 Windows 软件"换成了"会 SSH 上服务器"，用户池小了一个数量级。**

有服务器、愿意折腾的人 ↔ 这个方案完全可行。
只有一台电脑、不想学命令的人 ↔ 这个方案对他们不成立，要么继续用电脑，要么由你来做托管。

## 配置够不够？2 核 2G 5M 可以

实测参考（Windows 下）：

```
QQ 客户端（4 个进程）  94 MB
控制台运行时           72 MB
```

Linux 容器里 QQ 通常更重，加上 NapCat 自身开销，保守按 **400~800MB** 估。

| 配置 | 判断 |
|---|---|
| 1 核 1G | ❌ 大概率被 OOM 杀掉 |
| **2 核 2G** | ✅ **可以，建议加 2G swap 兜底** |
| 2 核 4G | ✅ 宽裕，QQ 内存涨了也不怕 |
| 带宽 5M | ✅ 够用。普通聊天图 100~500KB；4MB 大图上传约 6 秒 |
| 磁盘 20G | ✅ 必需（镜像就 600MB，加系统、数据、日志） |

### 一定要加 swap

2G 内存跑 QQ，最怕它悄悄涨内存把整台机器拖死。加 2G swap 当保险：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # 确认 Swap 那行有 2.0Gi
```

### 上线后盯这几条

```bash
docker stats --no-stream      # 看两个容器各吃多少内存
free -h                       # 看还剩多少
docker compose logs --tail 50 napcat | grep -i "oom\|killed"
```

`docker-compose.yml` 里已经给容器加了内存上限（napcat 1.2G、app 256M）。
**超了只会杀掉那个容器然后自动重启，不会把整台服务器拖死。**

如果发现 napcat 容器反复重启，说明 QQ 内存涨超了——换 4G 机器，或者重启容器释放。

## 前提

- 一台 Linux 服务器（Ubuntu 20.04+ / Debian 11+），**2 核 2G 起步**（QQ 本身就吃内存）
- 装了 Docker 和 docker compose 插件
- 服务器能访问 `api.deepseek.com` 和腾讯的服务器
- **同一个号不要在电脑上再登一次**，会互相踢下线（机器人当场掉线）

## 三步

### 1. 把代码传上去

```bash
scp -r group-ai-bot 用户@服务器:/opt/
ssh 用户@服务器
cd /opt/group-ai-bot
```

### 2. 一键启动

```bash
bash deploy.sh
```

它会：
- 自动生成访问令牌（写进 `.env`）
- 构建镜像、起两个容器：`groupai-napcat`（QQ + NapCat）和 `groupai-app`（我们的运行时）

输出里会给你控制台地址和令牌，**记下来**。

### 3. 登录 QQ

容器里的 QQ 没有界面，要靠 NapCat 的 WebUI 扫码。WebUI 只绑了本机，用 SSH 隧道打开：

```bash
ssh -L 6099:127.0.0.1:6099 用户@服务器
```

然后在**你自己电脑**的浏览器打开 `http://127.0.0.1:6099`，用手机 QQ 扫里面的二维码。

> 为什么要隧道：6099 是 NapCat 的管理界面，直接暴露到公网等于把账号操作权交出去。

### 4. 在 NapCat 里开 WebSocket 服务 ← 这一步最容易漏

登录成功后，在 NapCat WebUI 里找到「网络配置」，新建一个 **WebSocket 服务端**：

| 项 | 值 |
|---|---|
| host | `0.0.0.0`（必须是 0.0.0.0，否则容器里的 app 连不上） |
| port | `3001` |
| token | 留空（只在容器内网，不对外） |
| 消息格式 | `array` |

保存后重启 NapCat 容器：`docker compose restart napcat`

### 5. 打开控制台

```
http://<服务器IP>:7799/?token=<你的令牌>
```

首次会要求确认风险条款，然后：

1. 填 DeepSeek Key（点「测试」确认通）
2. 等群列表出现，勾选要启用的群
3. 在群里 @ 它

## 安全边界（别省）

| 项 | 为什么 |
|---|---|
| **必须设 CONSOLE_TOKEN** | 不设的话，任何人打开 7799 就能控制你的机器人、看到你的 Key |
| **6099 不要暴露公网** | NapCat 管理界面 = 账号操作权，用 SSH 隧道 |
| **建议加 HTTPS** | 前面加一层 Caddy/Nginx 反代，不然令牌是明文过网 |
| **data/ 目录要备份** | 里面有配置、记忆、用量；Key 也在里面 |

Caddy 反代示例（`/etc/caddy/Caddyfile`）：

```
ai.example.com {
    reverse_proxy 127.0.0.1:7799
}
```

## 常见问题

**控制台打不开 401**
→ 地址后面要带 `?token=xxx`，或者页面弹出输入框时填 `.env` 里的令牌

**控制台显示通道离线**
→ 多半是 NapCat 的 WebSocket 服务没开，或 host 不是 `0.0.0.0`。`docker compose logs napcat` 看有没有 `WebSocket服务 ... 已启动`

**扫码后一直掉线**
→ 容器里 QQ 需要能连腾讯服务器；有些机房 IP 会被风控，换 IP 或换机房试试

**内存不够**
→ QQ 客户端比较吃内存，1G 内存的机器可能会被 OOM 杀掉，建议 2G 起
