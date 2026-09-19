# Приёмник отзывов и событий

Форма отзыва на странице не умеет писать в телеграм напрямую: для этого нужен
токен бота, а всё, что попало в страницу, открыто всем. С украденным токеном
читают переписку бота через `getUpdates` и шлют спам в чат. Поэтому между
страницей и телеграмом стоит воркер: токен лежит у него, наружу он отдаёт
только «принято».

Тот же воркер принимает события приложения и складывает их в базу D1.
Разделение простое: отзывы читают глазами в телеграме, событий тысячи и их
читают запросом к базе.

Бесплатного тарифа Cloudflare хватает с большим запасом: 100 тысяч запросов в
сутки против десятков отзывов и сотен событий.

## Что понадобится

- бот от [@BotFather](https://t.me/BotFather) и его токен;
- свой числовой id — его скажет [@userinfobot](https://t.me/userinfobot);
- аккаунт на [dash.cloudflare.com](https://dash.cloudflare.com), бесплатный.

Боту нужно один раз написать `/start`, иначе телеграм не даст ему прислать
первое сообщение.

## Разворачивание через веб-панель

1. В панели Cloudflare: **Workers & Pages** → **Create** → **Create Worker**.
   Имя любое, например `shlyapa-feedback`. Нажать **Deploy** — развернётся
   заготовка.
2. **Edit code**, вставить содержимое `worker/feedback.js` вместо заготовки,
   **Deploy**.
3. **Settings** → **Variables and Secrets** → добавить три штуки, все типом
   **Secret**:

   | Имя | Значение |
   |---|---|
   | `BOT_TOKEN` | токен от BotFather |
   | `CHAT_ID` | числовой id из userinfobot |
   | `ALLOWED_ORIGIN` | `https://gentlemad.github.io` |

   `ALLOWED_ORIGIN` необязателен, но с ним воркер откажет чужим страницам,
   которые попробуют слать отзывы от твоего имени.
3a. **Settings** → **Bindings** → **Add** → **D1 database**. Имя переменной
   `DB`, база `shlyapa-analytics`. Без этой привязки маршрут `/e` отвечает
   ошибкой, а отзывы продолжают работать: одно не роняет другое.
3b. Если нужна копия событий в PostHog — добавить ещё два секрета:

   | Имя | Значение |
   |---|---|
   | `POSTHOG_KEY` | project API key из настроек проекта PostHog |
   | `POSTHOG_HOST` | `https://eu.i.posthog.com`, можно не задавать |

   Пересылает воркер, а не страница. Так телефон разговаривает только с
   нами: если у игрока PostHog недоступен, события всё равно долетят,
   потому что пересылка идёт с нашей стороны. Без `POSTHOG_KEY` копия
   просто не отправляется, на базу это не влияет.
4. Скопировать адрес воркера, он вида
   `https://shlyapa-feedback.<аккаунт>.workers.dev`.

## Подключение к приложению

В `src/shlyapa.html` заполнить две константы:

```js
var FEEDBACK_URL = "https://shlyapa-feedback.<аккаунт>.workers.dev";
var TELEGRAM_URL = "https://t.me/<логин>";
```

Затем `node build.js` и коммит. Пока `FEEDBACK_URL` пуст, форма не
показывается и остаётся только ссылка в телеграм; пока пусты обе, вход в
обратную связь скрыт целиком.

## Проверка

```bash
curl -i -X POST https://shlyapa-feedback.<аккаунт>.workers.dev \
  -H 'content-type: application/json' \
  -H 'origin: https://gentlemad.github.io' \
  -d '{"text":"проверка связи","ctx":{"build":"local","screen":"home"}}'
```

Ожидается `200` и `{"ok":true}`, а в телеграме — сообщение. Коды: `400` —
слишком короткий текст или битый JSON, `403` — origin не совпал с
`ALLOWED_ORIGIN`, `500` — не заданы `BOT_TOKEN` или `CHAT_ID`, `502` —
телеграм отказал, подробности в логах воркера.

## Чего здесь нет

Ограничения частоты по IP нет: на бесплатном тарифе для этого нужен KV или
Durable Object, а для игры, которой пользуются друзья, овчинка выделки не
стоит. Защита сейчас такая: ловушка для ботов в форме, минимальная и
максимальная длина текста, предел размера тела запроса, пауза в 30 секунд
между отправками на стороне страницы и проверка origin. Если отзывы всё же
начнут заваливать спамом, самое дешёвое — включить в Cloudflare правило
Rate Limiting на маршрут воркера, это настройка в панели, а не код.


## База событий

Создана как `shlyapa-analytics`, одна таблица:

```sql
CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,  -- когда случилось, часы устройства
  got     INTEGER NOT NULL,  -- когда приняли, часы сервера
  install TEXT NOT NULL,     -- устройство
  sit     TEXT,              -- посиделка: партии подряд за один вечер
  game    TEXT,              -- партия
  name    TEXT NOT NULL,     -- имя события
  props   TEXT,              -- остальное, JSON
  build   TEXT,
  ua      TEXT
);
```

`props` лежит текстом нарочно: набор полей у событий разный и будет меняться,
а заводить колонку под каждое новое поле дороже, чем разбирать JSON в запросе.
SQLite это умеет:

```sql
-- сколько партий в посиделке, и на какой останавливаются
SELECT sit, COUNT(*) AS games
FROM events WHERE name = 'game_finished'
GROUP BY sit ORDER BY games DESC;

-- сорванные свайпы по раундам: гипотеза про второй раунд
SELECT json_extract(props,'$.round') AS round, COUNT(*) AS aborted
FROM events WHERE name = 'swipe_aborted' GROUP BY round;

-- сколько держали оверлей границы раунда
SELECT json_extract(props,'$.ms') AS ms FROM events
WHERE name = 'boundary_resumed' ORDER BY ms;
```

Дамп руками: **Workers & Pages** → **D1** → `shlyapa-analytics` → вкладка
**Console**.
