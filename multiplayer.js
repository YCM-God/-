/* =====================================================================
 * 联机对战（单词测验）· P2P 点对点版（无需后端）
 * ---------------------------------------------------------------------
 * 纯原生 JS，IIFE 隔离，暴露 window.Multiplayer.open()。
 * 依赖 index.html 已存在的全局：WORDS（词库）、speak()、CSS 变量。
 * 依赖 PeerJS（加载本文件前需先引入 peerjs，见 index.html）。
 *
 * 原理：房主浏览器当「服务器」——出题、判分、结算都在房主端；
 *       访客通过 PeerJS 数据通道与房主直连，收发同样的 room_state 消息。
 * 说明：P2P 需双方能连到 PeerJS 信令服务器（0.peerjs.com）且网络能打洞；
 *       同一 WiFi/局域网最稳，跨网络（不同宽带/手机流量）可能连不上。
 * ===================================================================== */
(function () {
  "use strict";

  /* ------------------ 配置 ------------------ */
  var ICE_SERVERS = [                       // STUN：帮助双方在 NAT 后找到对方
    { urls: "stun:stun.miwifi.com:3478" },
    { urls: "stun:stun.l.google.com:19302" }
  ];

  var TOTAL_QUESTIONS = 20;    // 每局题数
  var TIME_LIMIT = 30;         // 每题作答秒数
  var START_HP = TOTAL_QUESTIONS;  // 初始血量（20 格，答错扣 1 格）
  var ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // 去掉 0/O、1/I

  var NICK_KEY = "cet_word_battle_nickname";    // 昵称记忆

  /* ------------------ 词库（读 index.html 里的全局 WORDS） ------------------ */
  var WORD_LIST = (typeof WORDS !== "undefined") ? WORDS : [];

  /* ------------------ 内部状态 ------------------ */
  var mpMode = "solo";         // solo | multi
  var role = null;             // host | guest | null
  var session = null;          // { roomCode, userId: "host"/"guest", nickname }
  var peer = null;
  var conn = null;
  var roomState = null;        // 最近一次 room_state（访客为同步副本，房主为权威）
  var hostState = null;        // 仅房主使用：权威房间状态
  var currentQuestionId = null;
  var currentQuestion = null;
  var myChoice = null;
  var answered = false;
  var timerInterval = null;
  var timerDeadline = 0;
  var intentionalClose = false;  // 主动离开，不再提示断开
  var inited = false;

  /* ------------------ 工具 ------------------ */
  function $(id) { return document.getElementById(id); }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
  function clampNick(n) { return (n || "").trim().slice(0, 12); }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function genCode() {
    var c = "";
    for (var i = 0; i < 6; i++) c += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    return c;
  }

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
      ".mp-hud{margin-bottom:12px;}",
      ".mp-hud-player{margin-bottom:14px;}",
      ".mp-hud-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;}",
      ".mp-hud-name{font-weight:700;color:var(--text);font-size:14px;}",
      ".mp-hud-hp{font-size:12px;color:var(--text-sub);font-weight:800;}",
      ".mp-hpbar{display:flex;gap:2px;width:100%;}",
      ".mp-hpseg{flex:1;height:14px;border-radius:3px;background:var(--border);transition:background .2s;}",
      ".mp-hpbar .mp-hpseg.on{background:#10b981;}",
      ".mp-hpbar.low .mp-hpseg.on{background:#f59e0b;}",
      ".mp-hpbar.crit .mp-hpseg.on{background:#ef4444;}",
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
      '    <div class="mp-hud" id="mp-hud"></div>' +
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
      '    <h3 id="mp-finished-title">🏆 对战结果</h3>' +
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
    var seg = $("mp-mode-field");
    if (seg) seg.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.m === mpMode);
    });
    ["quiz-count", "quiz-type"].forEach(function (id) {
      var el = $(id);
      var field = el && el.closest(".quiz-field");
      if (field) field.style.display = multi ? "none" : "";
    });
    var startBtn = $("quiz-start");
    if (startBtn) startBtn.style.display = multi ? "none" : "";
    var h3 = $("quiz-setup") && $("quiz-setup").querySelector("h3");
    if (h3) h3.style.display = multi ? "none" : "";
    var panel = $("mp-panel");
    if (panel) panel.style.display = multi ? "block" : "none";

    if (multi) renderAll();
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
      offline: "🔴 连接已断开",
    };
    el.textContent = map[state] || "";
    el.className = "mp-conn" + (state === "offline" ? " off" : "");
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
      div.appendChild(name);
      div.appendChild(status);
      box.appendChild(div);
    });
  }

  /* ------------------ 血条 HUD ------------------ */
  function renderHud(st) {
    var box = $("mp-hud");
    if (!box) return;
    var myUid = session.userId;
    var maxHp = st.total_questions || START_HP;
    box.innerHTML = "";
    st.players.forEach(function (p) {
      var hp = Math.max(0, Math.min(maxHp, p.score));
      var div = document.createElement("div");
      div.className = "mp-hud-player";

      var head = document.createElement("div");
      head.className = "mp-hud-head";
      var name = document.createElement("span");
      name.className = "mp-hud-name";
      name.textContent = p.nickname + (p.user_id === myUid ? "（我）" : "") + (p.is_host ? " ·房主" : "");
      var hpNum = document.createElement("span");
      hpNum.className = "mp-hud-hp";
      hpNum.textContent = hp + " / " + maxHp;
      head.appendChild(name);
      head.appendChild(hpNum);
      div.appendChild(head);

      var bar = document.createElement("div");
      bar.className = "mp-hpbar" + (hp <= maxHp * 0.25 ? " crit" : hp <= maxHp * 0.5 ? " low" : "");
      for (var i = 0; i < maxHp; i++) {
        var seg = document.createElement("span");
        seg.className = "mp-hpseg" + (i < hp ? " on" : "");
        bar.appendChild(seg);
      }
      div.appendChild(bar);

      box.appendChild(div);
    });
  }

  /* ------------------ 对战渲染 ------------------ */
  function renderPlay(st) {
    renderHud(st);

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
      fb.textContent = "✅ 答对了！血条不变";
      fb.className = "quiz-feedback correct";
    } else {
      fb.textContent = "❌ 答错了，血条 -1";
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
      score.textContent = p.score + " / " + (st.total_questions || START_HP);
      div.appendChild(medal);
      div.appendChild(name);
      div.appendChild(score);
      box.appendChild(div);
    });

    var title = $("mp-finished-title");
    if (title) {
      var sorted = st.players.slice().sort(function (a, b) { return b.score - a.score; });
      if (sorted.length >= 2 && sorted[0].score === sorted[1].score) {
        title.textContent = "🤝 平局";
      } else if (sorted.length) {
        title.textContent = "🏆 " + sorted[0].nickname + " 获胜";
      }
    }

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
    if (role === "guest") {
      sendMsg({ type: "timeout", question_id: currentQuestionId });
    } else {
      recordAnswer("host", -1, currentQuestionId);
    }
    setText("mp-submit-status", "⏰ 超时，等待对手…");
  }

  /* ------------------ 交互动作 ------------------ */
  function submitAnswer(choice) {
    if (answered) return;
    if (!session || !currentQuestionId) return;
    if (roomState && roomState.status !== "playing") return;
    answered = true;
    myChoice = choice;
    if (role === "guest") {
      sendMsg({ type: "submit", question_id: currentQuestionId, choice: choice });
    } else {
      recordAnswer("host", choice, currentQuestionId);
    }
    var box = $("mp-options");
    if (box) box.querySelectorAll(".mp-opt").forEach(function (b) {
      b.disabled = true;
      if (parseInt(b.dataset.index, 10) !== choice) b.classList.add("dim");
    });
    setText("mp-submit-status", "你已提交，等待对手…");
    stopTimer();
  }

  /* 动态加载 PeerJS（无需在 index.html 里加 <script>） */
  var PEER_CDNS = [
    "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js",
    "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"
  ];
  var peerReadyPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("load failed: " + src)); };
      document.head.appendChild(s);
    });
  }

  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    if (peerReadyPromise) return peerReadyPromise;
    function tryNext(i) {
      if (window.Peer) return Promise.resolve();
      if (i >= PEER_CDNS.length) return Promise.reject(new Error("PeerJS 加载失败"));
      return loadScript(PEER_CDNS[i]).then(
        function () { return window.Peer ? Promise.resolve() : tryNext(i + 1); },
        function () { return tryNext(i + 1); }
      );
    }
    peerReadyPromise = tryNext(0);
    return peerReadyPromise;
  }

  function createRoom() {
    var nick = clampNick($("mp-nickname").value) || "玩家";
    showSetupMsg("⏳ 正在加载联机组件…");
    loadPeer().then(function () {
      showSetupMsg("");
      role = "host";
      var code = genCode();
      session = { roomCode: code, userId: "host", nickname: nick };
      rememberNick(nick);
      hostState = {
        code: code,
        hostNick: nick,
        guestNick: null,
        guestConnected: false,
        scores: { host: 0, guest: 0 },
        questions: [],
        questionIndex: 0,
        currentAnswers: {},
        currentQid: null,
        status: "waiting",
        lastResults: null,
        totalQuestions: TOTAL_QUESTIONS,
        timeLimit: TIME_LIMIT,
      };
      updateConnStatus("connecting");
      peer = new Peer(code, { debug: 0, config: { iceServers: ICE_SERVERS } });
      peer.on("open", function () {
        updateConnStatus("online");
        broadcastState();
      });
      peer.on("connection", function (c) {
        conn = c;
        wireConnection(c);
      });
      peer.on("error", function (e) {
        if (e && e.type === "unavailable-id") {
          showSetupMsg("⚠️ 房间号冲突，请重新创建", "wrong");
          resetToSetup();
        } else {
          updateConnStatus("offline");
        }
      });
    }).catch(function () {
      showSetupMsg("⚠️ 联机库加载失败，请检查网络后刷新页面", "wrong");
    });
  }

  function joinRoom() {
    var nick = clampNick($("mp-nickname").value) || "玩家";
    var code = clampNick($("mp-join-code").value).toUpperCase();
    if (!code) { showSetupMsg("请输入房间号", "wrong"); return; }
    showSetupMsg("⏳ 正在加载联机组件…");
    loadPeer().then(function () {
      showSetupMsg("");
      role = "guest";
      session = { roomCode: code, userId: "guest", nickname: nick };
      rememberNick(nick);
      updateConnStatus("connecting");
      peer = new Peer({ debug: 0, config: { iceServers: ICE_SERVERS } });
      peer.on("open", function () {
        var c = peer.connect(code, { reliable: true });
        conn = c;
        wireConnection(c);
      });
      peer.on("error", function (e) {
        if (e && e.type === "peer-unavailable") {
          showSetupMsg("⚠️ 房间不存在或对方已关闭", "wrong");
          resetToSetup();
        } else {
          updateConnStatus("offline");
        }
      });
    }).catch(function () {
      showSetupMsg("⚠️ 联机库加载失败，请检查网络后刷新页面", "wrong");
    });
  }

  function leaveRoom() {
    intentionalClose = true;
    if (role === "guest" && conn && conn.open) {
      try { conn.send(JSON.stringify({ type: "leave" })); } catch (e) {}
    }
    closePeer();
    resetToSetup();
  }

  function startGame() {
    if (!hostState) return;
    if (hostState.status !== "waiting" && hostState.status !== "finished") return;
    if (hostState.guestNick === null) return;
    hostState.scores = { host: START_HP, guest: START_HP };
    hostState.questionIndex = 0;
    hostState.questions = generateQuestions();
    hostState.currentAnswers = {};
    hostState.lastResults = null;
    hostState.status = "playing";
    hostState.currentQid = hostState.questions[0].id;
    currentQuestionId = null;
    myChoice = null;
    answered = false;
    broadcastState();
    hostScheduleResolve(hostState.currentQid);
  }

  function nextQuestion() {
    if (!hostState) return;
    if (hostState.status !== "awaiting_next") return;
    hostState.questionIndex += 1;
    if (hostState.questionIndex >= hostState.totalQuestions) {
      hostState.status = "finished";
      broadcastState();
      return;
    }
    hostState.currentAnswers = {};
    hostState.lastResults = null;
    hostState.status = "playing";
    hostState.currentQid = hostState.questions[hostState.questionIndex].id;
    currentQuestionId = null;
    myChoice = null;
    answered = false;
    broadcastState();
    hostScheduleResolve(hostState.currentQid);
  }

  function again() { startGame(); }

  function showSetupMsg(text, cls) {
    var el = $("mp-setup-msg");
    if (!el) return;
    el.textContent = text;
    el.className = "quiz-feedback" + (cls ? " " + cls : "");
  }

  /* ------------------ 昵称记忆 ------------------ */
  function rememberNick(nick) {
    try { localStorage.setItem(NICK_KEY, nick); } catch (e) {}
  }
  function recallNick() {
    try { return localStorage.getItem(NICK_KEY) || ""; } catch (e) { return ""; }
  }

  /* ------------------ P2P 传输 ------------------ */
  function sendMsg(obj) {
    if (conn && conn.open) {
      try { conn.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function closePeer() {
    if (conn) { try { conn.close(); } catch (e) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    stopTimer();
  }

  function resetToSetup() {
    closePeer();
    session = null;
    role = null;
    roomState = null;
    hostState = null;
    currentQuestionId = null;
    currentQuestion = null;
    myChoice = null;
    answered = false;
    intentionalClose = false;
    showView("setup");
    renderAll();
  }

  function wireConnection(c) {
    c.on("open", function () {
      updateConnStatus("online");
      if (role === "guest") {
        sendMsg({ type: "join", nickname: session.nickname });
      }
    });
    c.on("data", function (d) {
      var msg;
      try { msg = JSON.parse(d); } catch (e) { return; }
      if (role === "host") handleGuestMessage(msg);
      else handleMessage(msg);
    });
    c.on("close", function () {
      conn = null;
      if (intentionalClose) return;
      if (role === "host") {
        showSetupMsg("⚠️ 对方已离开房间", "wrong");
        handleGuestLeave();
      } else {
        showSetupMsg("⚠️ 对方已断开连接", "wrong");
        resetToSetup();
      }
    });
    c.on("error", function () {
      updateConnStatus("offline");
    });
  }

  /* ------------------ 房主：处理访客消息 + 游戏逻辑 ------------------ */
  function handleGuestMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "join":
        if (hostState.guestNick !== null) {
          sendMsg({ type: "error", code: "ROOM_FULL", message: "房间已满" });
          return;
        }
        hostState.guestNick = clampNick(msg.nickname) || "玩家";
        hostState.guestConnected = true;
        broadcastState();
        break;
      case "submit":
        recordAnswer("guest", msg.choice, msg.question_id);
        break;
      case "timeout":
        recordAnswer("guest", -1, msg.question_id);
        break;
      case "leave":
        handleGuestLeave();
        break;
      case "ping":
        sendMsg({ type: "pong" });
        break;
    }
  }

  function handleGuestLeave() {
    if (!hostState) return;
    hostState.guestNick = null;
    hostState.guestConnected = false;
    hostState.status = "waiting";
    hostState.questions = [];
    hostState.questionIndex = 0;
    hostState.currentAnswers = {};
    hostState.currentQid = null;
    hostState.lastResults = null;
    hostState.scores = { host: 0, guest: 0 };
    broadcastState();
  }

  function recordAnswer(uid, choice, qid) {
    if (!hostState || hostState.status !== "playing") return;
    if (qid !== hostState.currentQid) return;
    if (hostState.currentAnswers[uid] !== undefined) return;
    hostState.currentAnswers[uid] = choice;
    if (hostState.currentAnswers.host !== undefined && hostState.currentAnswers.guest !== undefined) {
      resolveQuestion();
    } else {
      broadcastState();
    }
  }

  function resolveQuestion() {
    if (!hostState || hostState.status !== "playing") return;
    var q = hostState.questions[hostState.questionIndex];
    if (!q) return;
    var results = ["host", "guest"].map(function (uid) {
      var choice = hostState.currentAnswers[uid];
      var correct = choice === q.answerIndex;
      var delta = correct ? 0 : -1;                    // 答对不掉血，答错扣 1 格
      hostState.scores[uid] = Math.max(0, hostState.scores[uid] + delta);
      return { user_id: uid, correct: correct, answer_index: q.answerIndex, points: delta };
    });
    hostState.lastResults = results;
    hostState.status = "awaiting_next";
    broadcastState();
  }

  function hostScheduleResolve(qid) {
    setTimeout(function () {
      if (!hostState || hostState.status !== "playing") return;
      if (hostState.currentQid !== qid) return;
      if (hostState.currentAnswers.host === undefined) recordAnswer("host", -1, qid);
      if (hostState.currentAnswers.guest === undefined) recordAnswer("guest", -1, qid);
    }, (TIME_LIMIT + 3) * 1000);
  }

  function generateQuestions() {
    var all = WORD_LIST.slice();
    shuffle(all);
    var picked = all.slice(0, Math.min(TOTAL_QUESTIONS, all.length));

    var meanings = [];
    WORD_LIST.forEach(function (w) {
      if (w.meaning && meanings.indexOf(w.meaning) === -1) meanings.push(w.meaning);
    });

    return picked.map(function (w, i) {
      var correct = w.meaning;
      var opts = [correct];
      shuffle(meanings);
      for (var j = 0; j < meanings.length && opts.length < 4; j++) {
        var m = meanings[j];
        if (m !== correct && opts.indexOf(m) === -1) opts.push(m);
      }
      while (opts.length < 4) opts.push("——");
      shuffle(opts);
      return { id: i + 1, word: w.word, options: opts, answerIndex: opts.indexOf(correct) };
    });
  }

  function buildQuestion(index) {
    var q = hostState.questions[index];
    if (!q) return null;
    return {
      id: q.id,
      speak_text: q.word,
      options: q.options,               // 不含答案
      index: index,
      total: hostState.totalQuestions,
      time_limit: hostState.timeLimit,
    };
  }

  function buildRoomState() {
    if (!hostState) return null;
    var players = [
      { user_id: "host", nickname: hostState.hostNick, score: hostState.scores.host, is_host: true, connected: true }
    ];
    if (hostState.guestNick !== null) {
      players.push({ user_id: "guest", nickname: hostState.guestNick, score: hostState.scores.guest, is_host: false, connected: hostState.guestConnected });
    }
    var currentQuestion = null;
    if (
      (hostState.status === "playing" || hostState.status === "awaiting_next") &&
      hostState.questions.length
    ) {
      currentQuestion = buildQuestion(hostState.questionIndex);
    }
    var ranking = players.slice().sort(function (a, b) { return b.score - a.score; });

    return {
      type: "room_state",
      room_code: hostState.code,
      host_id: "host",
      status: hostState.status,
      players: players,
      question_index: hostState.questionIndex,
      total_questions: hostState.totalQuestions,
      current_question: currentQuestion,
      scores: hostState.scores,
      submitted: hostState.status === "playing" ? Object.keys(hostState.currentAnswers) : [],
      last_results: hostState.lastResults,
      ranking: ranking,
    };
  }

  function broadcastState() {
    var st = buildRoomState();
    if (!st) return;
    roomState = st;        // 房主本地也更新
    renderAll();
    sendMsg(st);           // 同步给访客
  }

  /* ------------------ 访客：处理房主消息 ------------------ */
  function handleMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "room_state":
        roomState = msg;
        renderAll();
        break;
      case "error":
        handleError(msg);
        break;
      case "pong":
        break;
    }
  }

  function handleError(msg) {
    showSetupMsg("⚠️ " + (msg.message || "出错了"), "wrong");
    if (msg.code === "ROOM_FULL") {
      resetToSetup();
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
    if (window.setMode) window.setMode("quiz");
    setMpMode("multi");
  }

  function init() {
    if (inited) return;
    inited = true;
    if (!injectUI()) return;
    var nick = $("mp-nickname");
    if (nick) nick.value = recallNick();
    setMpMode("solo");
  }

  window.Multiplayer = { open: open };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
