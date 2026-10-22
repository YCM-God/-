/* =====================================================================
 * 联机对战（单词测验）
 * ---------------------------------------------------------------------
 * 纯原生 JS，IIFE 隔离，暴露 window.Multiplayer.open()。
 * 依赖 index.html 已存在的全局：speak()、CSS 变量（--card-bg/--text 等）。
 *
 * 部署后端后，把下面两个常量改成你的 Replit 域名即可；
 * 留空则按「同源」自动推导，且 https 会自动转成 wss。
 * 也可在加载本文件前设置 window.MP_BACKEND_URL / window.MP_WS_URL 覆盖。
 * ===================================================================== */
(function () {
  "use strict";

  /* ------------------ 配置（顶部，便于修改） ------------------ */
  var BACKEND_URL = window.MP_BACKEND_URL || "";      // 留空 = 与页面同源
  var WS_URL = window.MP_WS_URL || (BACKEND_URL
    ? BACKEND_URL.replace(/^http/, "ws")               // http->ws, https->wss
    : (location.protocol === "https:" ? "wss://" : "ws://") + location.host);

  var HEARTBEAT_INTERVAL = 20000;    // 心跳间隔 ms
  var HEARTBEAT_TIMEOUT = 45000;     // 超过该时长未收到 pong 视为断线
  var RECONNECT_BASE = 1000;         // 重连初始间隔 ms
  var RECONNECT_MAX = 15000;         // 重连最大间隔 ms

  var SESSION_KEY = "cet_word_battle_session";  // 会话（房间+身份），刷新后恢复
  var NICK_KEY = "cet_word_battle_nickname";    // 昵称记忆

  /* ------------------ 内部状态 ------------------ */
  var mpMode = "solo";         // solo | multi
  var session = null;          // { roomCode, userId, nickname }
  var ws = null;
  var roomState = null;        // 最近一次 room_state
  var currentQuestionId = null;
  var currentQuestion = null;
  var myChoice = null;         // 本题我选的选项下标
  var answered = false;        // 本题我是否已提交
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var heartbeatTimer = null;
  var lastPong = 0;
  var timerInterval = null;
  var timerDeadline = 0;
  var intentionalClose = false;  // 主动离开，不再重连
  var inited = false;

  /* ------------------ 工具 ------------------ */
  function $(id) { return document.getElementById(id); }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
  function clampNick(n) { return (n || "").trim().slice(0, 12); }

  /* ------------------ 注入 UI ------------------ */
  function injectStyle() {
    var css = [
      ".mp-roomcode{font-size:30px;font-weight:800;letter-spacing:5px;color:var(--primary);text-align:center;padding:4px 0;}",
      ".mp-conn{text-align:center;font-size:12px;color:var(--text-sub);margin:2px 0 10px;min-height:16px;}",
      ".mp-conn.off{color:var(--danger);}",
      ".mp-input{width:100%;padding:12px 14px;border:2px solid var(--border);border-radius:12px;background:var(--card-bg);color:var(--text);font-size:15px;outline:none;transition:border-color .2s;}",
      ".mp-input:focus{border-color:var(--primary);}",
      ".mp-row{display:flex;gap:8px;}",
      ".mp-row .mp-input{flex:1;}",
      ".mp-btn-secondary{background:var(--text-sub);}",
      ".mp-btn-danger{background:var(--danger);}",
      ".mp-btn-block{width:100%;margin-top:10px;}",
      ".mp-hint{text-align:center;font-size:13px;color:var(--text-sub);margin:10px 0;}",
      ".mp-players{margin-bottom:12px;}",
      ".mp-player{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:var(--chip-bg);}",
      ".mp-player .mp-avatar{font-size:20px;}",
      ".mp-player .mp-name{flex:1;font-weight:700;color:var(--text);}",
      ".mp-player .mp-host{font-size:11px;color:var(--success);margin-left:4px;font-weight:700;}",
      ".mp-player .mp-pstatus{font-size:12px;color:var(--text-sub);}",
      ".mp-player .mp-pscore{font-size:20px;font-weight:800;color:var(--primary);}",
      ".mp-scoreboard{display:flex;gap:10px;margin-bottom:12px;}",
      ".mp-scoreboard .mp-player{flex:1;margin-bottom:0;flex-direction:column;align-items:center;text-align:center;padding:12px 8px;}",
      ".mp-scoreboard .mp-name{font-size:14px;}",
      ".mp-speak{font-size:32px;font-weight:800;text-align:center;margin:6px 0 2px;color:var(--text);word-break:break-word;}",
      ".mp-speak-btn{display:block;margin:6px auto 14px;width:56px;height:56px;border-radius:50%;border:1px solid var(--border);background:var(--chip-bg);color:var(--primary);font-size:26px;cursor:pointer;transition:transform .12s;}",
      ".mp-speak-btn:active{transform:scale(.9);}",
      ".mp-timer{text-align:center;font-size:14px;color:var(--text-sub);margin-bottom:10px;font-weight:600;}",
      ".mp-timer.low{color:var(--danger);}",
      ".mp-submit-status{text-align:center;font-size:13px;color:var(--text-sub);margin-bottom:8px;min-height:18px;}",
      ".mp-rank-item{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;margin-bottom:10px;background:var(--chip-bg);}",
      ".mp-rank-item .mp-medal{font-size:24px;}",
      ".mp-rank-item .mp-rname{flex:1;font-weight:700;color:var(--text);}",
      ".mp-rank-item .mp-rscore{font-size:20px;font-weight:800;color:var(--primary);}",
      ".mp-rank-item.me{border-color:var(--primary);}",
      ".mp-opt:disabled{opacity:.9;cursor:default;}",
      ".mp-opt.dim{opacity:.45;}",
    ].join("\n");
    var st = document.createElement("style");
    st.setAttribute("data-mp", "1");
    st.textContent = css;
    document.head.appendChild(st);
  }

  function panelHtml() {
    return '' +
      '<div class="quiz-setup" id="mp-panel" style="display:none">' +
      '  <h3>⚔️ 联机对战</h3>' +
      '  <div class="mp-conn" id="mp-conn"></div>' +
      // 设置
      '  <div id="mp-view-setup">' +
      '    <div class="quiz-field"><label>昵称</label>' +
      '      <input class="mp-input" id="mp-nickname" placeholder="输入昵称…" maxlength="12" autocomplete="off">' +
      '    </div>' +
      '    <div class="quiz-field"><label>创建房间</label>' +
      '      <button class="btn start" id="mp-create">🆕 创建房间</button>' +
      '    </div>' +
      '    <div class="quiz-field"><label>加入房间</label>' +
      '      <div class="mp-row">' +
      '        <input class="mp-input" id="mp-join-code" placeholder="输入 6 位房间号" maxlength="6" autocomplete="off" style="text-transform:uppercase">' +
      '        <button class="btn mp-btn-secondary" id="mp-join" style="width:auto">加入</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="quiz-feedback" id="mp-setup-msg"></div>' +
      '  </div>' +
      // 等待 / 大厅
      '  <div id="mp-view-lobby" style="display:none">' +
      '    <div class="quiz-field"><label>房间号（告诉朋友）</label>' +
      '      <div class="mp-roomcode" id="mp-room-code"></div>' +
      '    </div>' +
      '    <div class="mp-players" id="mp-players"></div>' +
      '    <div class="mp-hint" id="mp-lobby-msg"></div>' +
      '    <button class="btn start" id="mp-start" style="display:none">🚀 开始对战</button>' +
      '    <button class="btn mp-btn-secondary mp-btn-block" id="mp-leave">🚪 退出房间</button>' +
      '  </div>' +
      // 对战中
      '  <div id="mp-view-play" style="display:none">' +
      '    <div class="mp-scoreboard" id="mp-hud"></div>' +
      '    <div class="quiz-qtype" id="mp-progress"></div>' +
      '    <div class="mp-speak" id="mp-speak"></div>' +
      '    <button class="mp-speak-btn" id="mp-speak-btn" title="播放发音">🔊</button>' +
      '    <div class="quiz-options mp-options" id="mp-options"></div>' +
      '    <div class="mp-timer" id="mp-timer"></div>' +
      '    <div class="mp-submit-status" id="mp-submit-status"></div>' +
      '    <div class="quiz-feedback" id="mp-feedback"></div>' +
      '    <div id="mp-next-wrap" style="display:none">' +
      '      <button class="btn start" id="mp-next">下一题 ➡️</button>' +
      '      <div class="mp-hint" id="mp-next-hint"></div>' +
      '    </div>' +
      '  </div>' +
      // 结算
      '  <div id="mp-view-finished" style="display:none">' +
      '    <h3>🏆 对战结果</h3>' +
      '    <div class="mp-rank" id="mp-ranking"></div>' +
      '    <button class="btn start" id="mp-again" style="display:none">🔁 再来一局</button>' +
      '    <div class="mp-hint" id="mp-finished-hint"></div>' +
      '    <button class="btn mp-btn-secondary mp-btn-block" id="mp-exit">🚪 退出房间</button>' +
      '  </div>' +
      '</div>';
  }

  function injectUI() {
    var quizMode = $("quiz-mode");
    var quizSetup = $("quiz-setup");
    if (!quizMode || !quizSetup) return false;

    injectStyle();

    // 1) 在 #quiz-setup 顶部注入「单机测验 / 联机对战」切换
    var seg = document.createElement("div");
    seg.className = "quiz-field";
    seg.id = "mp-mode-field";
    seg.innerHTML = '<label>模式</label><div class="quiz-seg">' +
      '<button data-m="solo" class="active">单机测验</button>' +
      '<button data-m="multi">联机对战</button></div>';
    var h3 = quizSetup.querySelector("h3");
    quizSetup.insertBefore(seg, h3 ? h3.nextSibling : quizSetup.firstChild);

    // 2) 注入联机面板（放在 #quiz-setup 之后）
    var wrap = document.createElement("div");
    wrap.innerHTML = panelHtml();
    var panel = wrap.firstChild;
    quizMode.insertBefore(panel, quizSetup.nextSibling);

    // 切换事件
    seg.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        setMpMode(b.dataset.m);
      });
    });

    wirePanelEvents();
    return true;
  }

  function setMpMode(m) {
    mpMode = m === "multi" ? "multi" : "solo";
    var multi = mpMode === "multi";
    // 切换按钮高亮
    var seg = $("mp-mode-field");
    if (seg) seg.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.m === mpMode);
    });
    // 隐藏/显示单机字段与标题
    ["quiz-count", "quiz-type"].forEach(function (id) {
      var el = $(id);
      var field = el && el.closest(".quiz-field");
      if (field) field.style.display = multi ? "none" : "";
    });
    var startBtn = $("quiz-start");
    if (startBtn) startBtn.style.display = multi ? "none" : "";
    var h3 = $("quiz-setup") && $("quiz-setup").querySelector("h3");
    if (h3) h3.style.display = multi ? "none" : "";
    // 联机面板
    var panel = $("mp-panel");
    if (panel) panel.style.display = multi ? "block" : "none";

    if (multi) {
      ensureConnected();
      renderAll();
    }
  }

  /* ------------------ 视图切换 ------------------ */
  function showView(name) {
    ["setup", "lobby", "play", "finished"].forEach(function (v) {
      var el = $("mp-view-" + v);
      if (el) el.style.display = v === name ? "block" : "none";
    });
  }

  function renderAll() {
    if (!session) {
      showView("setup");
      updateConnStatus(null);
      return;
    }
    var st = roomState;
    if (!st) {
      showView("lobby");
      updateConnStatus("connecting");
      return;
    }
    if (st.status === "waiting") {
      showView("lobby");
      renderLobby(st);
    } else if (st.status === "finished") {
      showView("finished");
      renderFinished(st);
    } else {
      showView("play");
      renderPlay(st);
    }
  }

  /* ------------------ 连接状态条 ------------------ */
  function updateConnStatus(state) {
    var el = $("mp-conn");
    if (!el) return;
    var map = {
      connecting: "🟡 连接中…",
      online: "🟢 已连接",
      offline: "🔴 连接断开，正在重连…",
    };
    if (state === "offline") {
      el.textContent = "🔴 连接断开，重连中（第 " + reconnectAttempt + " 次）…";
      el.className = "mp-conn off";
    } else {
      el.textContent = map[state] || "";
      el.className = "mp-conn";
    }
  }

  /* ------------------ 大厅渲染 ------------------ */
  function renderLobby(st) {
    setText("mp-room-code", st.room_code);
    renderPlayers(st.players, "mp-players", true);
    var myUid = session.userId;
    var me = st.players.find(function (p) { return p.user_id === myUid; });
    var isHost = me && me.is_host;
    var startBtn = $("mp-start");
    var msg = $("mp-lobby-msg");
    if (isHost) {
      startBtn.style.display = "block";
      startBtn.textContent = st.players.length >= 2 ? "🚀 开始对战" : "🚀 开始对战（可先等待对手）";
      msg.textContent = st.players.length >= 2 ? "双方已就位，可以开始！" : "等待对手加入…（把房间号发给朋友）";
    } else {
      startBtn.style.display = "none";
      msg.textContent = "等待房主开始…";
    }
  }

  function renderPlayers(players, containerId, showStatus) {
    var box = $(containerId);
    if (!box) return;
    var myUid = session ? session.userId : null;
    box.innerHTML = "";
    players.forEach(function (p) {
      var div = document.createElement("div");
      div.className = "mp-player";
      var name = document.createElement("div");
      name.className = "mp-name";
      name.textContent = p.nickname + (p.user_id === myUid ? "（我）" : "");
      if (p.is_host) {
        var host = document.createElement("span");
        host.className = "mp-host";
        host.textContent = "房主";
        name.appendChild(host);
      }
      var status = document.createElement("div");
      status.className = "mp-pstatus";
      if (showStatus) status.textContent = p.connected ? "在线" : "已离开";
      var score = document.createElement("div");
      score.className = "mp-pscore";
      score.textContent = p.score;
      div.appendChild(name);
      div.appendChild(status);
      div.appendChild(score);
      box.appendChild(div);
    });
  }

  /* ------------------ 对战渲染 ------------------ */
  function renderPlay(st) {
    renderPlayers(st.players, "mp-hud", false);

    var q = st.current_question;
    if (!q) return;
    var changed = currentQuestionId !== q.id;
    if (changed) {
      currentQuestionId = q.id;
      currentQuestion = q;
      answered = st.submitted.indexOf(session.userId) !== -1;
      myChoice = null;
      hideFeedback();
    }

    setText("mp-progress", "第 " + (q.index + 1) + " / " + q.total + " 题");
    setText("mp-speak", q.speak_text);

    renderOptions(q, st);
    renderSubmitStatus(st);
    renderNextControls(st);

    // 计时器：仅在新题、未作答、进行中时启动
    if (st.status === "playing") {
      if (changed || timerInterval === null) {
        if (!answered) startTimer(q.time_limit);
        else stopTimer();
      }
    } else {
      stopTimer();
    }
  }

  function renderOptions(q, st) {
    var box = $("mp-options");
    if (!box) return;
    var myUid = session.userId;
    var iSubmitted = st.submitted.indexOf(myUid) !== -1;
    var revealed = st.status === "awaiting_next" && st.last_results && st.last_results.length;
    var myResult = revealed
      ? st.last_results.find(function (r) { return r.user_id === myUid; })
      : null;
    var answerIndex = revealed && st.last_results[0] ? st.last_results[0].answer_index : -1;

    box.innerHTML = "";
    q.options.forEach(function (opt, i) {
      var b = document.createElement("button");
      b.className = "quiz-opt mp-opt";
      b.textContent = opt;
      b.dataset.index = i;

      if (revealed) {
        b.disabled = true;
        if (i === answerIndex) b.classList.add("correct");
        else if (myResult && !myResult.correct && myChoice === i) b.classList.add("wrong");
        else b.classList.add("dim");
      } else if (iSubmitted || answered) {
        b.disabled = true;
        if (i !== myChoice) b.classList.add("dim");
      } else {
        b.addEventListener("click", function () { submitAnswer(i); });
      }
      box.appendChild(b);
    });

    if (revealed) showResultFeedback(myResult);
  }

  function renderSubmitStatus(st) {
    var myUid = session.userId;
    var others = st.players.filter(function (p) { return p.user_id !== myUid; });
    var iSubmitted = st.submitted.indexOf(myUid) !== -1;
    var allSubmitted = st.submitted.length >= st.players.length;

    var el = $("mp-submit-status");
    if (st.status === "awaiting_next") {
      el.textContent = "";
      return;
    }
    if (iSubmitted) {
      var wait = others.map(function (p) {
        return st.submitted.indexOf(p.user_id) !== -1 ? p.nickname + " 已提交" : p.nickname + " 未提交";
      }).join(" · ");
      el.textContent = "你已提交 · " + wait;
    } else {
      var done = st.players.filter(function (p) { return st.submitted.indexOf(p.user_id) !== -1; })
        .filter(function (p) { return p.user_id !== myUid; });
      el.textContent = done.length ? done.map(function (p) { return p.nickname; }).join("、") + " 已提交" : "";
    }
  }

  function renderNextControls(st) {
    var wrap = $("mp-next-wrap");
    if (!wrap) return;
    var myUid = session.userId;
    var me = st.players.find(function (p) { return p.user_id === myUid; });
    var isHost = me && me.is_host;

    if (st.status === "awaiting_next") {
      wrap.style.display = "block";
      var nextBtn = $("mp-next");
      var hint = $("mp-next-hint");
      if (isHost) {
        nextBtn.style.display = "block";
        hint.textContent = "";
      } else {
        nextBtn.style.display = "none";
        hint.textContent = "等待房主切题…";
      }
    } else {
      wrap.style.display = "none";
    }
  }

  function showResultFeedback(myResult) {
    var fb = $("mp-feedback");
    if (!fb || !myResult) return;
    if (myResult.correct) {
      fb.textContent = "✅ 正确！ +" + myResult.points + " 分";
      fb.className = "quiz-feedback correct";
    } else {
      fb.textContent = "❌ 答错了，正确答案已标绿";
      fb.className = "quiz-feedback wrong";
    }
  }

  function hideFeedback() {
    var fb = $("mp-feedback");
    if (fb) { fb.className = "quiz-feedback"; fb.textContent = ""; }
  }

  /* ------------------ 结算渲染 ------------------ */
  function renderFinished(st) {
    var box = $("mp-ranking");
    if (!box) return;
    var myUid = session.userId;
    var ranking = st.ranking && st.ranking.length ? st.ranking : st.players.slice().sort(function (a, b) { return b.score - a.score; });
    var medals = ["🥇", "🥈", "🥉"];
    box.innerHTML = "";
    ranking.forEach(function (p, i) {
      var div = document.createElement("div");
      div.className = "mp-rank-item" + (p.user_id === myUid ? " me" : "");
      var medal = document.createElement("div");
      medal.className = "mp-medal";
      medal.textContent = medals[i] || (i + 1);
      var name = document.createElement("div");
      name.className = "mp-rname";
      name.textContent = p.nickname + (p.user_id === myUid ? "（我）" : "");
      var score = document.createElement("div");
      score.className = "mp-rscore";
      score.textContent = p.score + " 分";
      div.appendChild(medal);
      div.appendChild(name);
      div.appendChild(score);
      box.appendChild(div);
    });

    var me = st.players.find(function (p) { return p.user_id === myUid; });
    var isHost = me && me.is_host;
    var again = $("mp-again");
    var hint = $("mp-finished-hint");
    if (isHost) {
      again.style.display = "block";
      hint.textContent = "";
    } else {
      again.style.display = "none";
      hint.textContent = "等待房主再来一局…";
    }
  }

  /* ------------------ 计时器 ------------------ */
  function startTimer(seconds) {
    stopTimer();
    if (!seconds || seconds <= 0) return;
    timerDeadline = Date.now() + seconds * 1000;
    var el = $("mp-timer");
    timerInterval = setInterval(function () {
      var remain = Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000));
      if (el) {
        el.textContent = "⏱ 剩余 " + remain + " 秒";
        el.classList.toggle("low", remain <= 5);
      }
      if (remain <= 0) {
        stopTimer();
        onTimeout();
      }
    }, 250);
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    var el = $("mp-timer");
    if (el) el.textContent = "";
  }

  function onTimeout() {
    if (!session || !currentQuestionId) return;
    if (answered) return;
    if (roomState && roomState.status !== "playing") return;
    answered = true;
    myChoice = -1;
    sendMsg({ type: "timeout", question_id: currentQuestionId });
    setText("mp-submit-status", "⏰ 超时，等待对手…");
  }

  /* ------------------ 交互动作 ------------------ */
  function submitAnswer(choice) {
    if (answered) return;
    if (!session || !currentQuestionId) return;
    if (roomState && roomState.status !== "playing") return;
    answered = true;
    myChoice = choice;
    sendMsg({ type: "submit", question_id: currentQuestionId, choice: choice });
    // 立即给本地反馈（禁用选项、提示已提交）
    var box = $("mp-options");
    if (box) box.querySelectorAll(".mp-opt").forEach(function (b) {
      b.disabled = true;
      if (parseInt(b.dataset.index, 10) !== choice) b.classList.add("dim");
    });
    setText("mp-submit-status", "你已提交，等待对手…");
    stopTimer();
  }

  function createRoom() {
    var nick = clampNick($("mp-nickname").value) || "玩家";
    showSetupMsg("");
    api("POST", "/api/rooms", { nickname: nick }, function (err, data) {
      if (err) { showSetupMsg("❌ " + err, "wrong"); return; }
      adoptSession(data.room_code, data.user_id, nick);
      rememberNick(nick);
      connect();
      renderAll();
    });
  }

  function joinRoom() {
    var nick = clampNick($("mp-nickname").value) || "玩家";
    var code = clampNick($("mp-join-code").value).toUpperCase();
    if (!code) { showSetupMsg("请输入房间号", "wrong"); return; }
    showSetupMsg("");
    api("POST", "/api/rooms/" + encodeURIComponent(code) + "/join", { nickname: nick }, function (err, data) {
      if (err) { showSetupMsg("❌ " + err, "wrong"); return; }
      adoptSession(data.room_code, data.user_id, nick);
      rememberNick(nick);
      connect();
      renderAll();
    });
  }

  function leaveRoom() {
    intentionalClose = true;
    if (ws && session) sendMsg({ type: "leave" });
    closeWs();
    clearSession();
    currentQuestionId = null;
    currentQuestion = null;
    myChoice = null;
    answered = false;
    roomState = null;
    showView("setup");
    renderAll();
  }

  function startGame() { sendMsg({ type: "start" }); }
  function nextQuestion() { sendMsg({ type: "next_question" }); }
  function again() { sendMsg({ type: "start" }); }  // 复用 start 触发再来一局

  function showSetupMsg(text, cls) {
    var el = $("mp-setup-msg");
    if (!el) return;
    el.textContent = text;
    el.className = "quiz-feedback" + (cls ? " " + cls : "");
  }

  /* ------------------ 会话持久化 ------------------ */
  function adoptSession(code, uid, nick) {
    session = { roomCode: code, userId: uid, nickname: nick };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
    currentQuestionId = null;
    myChoice = null;
    answered = false;
    roomState = null;
    intentionalClose = false;
  }

  function clearSession() {
    session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function restoreSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) session = JSON.parse(raw);
    } catch (e) { session = null; }
  }

  function rememberNick(nick) {
    try { localStorage.setItem(NICK_KEY, nick); } catch (e) {}
  }

  function recallNick() {
    try { return localStorage.getItem(NICK_KEY) || ""; } catch (e) { return ""; }
  }

  /* ------------------ HTTP 请求 ------------------ */
  function api(method, path, body, cb) {
    var url = BACKEND_URL + path;
    var opt = { method: method, headers: { "Content-Type": "application/json" } };
    if (body) opt.body = JSON.stringify(body);
    fetch(url, opt)
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (r.ok) return cb(null, j);
          var msg = (j && j.detail) ? j.detail : ("请求失败（" + r.status + "）");
          if (typeof j === "string") msg = j;
          if (j && j.detail && typeof j.detail === "object") msg = JSON.stringify(j.detail);
          return cb(msg, null);
        });
      })
      .catch(function () {
        cb("网络错误，请检查后端是否在线", null);
      });
  }

  /* ------------------ WebSocket ------------------ */
  function connect() {
    if (!session) return;
    closeWs();
    intentionalClose = false;
    updateConnStatus("connecting");
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      updateConnStatus("offline");
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      reconnectAttempt = 0;
      lastPong = Date.now();
      updateConnStatus("online");
      sendMsg({ type: "join", room_code: session.roomCode, user_id: session.userId, nickname: session.nickname });
      startHeartbeat();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    };
    ws.onclose = function () {
      stopHeartbeat();
      stopTimer();
      ws = null;
      if (!intentionalClose && session) {
        updateConnStatus("offline");
        scheduleReconnect();
      }
    };
    ws.onerror = function () { /* 由 onclose 统一处理 */ };
  }

  function closeWs() {
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (e) {}
      ws = null;
    }
    stopHeartbeat();
  }

  function sendMsg(obj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  }

  function ensureConnected() {
    if (session && !ws) connect();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (intentionalClose || !session) return;
      connect();
    }, delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - lastPong > HEARTBEAT_TIMEOUT) {
        // 心跳超时，主动断开触发重连
        try { ws.close(); } catch (e) {}
        return;
      }
      sendMsg({ type: "ping" });
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  /* ------------------ 服务端消息处理 ------------------ */
  function handleMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "room_state":
        roomState = msg;
        renderAll();
        break;
      case "question":
        // room_state 已携带 current_question；这里作为兜底触发渲染
        if (roomState) { roomState.current_question = msg; renderPlay(roomState); }
        break;
      case "answer_result":
        // 结算在 room_state(last_results) 中统一渲染；这里仅作即时反馈
        if (roomState && msg.user_id === session.userId) {
          var r = { user_id: msg.user_id, correct: msg.correct, answer_index: msg.answer_index, points: msg.points };
          if (!roomState.last_results) roomState.last_results = [];
          roomState.last_results = roomState.last_results.filter(function (x) { return x.user_id !== r.user_id; }).concat(r);
          renderPlay(roomState);
        }
        break;
      case "score_update":
        if (roomState && msg.scores) {
          roomState.scores = msg.scores;
          roomState.players.forEach(function (p) { if (msg.scores[p.user_id] != null) p.score = msg.scores[p.user_id]; });
        }
        break;
      case "game_finished":
        if (roomState) {
          roomState.status = "finished";
          if (msg.ranking) roomState.ranking = msg.ranking;
          renderAll();
        }
        break;
      case "player_joined":
      case "player_left":
      case "host_changed":
        // 权威状态由随后的 room_state 推送，无需额外处理
        break;
      case "pong":
        lastPong = Date.now();
        break;
      case "error":
        handleError(msg);
        break;
    }
  }

  function handleError(msg) {
    if (msg.code === "ROOM_NOT_FOUND" || msg.code === "USER_NOT_FOUND") {
      // 房间过期/不存在：友好提示并回到创建界面，不无限重试
      intentionalClose = true;
      closeWs();
      clearSession();
      roomState = null;
      currentQuestionId = null;
      currentQuestion = null;
      answered = false;
      myChoice = null;
      renderAll();
      showSetupMsg("⚠️ " + (msg.message || "房间不存在，请重新创建房间"), "wrong");
    } else if (msg.code === "NOT_HOST") {
      showSetupMsg("⚠️ " + msg.message, "wrong");
    } else {
      showSetupMsg("⚠️ " + (msg.message || "出错了"), "wrong");
    }
  }

  /* ------------------ 事件绑定 ------------------ */
  function wirePanelEvents() {
    var bind = function (id, ev, fn) { var el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("mp-create", "click", createRoom);
    bind("mp-join", "click", joinRoom);
    bind("mp-join-code", "keydown", function (e) { if (e.key === "Enter") joinRoom(); });
    bind("mp-nickname", "keydown", function (e) { if (e.key === "Enter") createRoom(); });
    bind("mp-start", "click", startGame);
    bind("mp-next", "click", nextQuestion);
    bind("mp-leave", "click", leaveRoom);
    bind("mp-exit", "click", leaveRoom);
    bind("mp-again", "click", again);
    bind("mp-speak-btn", "click", function () {
      if (currentQuestion && currentQuestion.speak_text && window.speak) window.speak(currentQuestion.speak_text);
    });
  }

  /* ------------------ 对外 API ------------------ */
  function open() {
    // 切到单词测验标签页（复用现有 setMode，若存在）
    if (window.setMode) window.setMode("quiz");
    setMpMode("multi");
  }

  function init() {
    if (inited) return;
    inited = true;
    restoreSession();
    if (!injectUI()) return;
    // 预填昵称
    var nick = $("mp-nickname");
    if (nick) nick.value = recallNick();
    // 若有会话则建立连接（刷新后恢复）
    if (session) connect();
    // 初始状态：默认单机
    setMpMode("solo");
  }

  window.Multiplayer = { open: open };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
