// Cloudflare Pages Function — RSVP + Ucapan storage
// Route: /api/rsvp   (this file must live at functions/api/rsvp.js in your repo root)
// Requires a KV namespace bound as: RSVP_KV  (Pages project → Settings → Bindings → KV)

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: HEADERS });

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: HEADERS });
}

// GET /api/rsvp → { entries: [...] }  (single cheap KV read)
export async function onRequestGet({ env }) {
  if (!env.RSVP_KV) return json({ error: "RSVP_KV binding missing" }, 500);
  const all = await env.RSVP_KV.get("all");
  return json({ entries: all ? JSON.parse(all) : [] });
}

// POST /api/rsvp  body: { n, m, a }  → { ok, entries }
export async function onRequestPost({ request, env }) {
  if (!env.RSVP_KV) return json({ error: "RSVP_KV binding missing" }, 500);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid json" }, 400);

  const n = String(body.n || "").trim().slice(0, 80);
  const m = String(body.m || "").trim().slice(0, 500);
  const a = body.a === "no" ? "no" : "yes";
  const p = a === "yes" ? Math.min(3, Math.max(1, parseInt(body.p) || 1)) : 0;
  if (!n) return json({ error: "name required" }, 400);

  const entry = { n, m, a, p, t: Date.now() };

  // Each submission gets its own key — concurrent guests can never
  // overwrite each other (no read-modify-write race).
  const key = `entry:${entry.t}:${Math.random().toString(36).slice(2, 8)}`;
  await env.RSVP_KV.put(key, JSON.stringify(entry));

  // Rebuild the cached aggregate (writes are rare; reads stay one KV get).
  const entries = [];
  let cursor;
  do {
    const page = await env.RSVP_KV.list({ prefix: "entry:", cursor });
    for (const k of page.keys) {
      const v = await env.RSVP_KV.get(k.name);
      if (v) entries.push(JSON.parse(v));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  entries.sort((x, y) => y.t - x.t);
  await env.RSVP_KV.put("all", JSON.stringify(entries.slice(0, 2000)));

  // ---- Optional instant notifications (set the env vars to activate) ----
  const total = entries.length;
  const hadirPax = entries.reduce((s, e) => s + (e.a === "yes" ? e.p || 1 : 0), 0);
  const tidak = entries.filter((e) => e.a === "no").length;
  const summary =
    `RSVP baru: ${entry.n}\n` +
    `Kehadiran: ${entry.a === "yes" ? `Hadir (${entry.p} pax)` : "Tidak Hadir"}\n` +
    (entry.m ? `Ucapan: ${entry.m}\n` : "") +
    `\nJumlah setakat ini: ${total} RSVP · ${hadirPax} pax hadir · ${tidak} tidak hadir`;

  // Telegram: create a bot with @BotFather, then bind TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: summary }),
      });
    } catch (e) { /* never block the RSVP on a notification */ }
  }

  // Email via Resend (resend.com, free tier): bind RESEND_API_KEY + NOTIFY_EMAIL
  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "RSVP <onboarding@resend.dev>",
          to: [env.NOTIFY_EMAIL],
          subject: `RSVP baru: ${entry.n} (${entry.a === "yes" ? "Hadir" : "Tidak Hadir"})`,
          text: summary,
        }),
      });
    } catch (e) { /* never block the RSVP on a notification */ }
  }

  return json({ ok: true, entries });
}
