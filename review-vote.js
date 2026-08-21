/* ZIPA POKER — 審閱表態元件 / review vote widget.
   Attaches a 同意 / 有疑慮 / 先保留 control plus a note field to every section of the
   review page, and posts each answer to the Cloudflare Worker named in the script tag's
   data-api attribute. Built in the same system as the page: 紙白 ground, 協會藍 structure,
   競賽紅 only where a reservation is actually registered, square corners, 1px hairlines,
   no shadow. Degrades to local-only storage when the Worker is unreachable. */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="review-vote.js"]');
  var API = ((script && script.dataset.api) || window.ZP_REVIEW_API || "").replace(/\/+$/, "");
  if (/YOUR-SUBDOMAIN/.test(API)) API = "";
  var IDENTITY_KEY = "zp-review-identity";
  var PENDING_KEY = "zp-review-pending";
  var LOCAL_KEY = "zp-review-local";

  var CHOICES = [
    { id: "agree", zh: "同意", en: "AGREE" },
    { id: "concern", zh: "有疑慮", en: "CONCERN" },
    { id: "hold", zh: "先保留", en: "HOLD" }
  ];

  /* ---------- storage helpers (every access guarded: private windows throw) ---------- */

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* nothing to do — the widget still works for this page view */
    }
  }

  var identity = read(IDENTITY_KEY, null);
  var localAnswers = read(LOCAL_KEY, {});
  var blocks = {};

  /* ---------- section identity ----------
     The eyebrow reads "今日變更 · WHAT CHANGED TODAY". The English half is the stable
     half: the Chinese headline can be rewritten between drafts without orphaning votes. */

  function slugFor(section, index) {
    var eyebrow = section.querySelector(".eyebrow");
    var text = eyebrow ? eyebrow.textContent : "";
    var english = text.split("·").pop();
    var slug = english
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return slug || "section-" + (index + 1);
  }

  function titleFor(section) {
    var h2 = section.querySelector(".h2");
    return h2 ? h2.textContent.trim() : "";
  }

  /* ---------- network ---------- */

  function post(payload) {
    if (!API) return Promise.reject(new Error("no-api"));
    return fetch(API + "/vote", {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-code": identity.code },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 401) throw new Error("bad-code");
      if (!res.ok) throw new Error("http-" + res.status);
      return res.json();
    });
  }

  function fetchResults() {
    if (!API || !identity) return Promise.resolve(null);
    return fetch(API + "/results", { headers: { "x-review-code": identity.code } })
      .then(function (res) {
        if (!res.ok) throw new Error("http-" + res.status);
        return res.json();
      })
      .then(function (data) {
        return data.votes || [];
      })
      .catch(function () {
        return null;
      });
  }

  /* ---------- pending queue: answers made while the Worker was unreachable ---------- */

  function queue(payload) {
    var pending = read(PENDING_KEY, []).filter(function (item) {
      return item.section !== payload.section;
    });
    pending.push(payload);
    write(PENDING_KEY, pending);
  }

  function flushQueue() {
    var pending = read(PENDING_KEY, []);
    if (!pending.length || !identity || !API) return Promise.resolve();
    return Promise.all(
      pending.map(function (payload) {
        return post(payload).then(
          function () {
            return payload.section;
          },
          function () {
            return null;
          }
        );
      })
    ).then(function (done) {
      var sent = done.filter(Boolean);
      if (!sent.length) return;
      write(
        PENDING_KEY,
        read(PENDING_KEY, []).filter(function (item) {
          return sent.indexOf(item.section) === -1;
        })
      );
      sent.forEach(function (slug) {
        if (blocks[slug]) setState(blocks[slug], "saved", "已送出");
      });
    });
  }

  /* ---------- widget ---------- */

  function setState(block, kind, text) {
    block.state.dataset.kind = kind;
    block.state.textContent = text;
  }

  function stamp() {
    var now = new Date();
    return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  }

  function save(block) {
    if (!block.choice) {
      setState(block, "warn", "請先選一個選項，備註才會一起送出");
      return;
    }
    var payload = {
      voter: identity.voter,
      section: block.slug,
      choice: block.choice,
      note: block.note.value.trim()
    };

    localAnswers[block.slug] = { choice: payload.choice, note: payload.note };
    write(LOCAL_KEY, localAnswers);
    updateProgress();

    if (!API) {
      setState(block, "warn", "已存在本機（尚未設定後端）");
      return;
    }

    setState(block, "saving", "儲存中");
    post(payload).then(
      function () {
        setState(block, "saved", "已送出 · " + stamp());
        refreshTallies();
      },
      function (err) {
        if (err.message === "bad-code") {
          setState(block, "warn", "通行碼不正確");
          openIdentity(true);
          return;
        }
        queue(payload);
        setState(block, "warn", "暫時連不上，已保留，稍後自動重送");
      }
    );
  }

  function buildBlock(section, slug, title) {
    var wrap = document.createElement("div");
    wrap.className = "zpv";
    wrap.dataset.section = slug;

    var head = document.createElement("div");
    head.className = "zpv-head";
    var label = document.createElement("span");
    label.className = "mono zpv-label";
    label.textContent = "你的意見 · YOUR CALL";
    var tally = document.createElement("span");
    tally.className = "mono zpv-tally";
    tally.textContent = "";
    head.appendChild(label);
    head.appendChild(tally);

    var opts = document.createElement("div");
    opts.className = "zpv-opts";

    var block = {
      slug: slug,
      title: title,
      el: wrap,
      tally: tally,
      buttons: {},
      choice: null
    };

    CHOICES.forEach(function (choice) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "zpv-opt";
      button.dataset.choice = choice.id;
      button.setAttribute("aria-pressed", "false");
      button.innerHTML =
        '<span class="zpv-opt-zh">' + choice.zh + '</span><span class="mono zpv-opt-en">' + choice.en + "</span>";
      button.addEventListener("click", function () {
        if (!identity) {
          pendingClick = { block: block, choice: choice.id };
          openIdentity(false);
          return;
        }
        select(block, choice.id);
        save(block);
      });
      opts.appendChild(button);
      block.buttons[choice.id] = button;
    });

    var note = document.createElement("textarea");
    note.className = "zpv-note";
    note.rows = 2;
    note.maxLength = 800;
    note.placeholder = "備註（選填）— 具體想改什麼，或希望在會議上釐清什麼";
    note.addEventListener("blur", function () {
      var stored = localAnswers[slug] || {};
      if (note.value.trim() === (stored.note || "")) return;
      if (!identity) {
        openIdentity(false);
        return;
      }
      save(block);
    });

    var state = document.createElement("div");
    state.className = "zpv-state";
    state.dataset.kind = "idle";
    state.textContent = "尚未回覆";

    wrap.appendChild(head);
    wrap.appendChild(opts);
    wrap.appendChild(note);
    wrap.appendChild(state);

    block.note = note;
    block.state = state;
    section.appendChild(wrap);
    return block;
  }

  function select(block, choice) {
    block.choice = choice;
    CHOICES.forEach(function (item) {
      var on = item.id === choice;
      block.buttons[item.id].classList.toggle("is-on", on);
      block.buttons[item.id].setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  /* ---------- tallies ---------- */

  function refreshTallies() {
    fetchResults().then(function (votes) {
      if (!votes) return;
      var bySection = {};
      votes.forEach(function (vote) {
        var bucket = (bySection[vote.section] = bySection[vote.section] || { agree: 0, concern: 0, hold: 0, notes: 0 });
        if (bucket[vote.choice] !== undefined) bucket[vote.choice]++;
        if (vote.note) bucket.notes++;

        if (identity && vote.voter === identity.voter && blocks[vote.section]) {
          var block = blocks[vote.section];
          if (!block.choice) {
            select(block, vote.choice);
            if (!block.note.value) block.note.value = vote.note || "";
            localAnswers[vote.section] = { choice: vote.choice, note: vote.note || "" };
            setState(block, "saved", "已送出");
          }
        }
      });
      write(LOCAL_KEY, localAnswers);
      updateProgress();

      Object.keys(blocks).forEach(function (slug) {
        var bucket = bySection[slug];
        var target = blocks[slug].tally;
        if (!bucket) {
          target.textContent = "尚無回覆";
          return;
        }
        var parts = ["同意 " + bucket.agree, "疑慮 " + bucket.concern, "保留 " + bucket.hold];
        if (bucket.notes) parts.push("備註 " + bucket.notes);
        target.textContent = parts.join(" · ");
      });
    });
  }

  /* ---------- identity ---------- */

  var pendingClick = null;
  var dialog = null;

  function buildDialog() {
    dialog = document.createElement("dialog");
    dialog.className = "zpv-dialog";
    dialog.innerHTML =
      '<form method="dialog">' +
      '<span class="mono zpv-label">開始之前 · IDENTIFY YOURSELF</span>' +
      "<h3>請留下姓名與通行碼</h3>" +
      "<p>姓名會標在你的每一則回覆旁，方便會議上直接對話。通行碼由發起人提供，只用來擋掉不相干的人。</p>" +
      '<label>姓名<input name="voter" required maxlength="40" autocomplete="name"></label>' +
      '<label>通行碼<input name="code" required maxlength="60" autocomplete="off"></label>' +
      '<div class="zpv-dialog-actions"><button value="ok" class="zpv-go">開始審閱</button></div>' +
      "</form>";
    document.body.appendChild(dialog);

    dialog.querySelector("form").addEventListener("submit", function () {
      var voter = dialog.querySelector('input[name="voter"]').value.trim();
      var code = dialog.querySelector('input[name="code"]').value.trim();
      if (!voter || !code) return;
      identity = { voter: voter, code: code };
      write(IDENTITY_KEY, identity);
      renderIdentityBar();
      flushQueue().then(refreshTallies);
      if (pendingClick) {
        select(pendingClick.block, pendingClick.choice);
        save(pendingClick.block);
        pendingClick = null;
      }
    });
  }

  function openIdentity(prefill) {
    if (!dialog) buildDialog();
    if (prefill && identity) dialog.querySelector('input[name="voter"]').value = identity.voter;
    if (typeof dialog.showModal === "function") dialog.showModal();
  }

  /* ---------- progress pill ---------- */

  var pill = null;

  function updateProgress() {
    if (!pill) return;
    var total = Object.keys(blocks).length;
    var done = Object.keys(blocks).filter(function (slug) {
      return localAnswers[slug] && localAnswers[slug].choice;
    }).length;
    pill.querySelector(".zpv-pill-count").textContent = done + " / " + total;
    pill.classList.toggle("is-done", total > 0 && done === total);
  }

  function renderIdentityBar() {
    if (!pill) return;
    var who = pill.querySelector(".zpv-pill-who");
    who.textContent = identity ? identity.voter : "尚未署名";
  }

  function buildPill() {
    pill = document.createElement("div");
    pill.className = "zpv-pill";
    pill.innerHTML =
      '<span class="mono zpv-pill-label">已回覆</span>' +
      '<span class="mono zpv-pill-count">0 / 0</span>' +
      '<span class="zpv-pill-sep"></span>' +
      '<button type="button" class="zpv-pill-who">尚未署名</button>' +
      '<a class="mono zpv-pill-link" href="results.html">彙總</a>';
    document.body.appendChild(pill);
    pill.querySelector(".zpv-pill-who").addEventListener("click", function () {
      openIdentity(true);
    });
    renderIdentityBar();
  }

  /* ---------- styles ---------- */

  function injectStyles() {
    var css = document.createElement("style");
    css.textContent = [
      ".zpv{margin-top:clamp(28px,5vw,44px);border:1px solid var(--line-300);",
      "background:var(--white);padding:clamp(16px,3.6vw,24px)}",
      ".zpv-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap}",
      ".zpv-label{color:var(--blue-800)}",
      ".zpv-tally{color:var(--ink-500);letter-spacing:.08em;text-transform:none}",
      ".zpv-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,116px),1fr));",
      "gap:8px;margin-top:16px}",
      ".zpv-opt{appearance:none;cursor:pointer;background:var(--paper-100);color:var(--ink-700);",
      "border:1px solid var(--line-300);padding:11px 12px;text-align:left;",
      "transition:background .12s linear,border-color .12s linear,color .12s linear}",
      ".zpv-opt:hover{border-color:var(--blue-600);color:var(--blue-800)}",
      ".zpv-opt:focus-visible{outline:2px solid var(--blue-600);outline-offset:2px}",
      ".zpv-opt-zh{display:block;font:700 15px/1.3 var(--font-zh);letter-spacing:.02em}",
      ".zpv-opt-en{display:block;margin-top:3px;font-size:10px;opacity:.72}",
      '.zpv-opt.is-on{background:var(--blue-800);border-color:var(--blue-800);color:var(--white)}',
      '.zpv-opt.is-on[data-choice="concern"]{background:var(--red-600);border-color:var(--red-600)}',
      '.zpv-opt.is-on[data-choice="hold"]{background:var(--ink-700);border-color:var(--ink-700)}',
      ".zpv-note{display:block;width:100%;margin-top:10px;padding:11px 12px;",
      "border:1px solid var(--line-300);background:var(--paper-050);color:var(--ink-900);",
      "font:400 14px/1.7 var(--font-zh);resize:vertical}",
      ".zpv-note:focus-visible{outline:2px solid var(--blue-600);outline-offset:-1px}",
      ".zpv-state{margin-top:10px;font:500 11px/1.5 var(--font-mono);letter-spacing:.09em;",
      "text-transform:uppercase;color:var(--ink-500)}",
      '.zpv-state[data-kind="saved"]{color:var(--blue-800)}',
      '.zpv-state[data-kind="warn"]{color:var(--red-700);text-transform:none;letter-spacing:.04em}',
      '.zpv-state[data-kind="saving"]{color:var(--ink-700)}',

      ".zpv-dialog{border:1px solid var(--blue-800);background:var(--white);color:var(--ink-900);",
      "padding:clamp(20px,4vw,32px);max-width:420px;width:calc(100% - 32px)}",
      ".zpv-dialog::backdrop{background:rgba(15,26,60,.55)}",
      ".zpv-dialog h3{font:700 22px/1.35 var(--font-zh);color:var(--blue-800);margin:12px 0 0;letter-spacing:.02em}",
      ".zpv-dialog p{font:400 14px/1.8 var(--font-zh);color:var(--ink-700);margin:10px 0 0}",
      ".zpv-dialog label{display:block;margin-top:16px;font:500 11px/1.4 var(--font-mono);",
      "letter-spacing:.1em;text-transform:uppercase;color:var(--ink-500)}",
      ".zpv-dialog input{display:block;width:100%;margin-top:6px;padding:11px 12px;",
      "border:1px solid var(--line-300);background:var(--paper-050);color:var(--ink-900);",
      "font:400 15px/1.5 var(--font-zh)}",
      ".zpv-dialog input:focus-visible{outline:2px solid var(--blue-600);outline-offset:-1px}",
      ".zpv-dialog-actions{margin-top:22px}",
      ".zpv-go{appearance:none;cursor:pointer;width:100%;border:1px solid var(--red-600);",
      "background:var(--red-600);color:var(--white);padding:13px 16px;",
      "font:700 15px/1.2 var(--font-zh);letter-spacing:.04em}",
      ".zpv-go:hover{background:var(--red-700);border-color:var(--red-700)}",

      ".zpv-pill{position:fixed;right:clamp(12px,3vw,24px);bottom:clamp(12px,3vw,24px);z-index:50;",
      "display:flex;align-items:center;gap:10px;background:var(--blue-950);color:var(--white);",
      "border:1px solid var(--blue-900);padding:9px 14px;max-width:calc(100% - 24px)}",
      ".zpv-pill-label{opacity:.62}",
      ".zpv-pill-count{font-weight:600}",
      ".zpv-pill.is-done .zpv-pill-count{color:#9DE2B4}",
      ".zpv-pill-sep{width:1px;height:15px;background:rgba(255,255,255,.24)}",
      ".zpv-pill-who{appearance:none;background:none;border:0;cursor:pointer;color:var(--white);",
      "font:400 13px/1.3 var(--font-zh);padding:0;max-width:9em;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.4)}",
      ".zpv-pill-link{color:var(--blue-300);border-bottom:1px solid rgba(185,199,238,.4);font-size:11px}",
      ".zpv-pill-link:hover{color:var(--white)}",
      "@media print{.zpv-pill{display:none}}"
    ].join("");
    document.head.appendChild(css);
  }

  /* ---------- boot ---------- */

  function init() {
    var sections = Array.prototype.slice
      .call(document.querySelectorAll("main > section, body > section"))
      .filter(function (section) {
        return section.querySelector(".h2");
      });
    if (!sections.length) return;

    injectStyles();

    sections.forEach(function (section, index) {
      var slug = slugFor(section, index);
      /* Two sections sharing an English eyebrow would otherwise collide into one vote. */
      if (blocks[slug]) slug = slug + "-" + (index + 1);
      blocks[slug] = buildBlock(section, slug, titleFor(section));
    });

    buildPill();

    Object.keys(localAnswers).forEach(function (slug) {
      var block = blocks[slug];
      var answer = localAnswers[slug];
      if (!block || !answer || !answer.choice) return;
      select(block, answer.choice);
      block.note.value = answer.note || "";
      setState(block, "saved", "已回覆");
    });

    updateProgress();

    if (!identity) {
      openIdentity(false);
    } else {
      flushQueue().then(refreshTallies);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
