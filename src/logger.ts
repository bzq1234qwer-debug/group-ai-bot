/**
 * 日志：所有输出都会过一遍脱敏，防止 API Key 落到日志文件里。
 */

import { redactSecrets } from "./text.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(tag: string): Logger;
}

/** 把每一行额外写到某个地方（文件），控制台隐藏运行时靠它留证据 */
export type LogSink = (line: string) => void;

function stringifyExtra(extra: unknown): string {
  if (extra === undefined) return "";
  try {
    if (extra instanceof Error) {
      return ` ${extra.name}: ${extra.message}`;
    }
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return " [unserializable]";
  }
}

export function createLogger(level: LogLevel = "info", tag = "app", sink?: LogSink): Logger {
  const min = ORDER[level];
  const enabled = (l: LogLevel): boolean => ORDER[l] >= min;

  const emit = (l: LogLevel, msg: string, extra?: unknown): void => {
    if (!enabled(l)) return;
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    const line = redactSecrets(`[${ts}] ${l.toUpperCase().padEnd(5)} [${tag}] ${msg}${stringifyExtra(extra)}`);
    if (l === "error" || l === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
    sink?.(line);
  };

  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
    child: (t) => createLogger(level, `${tag}/${t}`, sink),
  };
}
