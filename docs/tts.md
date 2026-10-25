# 语音（TTS）

目前**没有接任何付费语音 API**，接口先留好，随时填 Key 就能用。

## 四种引擎

| 引擎 | 需要什么 | 适合 |
|---|---|---|
| `edge` | 无（联网） | 默认。音色多，语气平 |
| `sapi` | Windows 自带语音 | 离线兜底 |
| `http` | 一个 HTTP 地址 | **接自己的语音服务 / 云 TTS** |
| `custom` | 一条命令 | 接本地模型（GPT-SoVITS 等） |

## `http` 引擎的两个约定

### simple（默认）—— 给自建服务

```
POST <url>
Content-Type: application/json

{"text":"主人你回来啦","emotion":"tender"}
```

返回音频字节即可。whale-voice 的 `tts_daemon.py` 就是这个格式。

### openai —— 给 OpenAI / Azure 兼容接口

```json
{
  "engine": "http",
  "format": "openai",
  "url": "https://api.openai.com/v1/audio/speech",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini-tts",
  "voice": "nova",
  "emotion": "用撒娇的语气，语速稍慢"
}
```

发出去的是：

```
POST <url>
Authorization: Bearer <apiKey>
{"model":"gpt-4o-mini-tts","voice":"nova","input":"主人你回来啦","instructions":"用撒娇的语气，语速稍慢"}
```

## 以后要接的云 TTS，怎么填

| 厂商 | 怎么接 |
|---|---|
| **OpenAI** | `format: openai`，url `https://api.openai.com/v1/audio/speech`，填 key 和 voice。**国内要代理** |
| **Azure 语音** | Azure 的 TTS 接口是另一套（`/cognitiveservices/v1`，SSML body）。需要中间加一层转换成 simple 约定 |
| **火山引擎** | 需要 AppID + AccessToken，签名较复杂。同样建议写一个几十行的代理服务，转成 simple 约定 |
| **其他 OpenAI 兼容** | `format: openai`，改 url 即可 |

> 结论：**最简单的接入方式是"写一个代理"**——把任何厂商的接口包成 `POST {text, emotion} → 音频`，
> 然后填进 `http` 引擎。这样控制台不用改，换厂商只换代理地址。

## 降级

任何引擎失败，都会依次尝试：

1. 同一音色重试一次
2. 另一类引擎兜底（http/sapi 失败 → 回 edge）
3. 全失败 → 回一句"语音合成失败了，等下再试"

**不会因为语音挂掉而让机器人整体不说话。**

## 本地情感语音（可选，要显卡）

[whale-voice](https://github.com/2177302423qqcom-byte/whale-voice)：

```bash
pip install -r requirements.txt
python scripts/tts_daemon.py --port 7864 --ref my_voice/ref.wav
```

然后控制台里那个预设 `鱼鱼 · 本地情感语音` 指向 `http://127.0.0.1:7864/tts`，daemon 起来就能用。

- 需要 8GB 显存（RTX 4060 级别）
- 首次加载约 250 秒，之后 2~5 秒/句
- 参考音 3~10 秒，必须单人、干净、无混响
- 输出 22050Hz

**不建议默认打包**：几 GB 体积 + 硬件分叉 + Python 环境，普通用户装不动。
控制台已经在启动时检测显卡（`nvidia-smi`），以后可以做"有显卡才显示可选安装"。
