# 四六级单词 · 联机对战后端

FastAPI + WebSocket + 内存房间（无数据库）。题目答案只保存在服务端，绝不下发前端。

## 文件说明

| 文件 | 作用 |
|------|------|
| `main.py` | 后端全部代码（HTTP + WebSocket + 内存房间） |
| `requirements.txt` | 依赖（fastapi、uvicorn） |
| `railway.json` | Railway 部署配置（启动命令自动读 `$PORT`） |
| `words.json` | 四级题库（1260 词），由 `extract_words.py` 从 `../index.html` 生成 |
| `extract_words.py` | 题库生成脚本，改了前端 WORDS 后可重新运行 |

## 部署到 Railway

1. 把 `backend/` 目录作为仓库根推到 GitHub。
2. Railway → New Project → Deploy from GitHub，选该仓库。
3. Railway 的 Nixpacks 会自动识别 Python 并安装 `requirements.txt`；启动命令已在 `railway.json` 中配好（`uvicorn main:app --host 0.0.0.0 --port $PORT`），无需手动填写。
4. 部署完成后记下 Railway 分配的域名（形如 `https://xxx.up.railway.app`）。

**注意**：内存房间要求「单实例」运行。Railway 默认 1 个副本即可，不要横向扩容，否则两个玩家可能连到不同实例、找不到同一个房间。

## 前端如何指向这里

前端 `multiplayer.js` 默认按「同源」推导后端地址。若前端部署在别的域名（如 GitHub Pages），在加载 `multiplayer.js` **之前**加一行：

```html
<script>window.MP_BACKEND_URL = "https://你的域名.up.railway.app";</script>
<script src="multiplayer.js"></script>
```

`https` 会自动转成 `wss`；也可以分别指定 `window.MP_BACKEND_URL` 和 `window.MP_WS_URL`。

## CORS

默认只允许 `https://ycm-god.github.io`（`main.py` 顶部 `ALLOWED_ORIGINS`）。
本地联调如需放行其它来源，可设置环境变量 `CORS_ORIGINS`（逗号分隔多个来源），例如 Railway 的环境变量里填：
`https://ycm-god.github.io,http://localhost:5500`。

## 本地运行

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

验证：浏览器打开 `http://localhost:8000/health` 应返回 `{"status":"ok"}`，`/docs` 可交互调试接口。

## 接口契约（摘要）

- `POST /api/rooms` `{nickname}` → `{room_code, user_id}`（创建，房主）
- `POST /api/rooms/{code}/join` `{nickname}` → `{room_code, user_id}`（加入）
- `GET /api/rooms/{code}` → 房间快照
- `GET /api/rooms/{code}/question` → 当前题目（不含答案）
- `WS /ws`：客户端发 `join / start / next_question / submit / timeout / leave / ping`；
  服务端推 `room_state / question / answer_received / answer_result / score_update / player_joined / player_left / host_changed / game_finished / error / pong`。

`answer_index`（正确答案下标）只出现在 `answer_result` 里，`question` 与 `room_state.current_question` 均不含答案。
