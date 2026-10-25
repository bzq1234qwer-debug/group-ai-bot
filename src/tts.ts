/**
 * 语音合成：把文字变成一条能发出去的音频。
 *
 * 三种引擎，覆盖不同取舍：
 * - edge   ：微软在线的神经音色，免费、质量最好、音色多，但要联网
 * - sapi   ：Windows 自带，完全离线，中文只有 1~2 个音色
 * - custom ：留一个命令模板的口子 —— 用户想用 GPT-SoVITS / Fish Speech 这类
 *            自己的模型，只要能"文本进、音频出"，填个命令就能接上
 *
 * 文本不走命令行参数，而是写进临时文件：中文标点加引号在 shell 里太容易翻车。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type VoiceEngine = "edge" | "sapi" | "custom" | "http";

export interface VoicePreset {
  id: string;
  /** 界面上显示的名字，例如「晓晓 · 温柔女声」 */
  name: string;
  engine: VoiceEngine;
  /** edge: 音色 id；sapi: 系统语音名 */
  voice?: string;
  /** edge 专用：语速 "-10%"、音调 "+2Hz" */
  rate?: string;
  pitch?: string;
  /** custom 专用：命令模板，支持 {text} 与 {out} 占位符 */
  command?: string;
  /** http 专用：TTS 服务地址，POST {text, emotion} 返回音频 */
  url?: string;
  /** http 专用：情感标签，例如 tender / happy */
  emotion?: string;
  /** http 专用：鉴权 Key，会放进 Authorization: Bearer */
  apiKey?: string;
  /**
   * http 专用：请求格式
   * - simple（默认）：{text, emotion} —— 给 whale-voice 这类自建服务
   * - openai：{model, voice, input, instructions} —— 给 OpenAI / Azure 兼容的 /audio/speech
   */
  format?: "simple" | "openai";
  /** openai 格式时的模型名，例如 gpt-4o-mini-tts */
  model?: string;
}

export interface SynthesizeOptions {
  outDir: string;
  /** 用来跑 edge-tts 的 python，默认 "python" */
  python?: string;
  /** 合成超时，默认 20 秒 */
  timeoutMs?: number;
  /** 给自定义命令用的工作目录 */
  cwd?: string;
}

export interface SynthesizeResult {
  file: string;
  engine: VoiceEngine;
}

/** 默认音色：一组开箱可用的预设 */
export const DEFAULT_VOICES: VoicePreset[] = [
  { id: "xiaoxiao", name: "晓晓 · 温柔女声", engine: "edge", voice: "zh-CN-XiaoxiaoNeural" },
  { id: "xiaoyi", name: "晓伊 · 活泼女声", engine: "edge", voice: "zh-CN-XiaoyiNeural" },
  { id: "yunxi", name: "云希 · 少年音", engine: "edge", voice: "zh-CN-YunxiNeural" },
  { id: "yunjian", name: "云健 · 解说男声", engine: "edge", voice: "zh-CN-YunjianNeural" },
  { id: "yunyang", name: "云扬 · 播音男声", engine: "edge", voice: "zh-CN-YunyangNeural" },
  { id: "xiaobei", name: "晓北 · 东北话", engine: "edge", voice: "zh-CN-liaoning-XiaobeiNeural" },
  { id: "huihui", name: "慧慧 · 系统离线音色", engine: "sapi", voice: "Microsoft Huihui Desktop" },
];

function extOf(engine: VoiceEngine): string {
  return engine === "sapi" || engine === "http" ? "wav" : "mp3";
}

/**
 * 解析出 python 的真实路径并锁住。
 *
 * Windows 上 PATH 里的 python 可能是应用商店的占位符，
 * 从隐藏窗口的进程里调起来会失败或跑到别的解释器上。
 * 启动时问一次 sys.executable，之后都用绝对路径。
 */
export async function resolvePython(): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn("python", ["-c", "import sys;print(sys.executable)"], {
        windowsHide: true,
      });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve(undefined);
      }, 8000);

      child.stdout?.on("data", (c: Buffer) => {
        out += c.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const path = out.trim().split(/\r?\n/).pop() ?? "";
        resolve(code === 0 && path.length > 3 ? path : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

export async function synthesize(
  text: string,
  preset: VoicePreset,
  options: SynthesizeOptions,
): Promise<SynthesizeResult> {
  const clean = text.trim();
  if (!clean) throw new Error("没有可念的文字");

  // 一律转成绝对路径：控制台传来的目录里可能带 ".."，外部程序解析起来容易出错
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const out = join(outDir, `tts-${stamp}.${extOf(preset.engine)}`);
  const txtPath = join(outDir, `tts-${stamp}.txt`);
  writeFileSync(txtPath, clean, "utf8");

  let produced = out;

  try {
    switch (preset.engine) {
      case "edge":
        // 微软的在线合成有限流，偶尔会直接返回"没有音频"。
        // 退避后重试，实测能把大部分瞬时失败救回来。
        {
          let lastError: unknown;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await runEdge(preset, txtPath, out, options);
              lastError = undefined;
              break;
            } catch (err) {
              lastError = err;
              const message = err instanceof Error ? err.message : String(err);
              if (!/NoAudioReceived|没有音频/i.test(message)) throw err;
              await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
            }
          }
          if (lastError) throw lastError;
        }
        break;
      case "sapi":
        await runSapi(preset, txtPath, out, options);
        break;
      case "custom":
        await runCustom(preset, clean, out, options);
        break;
      case "http":
        produced = await runHttp(preset, clean, out, options);
        break;
      default:
        throw new Error(`不认识的语音引擎：${String(preset.engine)}`);
    }
  } finally {
    rmSync(txtPath, { force: true });
  }

  if (!existsSync(produced)) throw new Error("合成没有产出音频文件");
  // 有些引擎会"成功"地写出一个只有文件头的空音频，退出码还是 0
  if (statSync(produced).size < 512) throw new Error("合成产出的音频是空的（引擎没有真正发声）");
  return { file: produced, engine: preset.engine };
}

function runEdge(
  preset: VoicePreset,
  txtPath: string,
  out: string,
  options: SynthesizeOptions,
): Promise<void> {
  const args = ["-m", "edge_tts", "--file", txtPath, "--write-media", out];
  if (preset.voice) args.push("--voice", preset.voice);
  if (preset.rate) args.push("--rate", preset.rate);
  if (preset.pitch) args.push("--pitch", preset.pitch);

  return run(options.python ?? "python", args, options);
}

function runSapi(
  preset: VoicePreset,
  txtPath: string,
  out: string,
  options: SynthesizeOptions,
): Promise<void> {
  // 读绝对路径的文件，而不是 stdin：
  // 无控制台的子进程里 [Console]::In 可能读不到内容，结果生成了一个只有文件头的空音频
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    preset.voice ? `try { $s.SelectVoice('${preset.voice.replace(/'/g, "''")}') } catch { }` : "",
    `$txt = Get-Content -Raw -Encoding UTF8 -LiteralPath '${txtPath.replace(/'/g, "''")}'`,
    "if ([string]::IsNullOrWhiteSpace($txt)) { throw '没有读到要念的文字' }",
    `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}')`,
    "$s.Speak($txt)",
    "$s.Dispose()",
  ]
    .filter(Boolean)
    .join("; ");

  return run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], options, {
    quiet: true,
  });
}

function runCustom(
  preset: VoicePreset,
  text: string,
  out: string,
  options: SynthesizeOptions,
): Promise<void> {
  const template = (preset.command ?? "").trim();
  if (!template) throw new Error("自定义音色没填命令模板");

  // {text} 里可能有引号，走环境变量传更稳
  const command = template.replace(/\{out\}/g, out).replace(/\{text\}/g, "$env:GROUPAI_TTS_TEXT");
  return run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    ...options,
    env: { ...process.env, GROUPAI_TTS_TEXT: text },
  });
}

interface RunOptions extends SynthesizeOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * 调一个本地/远程的 TTS 服务：POST JSON，收回音频字节。
 *
 * 这是"接自己的语音系统"的标准口子：whale-voice 的 daemon、自己写的 FastAPI、
 * 云厂商的代理，只要满足「POST {text, emotion} → 返回音频」这一个约定就能用。
 */
async function runHttp(
  preset: VoicePreset,
  text: string,
  out: string,
  options: SynthesizeOptions,
): Promise<string> {
  const url = (preset.url ?? "").trim();
  if (!url) throw new Error("http 音色没填服务地址");

  const timeoutMs = options.timeoutMs ?? 60_000; // 本地大模型首句可能要几十秒
  const isOpenAi = preset.format === "openai";

  const body = isOpenAi
    ? {
        model: preset.model ?? "gpt-4o-mini-tts",
        voice: preset.voice ?? "alloy",
        input: text,
        instructions: preset.emotion ?? "",
      }
    : { text, emotion: preset.emotion ?? "tender" };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (preset.apiKey) headers.authorization = `Bearer ${preset.apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`语音服务返回 ${res.status}：${detail.slice(0, 120)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 512) throw new Error("语音服务返回的音频是空的");

  // 按返回的 content-type 决定扩展名：OpenAI 系返回 mp3，自建服务多是 wav
  const type = res.headers.get("content-type") ?? "";
  const finalPath = type.includes("mpeg") || type.includes("mp3")
    ? out.replace(/\.wav$/i, ".mp3")
    : out;
  writeFileSync(finalPath, buf);
  return finalPath;
}

function run(
  file: string,
  args: string[],
  options: RunOptions,
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;

  return new Promise((resolve, reject) => {
    // quiet = 不接任何管道。System.Speech 在 stdio 被接管时会静默失败，
    // 只写出一个空壳 wav；实测改成 ignore 就正常出声。
    const child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env ?? process.env,
      stdio: opts.quiet ? "ignore" : ["pipe", "pipe", "pipe"],
    });

    if (!opts.quiet) {
      child.stdin?.end();
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // stdout 也要读掉：管道写满会让子进程卡死
    child.stdout?.on("data", () => undefined);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`语音合成超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`启动合成程序失败：${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // stderr 要留够长：合成引擎的报错往往在最后一行，截断就看不见真正原因了
      if (code === 0) resolve();
      else reject(new Error(`合成失败（退出码 ${code}）：${stderr.slice(-600)}`));
    });
  });
}
