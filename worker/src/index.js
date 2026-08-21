/* ZIPA POKER design review — vote collector.
   Three endpoints, one table, one shared passphrase. Everything the review page
   needs and nothing it does not: no accounts, no cookies, no third party. */

const CHOICES = new Set(["agree", "concern", "hold"]);
const MAX_VOTER = 40;
const MAX_NOTE = 800;
const SECTION_RE = /^[a-z0-9-]{1,48}$/;

const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(origin) },
  });

const cors = (origin) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-review-code",
  "access-control-max-age": "86400",
  "vary": "origin",
});

/* Constant-time enough for a short shared passphrase over the public internet. */
function codeMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorised(request, url, env) {
  const given = request.headers.get("x-review-code") || url.searchParams.get("code") || "";
  return codeMatches(given.trim(), (env.REVIEW_CODE || "").trim());
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    if (url.pathname === "/health") return json({ ok: true }, 200, origin);

    if (!env.REVIEW_CODE) return json({ error: "server_not_configured" }, 500, origin);
    if (!authorised(request, url, env)) return json({ error: "bad_code" }, 401, origin);

    if (request.method === "POST" && url.pathname === "/vote") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_json" }, 400, origin);
      }

      const voter = String(body.voter || "").trim().slice(0, MAX_VOTER);
      const section = String(body.section || "").trim();
      const choice = String(body.choice || "").trim();
      const note = String(body.note || "").trim().slice(0, MAX_NOTE);

      if (!voter) return json({ error: "no_voter" }, 400, origin);
      if (!SECTION_RE.test(section)) return json({ error: "bad_section" }, 400, origin);
      if (!CHOICES.has(choice)) return json({ error: "bad_choice" }, 400, origin);

      await env.DB.prepare(
        `INSERT INTO votes (voter, section, choice, note, updated)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (voter, section) DO UPDATE
           SET choice = excluded.choice, note = excluded.note, updated = excluded.updated`
      )
        .bind(voter, section, choice, note, new Date().toISOString())
        .run();

      return json({ ok: true }, 200, origin);
    }

    if (request.method === "GET" && (url.pathname === "/results" || url.pathname === "/results.csv")) {
      const { results } = await env.DB.prepare(
        `SELECT voter, section, choice, note, updated FROM votes ORDER BY section, voter`
      ).all();

      if (url.pathname === "/results.csv") {
        const header = "section,voter,choice,note,updated";
        const rows = results.map((r) =>
          [r.section, r.voter, r.choice, r.note, r.updated].map(csvCell).join(",")
        );
        return new Response("﻿" + [header, ...rows].join("\r\n"), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="zipa-review-votes.csv"',
            ...cors(origin),
          },
        });
      }

      return json({ votes: results }, 200, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  },
};
