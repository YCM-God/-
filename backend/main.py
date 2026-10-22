# -*- coding: utf-8 -*-
"""
四六级单词 · 联机对战后端
==========================
- HTTP  + WebSocket + 内存房间（无数据库，重启即清空）
- 严格按「联机对战」契约实现，题目答案只保存在服务端，绝不下发

部署到 Render：
  1. 仓库根目录的 render.yaml 指向本目录（backend），推到 GitHub 后连接 Render
  2. Render 自动装 requirements.txt，启动命令读 Render 注入的 $PORT

注意：内存房间要求「单实例」运行；Render 免费档默认 1 个实例即可，不要横向扩容。
"""
import asyncio
import json
import os
import random
import time
import uuid

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="CET Word Battle Backend")

# ---------------- 配置 ----------------
# CORS：默认只允许前端站点（github.io）。本地联调可设置 CORS_ORIGINS 追加来源。
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "https://ycm-god.github.io").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

TOTAL_QUESTIONS = 10          # 每局题数
TIME_LIMIT = 30               # 每题作答秒数
POINTS = 10                   # 答对得分
MAX_PLAYERS = 2               # 一局人数（1v1）
ROOM_TTL = 3600               # 房间空闲过期时间（秒）

ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 去掉 0/O、1/I 避免混淆

# 内存房间表：code -> room
ROOMS = {}

# 题库：优先读取 words.json，缺失则用内置兜底
WORD_LIST = []


def load_words():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "words.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        words = [w for w in data if w.get("word") and w.get("meaning")]
        if words:
            return words
    except Exception:
        pass
    return [
        {"word": "abandon", "meaning": "v. 放弃；抛弃"},
        {"word": "ability", "meaning": "n. 能力；才能"},
        {"word": "absorb", "meaning": "v. 吸收；吸引"},
        {"word": "achieve", "meaning": "v. 达到；实现"},
        {"word": "ancient", "meaning": "adj. 古代的；古老的"},
    ]


WORD_LIST = load_words()


# ---------------- 工具函数 ----------------
def new_id():
    return uuid.uuid4().hex[:12]


def new_room_code():
    while True:
        code = "".join(random.choice(ROOM_CODE_CHARS) for _ in range(6))
        if code not in ROOMS:
            return code


def new_room(code, host_id):
    return {
        "code": code,
        "host_id": host_id,
        "status": "waiting",           # waiting / playing / awaiting_next / finished
        "players": {},                 # uid -> {user_id,nickname,score,ws,connected}
        "question_index": 0,
        "total_questions": TOTAL_QUESTIONS,
        "questions": [],               # [{id,word,options,answer_index}]
        "current_answers": {},         # uid -> choice
        "current_qid": None,
        "last_results": None,
        "time_limit": TIME_LIMIT,
        "last_activity": time.time(),
    }


def new_player(uid, nickname):
    return {
        "user_id": uid,
        "nickname": nickname,
        "score": 0,
        "ws": None,
        "connected": False,
    }


def get_room(code):
    room = ROOMS.get(code)
    if not room:
        return None
    if time.time() - room["last_activity"] > ROOM_TTL:
        ROOMS.pop(code, None)
        return None
    return room


def generate_questions(room):
    total = room["total_questions"]
    pool = [w for w in WORD_LIST]
    random.shuffle(pool)
    picked = pool[: min(total, len(pool))]

    meaning_pool = list({w["meaning"] for w in WORD_LIST})

    questions = []
    for i, w in enumerate(picked):
        correct = w["meaning"]
        distractors = []
        candidates = [m for m in meaning_pool if m != correct]
        random.shuffle(candidates)
        for m in candidates:
            if len(distractors) >= 3:
                break
            if m not in distractors:
                distractors.append(m)
        # 干扰项不足时兜底填充
        while len(distractors) < 3:
            distractors.append("——")
        options = [correct] + distractors
        random.shuffle(options)
        questions.append({
            "id": i + 1,
            "word": w["word"],
            "options": options,
            "answer_index": options.index(correct),
        })
    return questions


def build_question(room, index):
    q = room["questions"][index]
    return {
        "id": q["id"],
        "speak_text": q["word"],
        "options": q["options"],            # 不含答案
        "index": index,
        "total": room["total_questions"],
        "time_limit": room["time_limit"],
    }


def build_room_state(room):
    players = [
        {
            "user_id": uid,
            "nickname": p["nickname"],
            "score": p["score"],
            "is_host": uid == room["host_id"],
            "connected": p.get("connected", False),
        }
        for uid, p in room["players"].items()
    ]
    current_question = None
    if (
        room["status"] in ("playing", "awaiting_next")
        and room["questions"]
        and room["question_index"] < room["total_questions"]
    ):
        current_question = build_question(room, room["question_index"])

    ranking = sorted(players, key=lambda p: -p["score"])

    return {
        "type": "room_state",
        "room_code": room["code"],
        "host_id": room["host_id"],
        "status": room["status"],
        "players": players,
        "question_index": room["question_index"],
        "total_questions": room["total_questions"],
        "current_question": current_question,
        "scores": {uid: p["score"] for uid, p in room["players"].items()},
        "submitted": list(room["current_answers"].keys()) if room["status"] == "playing" else [],
        "last_results": room.get("last_results"),
        "ranking": [
            {"user_id": p["user_id"], "nickname": p["nickname"], "score": p["score"]}
            for p in ranking
        ],
    }


def error(code, message):
    return {"type": "error", "code": code, "message": message}


async def send(ws, message):
    await ws.send_text(json.dumps(message, ensure_ascii=False))


async def broadcast(room, message):
    for p in list(room["players"].values()):
        if p.get("ws"):
            try:
                await p["ws"].send_text(json.dumps(message, ensure_ascii=False))
            except Exception:
                p["ws"] = None
                p["connected"] = False


# ---------------- 游戏逻辑 ----------------
async def resolve_question(room):
    """所有玩家已作答（或超时）时判定本题。"""
    if room["status"] != "playing":
        return
    q = room["questions"][room["question_index"]]

    per_user = {}
    for uid in room["players"]:
        choice = room["current_answers"].get(uid)
        correct = choice == q["answer_index"]
        points = POINTS if correct else 0
        per_user[uid] = (correct, points)

    for uid, (correct, points) in per_user.items():
        room["players"][uid]["score"] += points

    scores = {uid: p["score"] for uid, p in room["players"].items()}
    room["last_results"] = [
        {"user_id": uid, "correct": correct, "answer_index": q["answer_index"], "points": points}
        for uid, (correct, points) in per_user.items()
    ]
    room["status"] = "awaiting_next"

    for uid, (correct, points) in per_user.items():
        await broadcast(room, {
            "type": "answer_result",
            "user_id": uid,
            "question_id": q["id"],
            "correct": correct,
            "answer_index": q["answer_index"],
            "points": points,
            "scores": scores,
        })
    await broadcast(room, {"type": "score_update", "scores": scores})
    await broadcast(room, build_room_state(room))


async def schedule_resolve(room, qid):
    """超时兜底：到点仍未答完则自动判定。"""
    await asyncio.sleep(room["time_limit"])
    if room["status"] == "playing" and room.get("current_qid") == qid:
        await resolve_question(room)


async def remove_player(room, uid):
    if uid not in room["players"]:
        return
    was_host = uid == room["host_id"]
    del room["players"][uid]

    if not room["players"]:
        ROOMS.pop(room["code"], None)
        return

    if was_host:
        new_host = next(iter(room["players"]))
        room["host_id"] = new_host
        await broadcast(room, {"type": "host_changed", "host_id": new_host})

    await broadcast(room, {"type": "player_left", "user_id": uid})
    await broadcast(room, build_room_state(room))


# ---------------- HTTP 接口 ----------------
@app.get("/")
def root():
    return {"ok": True, "service": "cet-word-battle"}


@app.get("/health")
def health():
    return {"status": "ok", "rooms": len(ROOMS)}


@app.post("/api/rooms")
async def create_room(body: dict):
    nickname = (body.get("nickname") or "玩家").strip()[:12] or "玩家"
    code = new_room_code()
    host_id = new_id()
    room = new_room(code, host_id)
    room["players"][host_id] = new_player(host_id, nickname)
    ROOMS[code] = room
    return {"room_code": code, "user_id": host_id}


@app.post("/api/rooms/{code}/join")
async def join_room(code: str, body: dict):
    code = code.upper().strip()
    room = get_room(code)
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在或已过期，请重新创建房间")
    if len(room["players"]) >= MAX_PLAYERS:
        raise HTTPException(status_code=409, detail="房间已满（最多 2 人）")
    nickname = (body.get("nickname") or "玩家").strip()[:12] or "玩家"
    uid = new_id()
    room["players"][uid] = new_player(uid, nickname)
    room["last_activity"] = time.time()
    return {"room_code": code, "user_id": uid}


@app.get("/api/rooms/{code}")
async def get_room_info(code: str):
    room = get_room(code.upper().strip())
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    return build_room_state(room)


@app.get("/api/rooms/{code}/question")
async def get_room_question(code: str):
    room = get_room(code.upper().strip())
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["status"] not in ("playing", "awaiting_next"):
        raise HTTPException(status_code=409, detail="游戏尚未开始")
    return {"type": "question", **build_question(room, room["question_index"])}


# ---------------- WebSocket ----------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ctx = None  # {"room", "user_id", "ws"}

    async def handle_join(msg):
        code = (msg.get("room_code") or "").upper().strip()
        uid = (msg.get("user_id") or "").strip()
        nickname = (msg.get("nickname") or "玩家").strip()[:12] or "玩家"
        room = get_room(code)
        if not room:
            await send(ws, error("ROOM_NOT_FOUND", "房间不存在，请重新创建房间"))
            return None
        if uid not in room["players"]:
            await send(ws, error("USER_NOT_FOUND", "未找到该玩家，请重新加入房间"))
            return None
        p = room["players"][uid]
        p["ws"] = ws
        p["connected"] = True
        p["nickname"] = nickname
        room["last_activity"] = time.time()
        await broadcast(room, build_room_state(room))
        # 游戏中重连：把当前题单独补发给重连者
        if room["status"] == "playing" and room["questions"]:
            await send(ws, {"type": "question", **build_question(room, room["question_index"])})
        return {"room": room, "user_id": uid, "ws": ws}

    async def handle_start(msg):
        room = ctx["room"]
        if room["host_id"] != ctx["user_id"]:
            await send(ws, error("NOT_HOST", "只有房主可以开始游戏"))
            return
        if room["status"] not in ("waiting", "finished"):
            return
        if len(room["players"]) < 1:
            return
        for p in room["players"].values():
            p["score"] = 0
        room["question_index"] = 0
        room["questions"] = generate_questions(room)
        room["current_answers"] = {}
        room["last_results"] = None
        room["status"] = "playing"
        room["current_qid"] = room["questions"][0]["id"]
        room["last_activity"] = time.time()
        await broadcast(room, build_room_state(room))
        await broadcast(room, {"type": "question", **build_question(room, 0)})
        asyncio.create_task(schedule_resolve(room, room["current_qid"]))

    async def handle_next(msg):
        room = ctx["room"]
        if room["host_id"] != ctx["user_id"]:
            await send(ws, error("NOT_HOST", "只有房主可以切题"))
            return
        if room["status"] != "awaiting_next":
            return
        room["question_index"] += 1
        room["last_activity"] = time.time()
        if room["question_index"] >= room["total_questions"]:
            room["status"] = "finished"
            ranking = sorted(room["players"].values(), key=lambda p: -p["score"])
            scores = {uid: p["score"] for uid, p in room["players"].items()}
            await broadcast(room, {
                "type": "game_finished",
                "scores": scores,
                "ranking": [
                    {"user_id": p["user_id"], "nickname": p["nickname"], "score": p["score"]}
                    for p in ranking
                ],
            })
            await broadcast(room, build_room_state(room))
        else:
            room["current_answers"] = {}
            room["last_results"] = None
            room["status"] = "playing"
            room["current_qid"] = room["questions"][room["question_index"]]["id"]
            await broadcast(room, build_room_state(room))
            await broadcast(room, {"type": "question", **build_question(room, room["question_index"])})
            asyncio.create_task(schedule_resolve(room, room["current_qid"]))

    async def record_answer(msg, choice):
        room = ctx["room"]
        uid = ctx["user_id"]
        if room["status"] != "playing":
            return
        qid = msg.get("question_id")
        if qid != room.get("current_qid"):
            return
        if uid in room["current_answers"]:
            return
        room["current_answers"][uid] = choice
        room["last_activity"] = time.time()
        await broadcast(room, {
            "type": "answer_received",
            "user_id": uid,
            "nickname": room["players"][uid]["nickname"],
            "question_id": qid,
        })
        if all(u in room["current_answers"] for u in room["players"]):
            await resolve_question(room)
        else:
            await broadcast(room, build_room_state(room))

    async def handle_submit(msg):
        choice = msg.get("choice")
        if not isinstance(choice, int):
            return
        await record_answer(msg, choice)

    async def handle_timeout(msg):
        await record_answer(msg, -1)

    async def handle_leave(msg):
        room = ctx["room"]
        uid = ctx["user_id"]
        room["players"][uid]["ws"] = None  # 解除绑定，避免 remove 后再被广播
        await remove_player(room, uid)
        ctx["left"] = True

    async def handle_disconnect():
        room = ctx["room"]
        uid = ctx["user_id"]
        p = room["players"].get(uid)
        # 只有当前仍绑定这个 ws 时才标记离线（避免旧连接断开影响新连接）
        if p and p.get("ws") is ws:
            p["ws"] = None
            p["connected"] = False
            room["last_activity"] = time.time()
            await broadcast(room, build_room_state(room))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype = msg.get("type")

            if mtype == "join":
                ctx = await handle_join(msg)
            elif mtype == "ping":
                await send(ws, {"type": "pong"})
            elif ctx is None:
                await send(ws, error("NOT_JOINED", "请先发送 join 加入房间"))
            elif mtype == "start":
                await handle_start(msg)
            elif mtype == "next_question":
                await handle_next(msg)
            elif mtype == "submit":
                await handle_submit(msg)
            elif mtype == "timeout":
                await handle_timeout(msg)
            elif mtype == "leave":
                await handle_leave(msg)
            else:
                await send(ws, error("UNKNOWN", "未知消息类型"))
    except WebSocketDisconnect:
        if ctx and not ctx.get("left"):
            await handle_disconnect()
    except Exception:
        if ctx and not ctx.get("left"):
            await handle_disconnect()


# ---------------- 本地运行入口 ----------------
if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
