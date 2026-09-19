/*
  Ретранслятор отзывов: страница -> Cloudflare Worker -> телеграм.

  Зачем нужен посредник: токен бота нельзя класть в страницу. Страница на
  GitHub Pages открыта всем, и вместе с ней открыт был бы токен, а с токеном
  любой прочитает переписку бота через getUpdates и начнёт слать тебе спам.
  Воркер держит токен у себя и наружу отдаёт только "принято".

  Переменные окружения (Settings -> Variables, все как Secret):
    BOT_TOKEN       токен от @BotFather
    CHAT_ID         куда слать; свой id можно узнать у @userinfobot
    ALLOWED_ORIGIN  https://gentlemad.github.io  (необязательно, но лучше задать)

  Разворачивание описано в worker/README.md
*/

const MAX_TEXT = 2000;
const MAX_CONTACT = 120;
const MAX_BODY = 8 * 1024;

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, cors);

    // Чужой источник отсекаем до разбора тела
    if (env.ALLOWED_ORIGIN) {
      const from = request.headers.get("origin");
      if (from && from !== env.ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403, cors);
    }

    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ error: "too large" }, 413, cors);
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: "bad json" }, 400, cors);
    }

    const text = String(body.text || "").trim().slice(0, MAX_TEXT);
    const contact = String(body.contact || "").trim().slice(0, MAX_CONTACT);
    if (text.length < 5) return json({ error: "too short" }, 400, cors);

    if (!env.BOT_TOKEN || !env.CHAT_ID) return json({ error: "not configured" }, 500, cors);

    const ctx = body.ctx && typeof body.ctx === "object" ? body.ctx : {};
    const ip = request.headers.get("cf-connecting-ip") || "";
    const country = request.cf && request.cf.country ? request.cf.country : "";

    const message =
      "<b>Отзыв о Шляпе</b>\n\n" +
      esc(text) + "\n\n" +
      (contact ? "<b>Связь:</b> " + esc(contact) + "\n" : "") +
      "<b>Экран:</b> " + esc(ctx.screen) + "\n" +
      "<b>Сборка:</b> " + esc(ctx.build) + "\n" +
      "<b>Партия:</b> " + esc(describeGame(ctx)) + "\n" +
      "<b>Устройство:</b> " + esc(ctx.viewport) + " @" + esc(ctx.dpr) +
        ", " + esc(ctx.lang) + (ctx.reducedMotion ? ", уменьшение движения" : "") +
        (ctx.standalone ? ", с домашнего экрана" : "") + "\n" +
      "<b>Браузер:</b> <code>" + esc(ctx.ua) + "</code>" +
      (country ? "\n<b>Страна:</b> " + esc(country) : "") +
      (ip ? "\n<b>IP:</b> <code>" + esc(ip) + "</code>" : "");

    const tg = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    if (!tg.ok) {
      // Наружу подробности не выносим: страница всё равно покажет общую ошибку
      console.log("telegram failed", tg.status, await tg.text());
      return json({ error: "relay failed" }, 502, cors);
    }
    return json({ ok: true }, 200, cors);
  }
};

function describeGame(ctx) {
  if (!ctx.players) return "не начата";
  const s = ctx.settings || {};
  return ctx.players + " игроков, " + ctx.words + " слов, раунд " + ctx.round +
    ", ход " + ctx.turnNo + ", в шляпе " + ctx.hatLeft +
    " (по " + s.wordsPerPlayer + " слов, " + s.turnSeconds + " с)";
}
function esc(v) {
  return String(v === undefined || v === null ? "-" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, cors)
  });
}
