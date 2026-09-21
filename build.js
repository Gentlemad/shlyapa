/*
  Сборка чистого приложения из исходника прототипа.

  На вход: src/shlyapa.html - файл в том виде, в каком он публикуется
  артефактом (без doctype, head и body: их добавляет платформа).

  На выход: index.html - самостоятельная страница для GitHub Pages,
  без рельсы состояний и без корпуса телефона.

  Запуск: node build.js

  Обкатка: node build.js --dev --artifact --out dev.html
  Оставляет рельсу состояний: слева (на узком экране - сверху) список из
  всех экранов игры, тап по любому переносит прямо туда. Так правку видно
  за один тап, а не за партию целиком.

  Превью: node build.js --from dev --out preview.html
  Берёт исходник из указанной ветки, не трогая рабочее дерево, и кладёт
  рядом с боевой страницей. Так обкатанное и необкатанное лежат по разным
  адресам, а index.html меняется только осознанно.
*/

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
function arg(name){
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const FROM = arg("--from");
const ARTIFACT = args.indexOf("--artifact") >= 0;
// --dev оставляет рельсу состояний: по ней можно прыгнуть на любой экран,
// не проходя партию целиком. Нужна для обкатки правок, в боевую не едет.
const DEV = args.indexOf("--dev") >= 0;
const SRC = path.join(__dirname, "src", "shlyapa.html");
const OUT = path.resolve(__dirname, arg("--out") || "index.html");

const TITLE = "Шляпа";
const DESC = "Объясняйте и угадывайте собственные слова в различных форматах";

function readSource(){
  // Из ветки читаем через git: рабочее дерево при этом остаётся нетронутым
  if(FROM){
    try{
      return execFileSync("git", ["show", FROM + ":src/shlyapa.html"], {encoding:"utf8", cwd:__dirname});
    }catch(e){
      console.error("Не вышло прочитать src/shlyapa.html из ветки " + FROM);
      process.exit(1);
    }
  }
  if(!fs.existsSync(SRC)){
    console.error("Не найден исходник: " + SRC);
    process.exit(1);
  }
  return fs.readFileSync(SRC, "utf8");
}

function build(){
  const src = readSource();

  // Исходник устроен так: <title>, ссылки на шрифты, <style>...</style>, затем разметка и скрипты
  const cut = src.indexOf("</style>");
  if(cut < 0){
    console.error("В исходнике не найден блок </style>, разметка изменилась");
    process.exit(1);
  }
  const head = src.slice(0, cut + "</style>".length);
  let body = src.slice(cut + "</style>".length);

  // Рельса состояний в боевую версию не едет, но в сборке для обкатки нужна
  if(!DEV){
    const before = body.length;
    body = body.replace(/\s*<aside class="rail"[^>]*>[\s\S]*?<\/aside>/, "");
    if(body.length === before){
      console.warn("Предупреждение: блок рельсы не найден, проверьте разметку");
    }
    // Кнопка панели лежит вне <aside>, поэтому вырезается отдельно
    const beforeToggle = body.length;
    body = body.replace(/\s*<button class="railtoggle"[\s\S]*?<\/button>/, "");
    if(body.length === beforeToggle){
      console.warn("Предупреждение: кнопка панели не найдена, проверьте разметку");
    }
  }

  // Фейковая клавиатура - тоже часть корпуса прототипа. На телефоне поле
  // поднимает системную клавиатуру, и вторая поверх неё только мешает.
  const beforeKb = body.length;
  body = body.replace(/\s*<div class="kb" id="kb"><\/div>/, "");
  if(body.length === beforeKb){
    console.warn("Предупреждение: блок клавиатуры не найден, проверьте разметку");
  }

  // Сборка для обкатки ничего не отправляет: прыжки по рельсе - не партии
  if(DEV){
    const beforeDev = body.length;
    body = body.replace("var DEV_BUILD = false;", "var DEV_BUILD = true;");
    if(body.length === beforeDev){
      console.warn("Предупреждение: не найдено объявление DEV_BUILD");
    }
  }

  // Отметка сборки едет в отзывы: по ней видно, что за версия и какая сборка
  const version = (src.match(/var VERSION = "([^"]*)"/) || [])[1];
  if(!version) console.warn("Предупреждение: не найдено объявление VERSION");
  const stamp = new Date().toISOString().slice(0,16).replace("T", " ") + " UTC";
  const label = (version ? version + " · " : "") + stamp;
  const beforeStamp = body.length;
  body = body.replace('var BUILD = "dev";', 'var BUILD = ' + JSON.stringify(label) + ';');
  if(body.length === beforeStamp){
    console.warn("Предупреждение: отметка сборки не подставлена, проверьте объявление BUILD");
  }

  // Артефакт оборачивает страницу в doctype/head/body сам, поэтому отдаём
  // голый фрагмент - ровно в том виде, в каком исходник и писался.
  //
  // Режим приложения включаем принудительно: в артефакте нет ?app в адресе.
  // Но не в сборке для обкатки: body.appmode прячет рельсу, и состояния
  // становится нечем переключать. На этом уже попались один раз.
  if(ARTIFACT){
    const frag = DEV
      ? (head + "\n" + body.trim())
      : (head + "\n" + body.trim())
          .replace('if(q.indexOf("app") >= 0) document.body.classList.add("appmode");',
                   'document.body.classList.add("appmode");');
    fs.writeFileSync(OUT, frag, "utf8");
    console.log("Готово: " + path.basename(OUT) + ", " +
      (Buffer.byteLength(frag, "utf8") / 1024).toFixed(1) + " КБ (для артефакта" +
      (DEV ? ", с рельсой состояний" : "") +
      (FROM ? ", исходник из ветки " + FROM : "") + ")");
    return;
  }

  const out =
`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#FAFCFF">
<meta name="description" content="${DESC}">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta name="robots" content="noindex">
${head}
</head>
<body${DEV ? "" : ' class="appmode"'}>
${body.trim()}
</body>
</html>
`;

  fs.writeFileSync(OUT, out, "utf8");
  const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(1);
  console.log("Готово: " + path.basename(OUT) + ", " + kb + " КБ" +
    (FROM ? " (исходник из ветки " + FROM + ")" : ""));
}

build();
