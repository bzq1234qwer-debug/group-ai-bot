/**
 * Runtime 入口。
 *
 * 用法：
 *   node src/main.ts                       # 用 config.json，没有则进入演示模式
 *   node src/main.ts --config my.json      # 指定配置
 *   node src/main.ts --live                # 强制走真实 DeepSeek API
 *   node src/main.ts --mock                # 强制走离线 Mock
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildConfig, loadConfig, type RuntimeConfig } from "./config.ts";
import { createLogger, type LogLevel } from "./logger.ts";
import { Store } from "./store.ts";
import { Orchestrator } from "./orchestrator.ts";
import { OneBotAdapter } from "./adapters/onebot.ts";
import { QqBotAdapter } from "./adapters/qqbot.ts";
import { DeepSeekProvider } from "./providers/deepseek.ts";
import { MockProvider } from "./providers/mock.ts";
import type { Adapter } from "./types.ts";

const DEMO_CONFIG: Record<string, unknown> = {
  mode: "mock",
  logLevel: "debug",
  dbPath: "data/demo.db",
  channels: [
    {
      id: "qq:10001",
      label: "演示QQ",
      baseUrl: "http://127.0.0.1:3000",
      eventPort: 3001,
      eventPath: "/onebot/events",
    },
  ],
  agents: [{ id: "default", name: "小D" }],
  bindings: [{ convKey: "qq:10001:group:30003", agentId: "default", enabled: true }],
  sendDelayMs: 600,
};

function parseArgs(argv: string[]): { configPath?: string; mode?: "mock" | "live"; logLevel?: LogLevel } {
  const result: { configPath?: string; mode?: "mock" | "live"; logLevel?: LogLevel } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      result.configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--mock") {
      result.mode = "mock";
    } else if (arg === "--live") {
      result.mode = "live";
    } else if (arg === "--log") {
      result.logLevel = argv[i + 1] as LogLevel;
      i += 1;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let cfg: RuntimeConfig;
  if (args.configPath) {
    cfg = loadConfig(args.configPath);
  } else if (existsSync("config.json")) {
    cfg = loadConfig("config.json");
  } else {
    cfg = buildConfig(DEMO_CONFIG);
  }

  if (args.mode) cfg.mode = args.mode;
  if (args.logLevel) cfg.logLevel = args.logLevel;

  const log = createLogger(cfg.logLevel, "runtime");

  if (cfg.dbPath !== ":memory:") {
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
  }
  const store = new Store(cfg.dbPath);

  if (cfg.mode === "live" && !cfg.deepseek.apiKey) {
    log.error("live 模式需要 DEEPSEEK_API_KEY 环境变量（或写入本地加密存储）");
    process.exitCode = 1;
    store.close();
    return;
  }

  const provider =
    cfg.mode === "mock"
      ? new MockProvider()
      : new DeepSeekProvider({
          apiKey: cfg.deepseek.apiKey,
          baseUrl: cfg.deepseek.baseUrl,
          defaultModel: cfg.deepseek.model,
        });

  const agents = new Map(cfg.agents.map((a) => [a.id, a]));

  const adapters: Adapter[] = [];
  for (const ch of cfg.channels) {
    if (ch.kind === "qqbot") {
      if (!ch.appId || !ch.appSecret) {
        log.error(`通道 ${ch.id} 缺少 appId / appSecret，已跳过（appSecret 可用 QQBOT_APP_SECRET 环境变量）`);
        continue;
      }
      adapters.push(
        new QqBotAdapter({
          channelId: ch.id,
          appId: ch.appId,
          appSecret: ch.appSecret,
          apiBase: ch.apiBase,
        }),
      );
    } else {
      adapters.push(
        new OneBotAdapter({
          channelId: ch.id,
          baseUrl: ch.baseUrl,
          token: ch.token,
          selfId: ch.selfId,
          eventPort: ch.eventPort,
          eventPath: ch.eventPath,
          eventToken: ch.eventToken,
          wsUrl: ch.wsUrl,
        }),
      );
    }
  }

  if (adapters.length === 0) {
    log.error("没有可用的通道，检查配置");
    store.close();
    process.exitCode = 1;
    return;
  }

  // 每个通道一个编排器实例（M0 简化：通道能力一致，共享一个 store）
  const runners = adapters.map((adapter) => {
    const runner = new Orchestrator({
      adapter,
      provider,
      store,
      agents,
      bindings: cfg.bindings,
      quota: cfg.quota,
      logger: log.child(adapter.kind),
      sendDelayMs: cfg.sendDelayMs,
    });
    adapter.onMessage((env) => {
      void runner.handleEnvelope(env);
    });
    adapter.onNotice((notice) => {
      log.info(`通道事件 ${notice.channelId}: ${notice.kind} ${notice.message}`);
    });
    return runner;
  });

  for (const adapter of adapters) {
    await adapter.start();
    log.info(`通道已启动 ${adapter.kind}`);
  }

  log.info(`模式=${cfg.mode} 通道=${adapters.length} 绑定=${cfg.bindings.length} 模型=${provider.id}`);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`收到 ${signal}，正在退出…`);
    await Promise.all(adapters.map((a) => a.stop()));
    await Promise.all(runners.map((r) => r.drain()));
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("启动失败", err);
  process.exit(1);
});
