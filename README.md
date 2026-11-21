# DeepChat

English | [简体中文](README.zh-CN.md)

An open-source (MIT) multi-model AI chat client extended from DeepSeek's static web chat project. Runs purely client-side with support for DeepSeek, OpenAI-compatible endpoints (`/chat/completions` & `/responses`), local deployments (Ollama / LM Studio / vLLM / LocalAI), and Android packaging via Capacitor.

Download pre-built Android APKs from the [upstream releases](https://github.com/YanJiuWeiYuanHui/DeepChat/releases).

## Features

- **Multi-Protocol & Local Deployment**: DeepSeek native API, OpenAI Chat Completions, OpenAI Responses API, and keyless local server presets (Ollama, LM Studio, vLLM, LocalAI) with automatic model discovery.
- **Independent Multi-Modal Channels**: Separate provider endpoints/keys/models for ASR, TTS, Vision, OCR, and Image Generation (text-to-image & image-to-image with aspect-ratio matching and optional pre-generation confirmation).
- **Voice Call & Camera Switching**: Continuous voice call overlay with live camera preview and mobile front/back camera switch, plus a header speaker toggle for automatic voice readout of replies.
- **Long-Term Memory & Policies**: Auto-extracted and editable long-term saved memories, configurable cross-chat memory recall, assistant reply branching edits, and custom keyword refusal rules.
- **Token Usage & Daily Threshold Alerts**: Displays per-turn token usage beneath assistant replies and tracks daily cumulative usage with a customizable threshold alert modal.
- **Chat History Backup**: Full ZIP import/export compatible with DeepSeek `export_format_version: 3` archives.

## Development & Hosting

Requires Node.js 22+ and pnpm:

```sh
git clone https://github.com/YanJiuWeiYuanHui/DeepChat.git
cd DeepChat
pnpm install
pnpm dev
```

Open http://localhost:8090 .

Build static assets and serve locally with built-in `/__api_proxy__` CORS/proxy forwarding:

```sh
pnpm build
pnpm preview
```

## Android APK & Automated Releases

For a local release build, set `DEEPCHAT_KEYSTORE_FILE`, `DEEPCHAT_KEYSTORE_PASS`,
`DEEPCHAT_KEY_ALIAS` and `DEEPCHAT_KEY_PASS` for your signing keystore, then run:

```sh
pnpm run android:sync
cd android && ./gradlew assembleRelease
```

To enable automated signed APK releases via GitHub Actions on `v*` tags, configure the following repository Secrets under `Settings → Secrets and variables → Actions`:

- `SIGNING_KEYSTORE_BASE64`: Base64-encoded Android signing keystore (keep using your original keystore so existing users can update in-place without losing local chats)
- `SIGNING_KEYSTORE_PASS` (optional, defaults to `android`)
- `SIGNING_KEY_ALIAS` (optional, defaults to `androiddebugkey`)
- `SIGNING_KEY_PASS` (optional, defaults to `android`)

## License

[MIT License](LICENSE)
