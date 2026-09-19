/*
  Приёмник обратной связи и событий: страница -> Cloudflare Worker -> дальше.

  Два маршрута, потому что у них разные адресаты и разный объём:
    POST /      отзыв человека -> телеграм. Их единицы, их читают глазами.
    POST /e     события приложения -> база D1. Их тысячи, их читают запросом.

  Зачем нужен посредник для отзывов: токен бота нельзя класть в страницу.
  Страница на GitHub Pages открыта всем, и вместе с ней открыт был бы токен,
  а с токеном любой прочитает переписку бота через getUpdates и начнёт слать
  тебе спам. Воркер держит токен у себя и наружу отдаёт только "принято".

  Переменные окружения (Settings -> Variables, все как Secret):
    BOT_TOKEN       токен от @BotFather
    CHAT_ID         куда слать; свой id можно узнать у @userinfobot
    ALLOWED_ORIGIN  https://gentlemad.github.io  (необязательно, но лучше задать)

  Привязка базы (Settings -> Bindings -> D1 database):
    DB              база shlyapa-analytics

  Без привязки DB маршрут /e честно отвечает ошибкой, а отзывы продолжают
  работать: одно не должно ронять другое.

  Разворачивание описано в worker/README.md
*/

const MAX_TEXT = 2000;
const MAX_CONTACT = 120;
const MAX_BODY = 8 * 1024;

// Событий в одной пачке и вес всей пачки. Страница шлёт по 120 штук,
// запас нужен на случай, когда буфер догоняет после долгого офлайна.
const MAX_EVENTS = 250;
const MAX_EVENTS_BODY = 256 * 1024;
const MAX_NAME = 40;
const MAX_PROPS = 4 * 1024;

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

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path === "/e") return events(request, env, cors);

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
    const rate = Number(body.rate) >= 1 && Number(body.rate) <= 5 ? Number(body.rate) : 0;
    const kind = String(body.kind || "").trim().slice(0, 40);

    // Оценки или категории достаточно: человек не обязан писать текст
    if (!text && !rate && !kind) return json({ error: "empty" }, 400, cors);
    if (text && text.length < 5) return json({ error: "too short" }, 400, cors);

    if (!env.BOT_TOKEN || !env.CHAT_ID) return json({ error: "not configured" }, 500, cors);

    const ctx = body.ctx && typeof body.ctx === "object" ? body.ctx : {};

    /* IP и страну сознательно не берём, хотя Cloudflare их подаёт: форма
       перечисляет пользователю, что именно уходит с отзывом, и этого там нет.
       Добавлять сюда поля, не названные в форме, нельзя. */

    const FACES = ["", "\uD83D\uDE21", "\uD83D\uDE41", "\uD83D\uDE10", "\uD83D\uDE42", "\uD83E\uDD29"];
    const head = [rate ? FACES[rate] + " " + rate + "/5" : "", kind ? esc(kind) : ""]
      .filter(Boolean).join(" · ");

    const message =
      "<b>Отзыв о Шляпе</b>" + (head ? "\n" + head : "") + "\n\n" +
      (text ? esc(text) + "\n\n" : "") +
      (contact ? "<b>Связь:</b> " + esc(contact) + "\n" : "") +
      "<b>Экран:</b> " + esc(ctx.screen) + "\n" +
      "<b>Сборка:</b> " + esc(ctx.build) + "\n" +
      "<b>Партия:</b> " + esc(describeGame(ctx)) + "\n" +
      "<b>Устройство:</b> " + esc(ctx.viewport) + " @" + esc(ctx.dpr) +
        ", " + esc(ctx.lang) + (ctx.reducedMotion ? ", уменьшение движения" : "") +
        (ctx.standalone ? ", с домашнего экрана" : "") + "\n" +
      "<b>Браузер:</b> <code>" + esc(ctx.ua) + "</code>";

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

/* ---------- события ----------
   Пишем как есть, без разбора: смысл событий живёт в запросах к базе, а не
   здесь. Задача воркера - не пустить внутрь мусор и не дать засыпать базу
   одной вкладкой. Поэтому режем по числу, размеру и длине полей. */
async function events(request, env, cors) {
  if (!env.DB) return json({ error: "no database" }, 500, cors);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_EVENTS_BODY) return json({ error: "too large" }, 413, cors);
    body = JSON.parse(raw);
  } catch (e) {
    return json({ error: "bad json" }, 400, cors);
  }

  const install = String(body.install || "").trim().slice(0, 64);
  if (!install) return json({ error: "no install" }, 400, cors);

  const list = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  if (!list.length) return json({ error: "empty" }, 400, cors);

  const sit = String(body.sit || "").trim().slice(0, 64);
  const build = String(body.build || "").trim().slice(0, 40);
  const ua = String(body.ua || "").trim().slice(0, 400);
  const got = Date.now();

  const stmt = env.DB.prepare(
    "INSERT INTO events (at, got, install, sit, game, name, props, build, ua) VALUES (?,?,?,?,?,?,?,?,?)"
  );

  const rows = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const name = String(e.n || "").trim().slice(0, MAX_NAME);
    if (!name) continue;
    // Время события берём с устройства, но не пускаем в него мусор:
    // сломанные часы не должны утащить строку на тридцать лет назад
    let at = Number(e.at);
    if (!isFinite(at) || at < 1600000000000 || at > got + 86400000) at = got;
    let props = "{}";
    try { props = JSON.stringify(e.p || {}).slice(0, MAX_PROPS); } catch (err) {}
    rows.push(stmt.bind(at, got, install, sit, String(e.g || "").slice(0, 64), name, props, build, ua));
  }
  if (!rows.length) return json({ error: "empty" }, 400, cors);

  try {
    await env.DB.batch(rows);
  } catch (err) {
    console.log("d1 failed", String(err));
    return json({ error: "store failed" }, 502, cors);
  }
  return json({ ok: true, n: rows.length }, 200, cors);
}

function describeGame(ctx) {
  if (!ctx.players) return "не начата";
  const s = ctx.settings || {};
  return num(ctx.players, "игрок", "игрока", "игроков") + ", " +
    num(ctx.words, "слово", "слова", "слов") + ", раунд " + ctx.round +
    ", ход " + ctx.turnNo + ", в шляпе " + ctx.hatLeft +
    " (по " + num(s.wordsPerPlayer, "слову", "слова", "слов") +
    ", " + s.turnSeconds + " с)";
}
/* Те же правила склонения, что и в приложении */
function num(n, a, b, c) {
  const x = Math.abs(Number(n)) % 100, y = x % 10;
  const word = (x > 10 && x < 20) ? c : (y > 1 && y < 5) ? b : (y === 1) ? a : c;
  return n + " " + word;
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
