# 四六级英语学习网站（单词测验 + 联机对战）

一个单页英语学习网站：内置四六级词汇测验、打卡、联机对战（1v1 单词 PK）等功能。

- `index.html` —— 网站全部界面与数据（图片、题库均已内嵌，无外部依赖）
- `multiplayer.js` —— 联机对战前端逻辑
- `backend/` —— 联机对战后端（FastAPI + WebSocket），同时托管前端静态页

> **前后端同源部署**：整个网站（含单机测验 + 联机对战）都由后端一起托管，
> 前端无需配置任何后端网址（`MP_BACKEND_URL` 留空即可）。

---

## 一、部署到 Replit（一步到位）

后端会同时托管前端页面，前后端同一个域名，**不用再改任何网址**。

1. 把本仓库推到 GitHub。
2. 打开 [replit.com](https://replit.com) → 登录 → **Create Repl → Import from GitHub**，选择本仓库。
3. Replit 会读取根目录的 `.replit`，自动切到 `backend/`、安装依赖并启动，无需手动填写。
4. 点顶部 **Run** 启动（首次会自动装依赖，稍等片刻）。
5. 启动后，Replit 会分配一个域名，形如 `https://你的Repl名.你的用户名.repl.co`。
   浏览器打开这个网址，就是完整网站，单机和联机都能用。

> ⚠️ 后端用「内存房间」，要求单实例运行，保持一个 Repl 即可，不要开多个，否则两个玩家可能连到不同实例。
> ⚠️ Replit 免费档 Repl 空闲约 30 分钟会休眠，且「Always On（常驻）」是付费功能；休眠后第一次访问会冷启动，属正常现象。

**更新代码**：改完代码推到 GitHub 后，在 Replit 里同步/拉取最新代码，再点 Run 重启即可。

---

## 二、本地运行

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://localhost:8000/` 就是完整网站（含联机）；`http://localhost:8000/health` 应返回 `{"status":"ok"}`。

---

## 三、GitHub Pages（可选，仅单机）

本仓库也配置了 GitHub Pages 自动部署（每次 push 到 `main` 会自动重新部署）。但 **GitHub Pages 上只有单机功能**，联机对战需要后端，请使用上面的 Replit 部署。

- 首次启用：仓库 → **Settings → Pages**，把 **Source** 改成 **GitHub Actions**。
- 地址：`https://你的用户名.github.io/仓库名/`。

---

## 目录说明

| 路径 | 说明 |
|------|------|
| `index.html` | 网站（自包含） |
| `multiplayer.js` | 联机对战前端 |
| `backend/` | 联机对战后端（部署到 Replit，同时托管前端） |
| `.github/workflows/deploy.yml` | GitHub Pages 自动部署工作流（仅单机） |
| `README-data.md` | 真题数据转换说明（历史资料，与网站运行无关） |

源数据（PDF、图片、`data/`、`pdf-text/` 等）体积较大，已通过 `.gitignore` 排除，不会上传到 GitHub。
