/**
 * 语音合成命令行：给控制台调用。
 *
 * 为什么不在控制台进程里直接合成：
 * 实测在控制台的 HTTP 请求处理里调合成，两个引擎都会失败（空音频 / 拿不到音频），
 * 但同一个进程里由诊断接口直接调用、或者独立进程调用都正常。
 * 与其继续和这个环境问题纠缠，不如让每次合成都在一个干净的短命进程里跑完就退出。
 *
 * 用法：node tools/tts-cli.ts <presetJson> <textFile> <outDir>
 * 成功时 stdout 打印一行 JSON：{"file":"...","engine":"edge"}
 */

import { readFileSync } from "node:fs";
import { synthesize, type VoicePreset } from "../src/tts.ts";

const [, , presetPath, textPath, outDir] = process.argv;

if (!presetPath || !textPath || !outDir) {
  console.error("用法: node tools/tts-cli.ts <presetJson> <textFile> <outDir>");
  process.exit(2);
}

try {
  const preset = JSON.parse(readFileSync(presetPath, "utf8")) as VoicePreset;
  const text = readFileSync(textPath, "utf8");
  const result = await synthesize(text, preset, { outDir });
  process.stdout.write(`${JSON.stringify({ file: result.file, engine: result.engine })}\n`);
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
