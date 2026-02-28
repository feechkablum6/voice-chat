# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Веб-приложение голосового чата на WebRTC. Node.js + Express + ws (WebSocket) для signaling. Без фреймворков на фронтенде.

# Voice Chat

## Quick Start

```bash
# Установка зависимостей
npm install

# 1. Запустить сервер
node server.js &

# 2. Запустить HTTPS туннель (serveo)
ssh -tt -R 80:localhost:3000 serveo.net

# Ссылку из вывода (https://...serveousercontent.com) скинуть друзьям
```

## Notes

- Сервер слушает на `0.0.0.0:3000` (порт можно изменить через `PORT=...`)
- Для публичного доступа нужен HTTPS-туннель (WebRTC требует HTTPS для микрофона)
- Туннель: `serveo.net` через SSH — бесплатный, с HTTPS, работает в РФ
- Render.com в России заблокирован
- Cloudflare quick tunnels нестабильны (530/502 ошибки)
- bore.pub работает, но без HTTPS — микрофон не заработает у удалённых пользователей
- Код на GitHub: https://github.com/feechkablum6/voice-chat
