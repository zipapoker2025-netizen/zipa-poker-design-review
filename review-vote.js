/* ZIPA POKER — 審閱表態元件 / review vote widget.
   Attaches a 同意 / 有疑慮 / 先保留 control plus a note field to each thing worth a position,
   and posts every answer to the Cloudflare Worker named in review-config.js.

   Two granularities, because the page mixes them: each decision card in the 待拍板決議 section
   gets its own control (D01…D12 are what the meeting actually runs through), and every other
   section gets one for the section as a whole.

   Styling borrows the host page's own tokens with fallbacks, so the widget follows whichever
   design system it lands in — including that page's dark mode — rather than importing a second
   palette on top of it. Degrades to local-only storage when the Worker is unreachable. */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="review-vote.js"]');
  var API = ((script && script.dataset.api) || window.ZP_REVIEW_API || "").replace(/\/+$/, "");
  if (/YOUR-SUBDOMAIN/.test(API)) API = "";
  var IDENTITY_KEY = "zp-review-identity";
  var PENDING_KEY = "zp-review-pending";
  var LOCAL_KEY = "zp-review-local";

  /* Sections that exist to be read, not voted on: a snapshot of where things stand, and
     (should it return) a bibliography. Neither is a position anyone can take. */
  var SKIP_SECTIONS = { overview: true, sources: true };
  /* Voted card by card instead, one control per decision. */
  var CARD_SECTIONS = { decisions: true };

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

  /* ---------- ids ----------
     A section's own id is the stable handle when it has one. Otherwise fall back to the English
     half of the eyebrow ("色彩 · COLOUR" → colour), which survives the Chinese headline being
     rewritten between drafts. Either way the id must outlive edits to the prose, or answers
     already collected orphan themselves. */

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
  }

  function sectionSlug(section, index) {
    if (section.id && /^[A-Za-z0-9_-]+$/.test(section.id)) return slugify(section.id);
    var eyebrow = section.querySelector(".eyebrow");
    return slugify(eyebrow ? eyebrow.textContent.split("·").pop() : "") || "section-" + (index + 1);
  }

  function sectionTitle(section) {
    var heading = section.querySelector(".h2, h2");
    return heading ? heading.textContent.trim() : "";
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

  function buildBlock(host, slug, title, scale) {
    var wrap = document.createElement("div");
    wrap.className = "zpv" + (scale === "card" ? " zpv-card" : "");
    wrap.dataset.section = slug;

    var head = document.createElement("div");
    head.className = "zpv-head";
    var label = document.createElement("span");
    label.className = "zpv-label";
    label.textContent = scale === "card" ? "這條你的立場" : "這一節你的立場";
    var tally = document.createElement("span");
    tally.className = "zpv-tally";
    head.appendChild(label);
    head.appendChild(tally);

    var opts = document.createElement("div");
    opts.className = "zpv-opts";

    var block = { slug: slug, title: title, el: wrap, tally: tally, buttons: {}, choice: null };

    CHOICES.forEach(function (choice) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "zpv-opt";
      button.dataset.choice = choice.id;
      button.setAttribute("aria-pressed", "false");
      button.innerHTML =
        '<span class="zpv-opt-zh">' + choice.zh + '</span><span class="zpv-opt-en">' + choice.en + "</span>";
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
    host.appendChild(wrap);
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
      '<span class="zpv-label">開始之前 · IDENTIFY YOURSELF</span>' +
      "<h3>請留下姓名與通行碼</h3>" +
      "<p>姓名會標在你的每一則回覆旁，方便會議上直接對話。通行碼由發起人提供，只用來擋掉不相干的人。</p>" +
      '<label>姓名<input name="voter" required maxlength="40" autocomplete="name"></label>' +
      '<label>通行碼<input name="code" required maxlength="60" autocomplete="off"></label>' +
      '<div class="zpv-dialog-actions"><button value="ok" class="zpv-go">開始</button></div>' +
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
    pill.querySelector(".zpv-pill-who").textContent = identity ? identity.voter : "尚未署名";
  }

  function buildPill() {
    pill = document.createElement("div");
    pill.className = "zpv-pill";
    pill.innerHTML =
      '<span class="zpv-pill-label">已回覆</span>' +
      '<span class="zpv-pill-count">0 / 0</span>' +
      '<span class="zpv-pill-sep"></span>' +
      '<button type="button" class="zpv-pill-who">尚未署名</button>' +
      '<a class="zpv-pill-link" href="results.html">彙總</a>';
    document.body.appendChild(pill);
    pill.querySelector(".zpv-pill-who").addEventListener("click", function () {
      openIdentity(true);
    });
    renderIdentityBar();
  }

  /* ---------- styles ----------
     Every colour is `var(--host-token, var(--1a-token, #literal))`: the page's own palette first,
     the review page's palette second, a literal last. That is what lets one widget sit correctly
     in both documents, and follow the host into dark mode without knowing the mode exists. */

  function injectStyles() {
    var ink = "var(--ink,var(--ink-900,#101418))";
    var soft = "var(--ink-soft,var(--ink-500,#5C6169))";
    var line = "var(--line,var(--line-300,#D9DBD6))";
    var surface = "var(--surface,var(--white,#FFFFFF))";
    var surface2 = "var(--surface-2,var(--paper-100,#F2F2EE))";
    var paper = "var(--paper,var(--paper-050,#F5F6F4))";
    var accent = "var(--accent,var(--blue-800,#1B3A8C))";
    var accentFill = "var(--accent-fill,var(--blue-800,#1B3A8C))";
    var onAccent = "var(--on-accent,#FFFFFF)";
    var dangerFill = "var(--danger-fill,var(--red-600,#C6402E))";
    var onDanger = "var(--on-danger,#FFFFFF)";
    var zh = 'var(--font-zh,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif)';
    var mono = 'var(--font-mono,"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace)';

    var css = document.createElement("style");
    css.textContent = [
      ".zpv{margin:22px 0 4px;border:1px solid " + line + ";border-radius:2px;",
      "background:" + surface + ";padding:16px 18px;font-family:" + zh + "}",
      ".zpv-card{margin:14px 0 2px;background:" + paper + "}",
      ".zpv-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".zpv-label{font:500 11px/1.4 " + mono + ";letter-spacing:.12em;text-transform:uppercase;color:" + accent + "}",
      ".zpv-tally{font:500 11px/1.4 " + mono + ";letter-spacing:.06em;color:" + soft + "}",
      ".zpv-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,112px),1fr));gap:8px;margin-top:14px}",
      ".zpv-opt{appearance:none;cursor:pointer;border-radius:2px;background:" + surface2 + ";color:" + soft + ";",
      "border:1px solid " + line + ";padding:10px 12px;text-align:left;font-family:" + zh + ";",
      "transition:background .12s linear,border-color .12s linear,color .12s linear}",
      ".zpv-opt:hover{border-color:" + accent + ";color:" + accent + "}",
      ".zpv-opt:focus-visible{outline:2px solid " + accent + ";outline-offset:2px}",
      ".zpv-opt-zh{display:block;font:700 15px/1.3 " + zh + ";letter-spacing:.02em}",
      ".zpv-opt-en{display:block;margin-top:2px;font:500 10px/1.4 " + mono + ";letter-spacing:.1em;opacity:.7}",
      ".zpv-opt.is-on{background:" + accentFill + ";border-color:" + accentFill + ";color:" + onAccent + "}",
      '.zpv-opt.is-on[data-choice="concern"]{background:' + dangerFill + ";border-color:" + dangerFill + ";color:" + onDanger + "}",
      '.zpv-opt.is-on[data-choice="hold"]{background:' + soft + ";border-color:" + soft + ";color:" + surface + "}",
      ".zpv-note{display:block;width:100%;margin-top:10px;padding:10px 12px;border-radius:2px;",
      "border:1px solid " + line + ";background:" + paper + ";color:" + ink + ";",
      "font:400 14px/1.7 " + zh + ";resize:vertical}",
      ".zpv-note:focus-visible{outline:2px solid " + accent + ";outline-offset:-1px}",
      ".zpv-state{margin-top:9px;font:500 11px/1.5 " + mono + ";letter-spacing:.08em;text-transform:uppercase;color:" + soft + "}",
      '.zpv-state[data-kind="saved"]{color:' + accent + "}",
      '.zpv-state[data-kind="warn"]{color:' + dangerFill + ";text-transform:none;letter-spacing:.02em}",
      '.zpv-state[data-kind="saving"]{color:' + soft + "}",

      ".zpv-dialog{border:1px solid " + accent + ";border-radius:2px;background:" + surface + ";color:" + ink + ";",
      "padding:26px;max-width:420px;width:calc(100% - 32px);font-family:" + zh + "}",
      ".zpv-dialog::backdrop{background:rgba(13,17,29,.6)}",
      ".zpv-dialog h3{font:700 21px/1.35 " + zh + ";color:" + accent + ";margin:12px 0 0;letter-spacing:.02em}",
      ".zpv-dialog p{font:400 14px/1.8 " + zh + ";color:" + soft + ";margin:10px 0 0}",
      ".zpv-dialog label{display:block;margin-top:16px;font:500 11px/1.4 " + mono + ";",
      "letter-spacing:.1em;text-transform:uppercase;color:" + soft + "}",
      ".zpv-dialog input{display:block;width:100%;margin-top:6px;padding:11px 12px;border-radius:2px;",
      "border:1px solid " + line + ";background:" + paper + ";color:" + ink + ";font:400 15px/1.5 " + zh + "}",
      ".zpv-dialog input:focus-visible{outline:2px solid " + accent + ";outline-offset:-1px}",
      ".zpv-dialog-actions{margin-top:22px}",
      ".zpv-go{appearance:none;cursor:pointer;width:100%;border-radius:2px;border:1px solid " + dangerFill + ";",
      "background:" + dangerFill + ";color:" + onDanger + ";padding:13px 16px;font:700 15px/1.2 " + zh + ";letter-spacing:.04em}",

      ".zpv-pill{position:fixed;right:16px;bottom:16px;z-index:60;display:flex;align-items:center;gap:10px;",
      "background:" + accentFill + ";color:" + onAccent + ";border:1px solid " + accentFill + ";border-radius:2px;",
      "padding:8px 13px;max-width:calc(100% - 32px);font-family:" + zh + "}",
      ".zpv-pill-label{font:500 11px/1.3 " + mono + ";letter-spacing:.12em;text-transform:uppercase;opacity:.7}",
      ".zpv-pill-count{font:600 12px/1.3 " + mono + ";letter-spacing:.06em}",
      ".zpv-pill-sep{width:1px;height:14px;background:currentColor;opacity:.3}",
      ".zpv-pill-who{appearance:none;background:none;border:0;cursor:pointer;color:inherit;font:400 13px/1.3 " + zh + ";",
      "padding:0;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      "border-bottom:1px solid currentColor}",
      ".zpv-pill-link{color:inherit;opacity:.85;font:500 11px/1.3 " + mono + ";letter-spacing:.1em;",
      "text-transform:uppercase;text-decoration:none;border-bottom:1px solid currentColor}",
      ".zpv-pill-link:hover{opacity:1}",
      "@media print{.zpv-pill{display:none}}",
      /* On a phone the three options belong on one row; the English caption is the part
         that can go, not the layout. */
      "@media (max-width:480px){",
      ".zpv{padding:13px 14px;margin:18px 0 4px}",
      ".zpv-card{margin:12px 0 2px}",
      ".zpv-opts{grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px}",
      ".zpv-opt{padding:9px 6px;text-align:center}",
      ".zpv-opt-zh{font-size:14px}",
      ".zpv-opt-en{display:none}",
      ".zpv-note{font-size:13.5px}",
      ".zpv-pill{right:10px;bottom:10px;padding:7px 10px;gap:8px}",
      ".zpv-pill-label{display:none}",
      "}"
    ].join("");
    document.head.appendChild(css);
  }

  /* ---------- boot ---------- */

  function claim(slug, index) {
    /* Two hosts sharing an id would otherwise collide into a single vote. */
    return blocks[slug] ? slug + "-" + (index + 1) : slug;
  }

  function init() {
    var sections = Array.prototype.slice
      .call(document.querySelectorAll(".wrap > section, main > section, body > section"))
      .filter(function (section) {
        return section.querySelector(".h2, h2");
      });
    if (!sections.length) return;

    injectStyles();

    sections.forEach(function (section, index) {
      var slug = sectionSlug(section, index);
      if (SKIP_SECTIONS[slug]) return;

      if (CARD_SECTIONS[slug]) {
        Array.prototype.slice.call(section.querySelectorAll(".dcard")).forEach(function (card, cardIndex) {
          var code = card.querySelector(".dcode");
          var title = card.querySelector(".dtitle");
          var cardSlug = claim(slugify(slug + "-" + (code ? code.textContent : cardIndex + 1)), cardIndex);
          blocks[cardSlug] = buildBlock(card, cardSlug, title ? title.textContent.trim() : cardSlug, "card");
        });
        return;
      }

      var sectionKey = claim(slug, index);
      blocks[sectionKey] = buildBlock(section, sectionKey, sectionTitle(section), "section");
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
