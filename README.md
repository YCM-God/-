# 四六级英语学习网站（单词测验 + 联机对战）

一个单页英语学习网站：内置四六级词汇测验、打卡、联机对战（1v1 单词 PK）等功能。

- `index.html` —— 网站全部界面与数据（图片、题库均已内嵌，无外部依赖）
- `multiplayer.js` —— 联机对战前端逻辑（依赖一个后端服务器）
- `backend/` —— 联机对战的后端（FastAPI + WebSocket），需部署到 Render

> 单机测验无需后端即可使用；只有「联机对战」需要后端。

---

## 一、部署前端到 GitHub Pages（自动）

本仓库已配置 GitHub Actions，**每次 push 到 `main` 分支，网站会自动重新部署**，无需手动操作。

首次启用只需两步：

1. 在 GitHub 上创建本仓库（仓库名随意，例如 `cet-quiz`）。
2. 仓库 → **Settings → Pages**，把 **Source** 改成 **GitHub Actions**（Build and deployment）。

推代码后，网站地址会是 `https://你的用户名.github.io/仓库名/`。

本地预览：直接用浏览器打开 `index.html` 即可（单机功能可完整体验）。

---

## 二、部署后端到 Render（联机对战用）

后端代码在 `backend/` 目录，已配好可直接部署（仓库根目录的 `render.yaml` 是 Render 的蓝图配置）。

1. 把本仓库推到 GitHub（同上）。
2. 打开 [render.com](https://render.com) → 登录 → **New + → Blueprint**，连接 GitHub 并选择本仓库。Render 会读取根目录的 `render.yaml`，自动识别 `backend/` 为根目录、Python 环境和启动命令，无需手动填写。
3. （如不用 Blueprint，而是手动 **New + → Web Service** 建服务，则需把 **Root Directory** 设为 `backend`、Start Command 设为 `uvicorn main:app --host 0.0.0.0 --port $PORT`。）
4. 等待构建完成（状态变绿）。
5. 部署完成后，记下 Render 分配的域名，形如 `https://xxx.onrender.com`。

> ⚠️ 后端用「内存房间」，要求单实例运行。Render 免费档默认 1 个实例即可，**不要横向扩容**，否则两个玩家可能连到不同实例。
> ⚠️ Render 免费档空闲约 15 分钟会休眠，下次访问需冷启动约 30–60 秒，属正常现象。

本地运行后端：

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://localhost:8000/health` 应返回 `{"status":"ok"}`。

---

## 三、把前后端接起来

打开 `index.html`，找到末尾这段（我已放好占位）：

```html
<script>
  window.MP_BACKEND_URL = "";   // 改成你的 Render 域名
</script>
<script src="multiplayer.js"></script>
```

把 `""` 换成你的 Render 域名，例如：

```html
window.MP_BACKEND_URL = "https://xxx.onrender.com";
```

保存后 push，联机对战就能连上后端了（`https` 会自动转成 `wss`）。

---

## 四、CORS 白名单

后端 `backend/main.py` 顶部默认只允许 `https://ycm-god.github.io` 访问。

如果你的 GitHub Pages 域名不是这个，请在 Render 服务里添加环境变量：

- 名称：`CORS_ORIGINS`
- 值：`https://你的用户名.github.io`（多个来源用英文逗号分隔）

---

## 目录说明

| 路径 | 说明 |
|------|------|
| `index.html` | 网站（自包含） |
| `multiplayer.js` | 联机对战前端 |
| `backend/` | 联机对战后端（部署到 Render） |
| `.github/workflows/deploy.yml` | GitHub Pages 自动部署工作流 |
| `README-data.md` | 真题数据转换说明（历史资料，与网站运行无关） |

源数据（PDF、图片、`data/`、`pdf-text/` 等）体积较大，已通过 `.gitignore` 排除，不会上传到 GitHub。
