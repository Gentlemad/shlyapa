/*
  Сборка чистого приложения из исходника прототипа.

  На вход: src/shlyapa.html - файл в том виде, в каком он публикуется
  артефактом (без doctype, head и body: их добавляет платформа).

  На выход: index.html - самостоятельная страница для GitHub Pages,
  без рельсы состояний и без корпуса телефона.

  Запуск: node build.js

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
const SRC = path.join(__dirname, "src", "shlyapa.html");
const OUT = path.join(__dirname, arg("--out") || "index.html");

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

  // Рельса состояний в боевую версию не едет
  const before = body.length;
  body = body.replace(/\s*<aside class="rail">[\s\S]*?<\/aside>/, "");
  if(body.length === before){
    console.warn("Предупреждение: блок рельсы не найден, проверьте разметку");
  }

  // Фейковая клавиатура - тоже часть корпуса прототипа. На телефоне поле
  // поднимает системную клавиатуру, и вторая поверх неё только мешает.
  const beforeKb = body.length;
  body = body.replace(/\s*<div class="kb" id="kb"><\/div>/, "");
  if(body.length === beforeKb){
    console.warn("Предупреждение: блок клавиатуры не найден, проверьте разметку");
  }

  // Отметка сборки едет в отзывы: по ней видно, на какой версии словили баг
  const stamp = new Date().toISOString().slice(0,16).replace("T", " ") + " UTC";
  const beforeStamp = body.length;
  body = body.replace('var BUILD = "dev";', 'var BUILD = ' + JSON.stringify(stamp) + ';');
  if(body.length === beforeStamp){
    console.warn("Предупреждение: отметка сборки не подставлена, проверьте объявление BUILD");
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
<body class="appmode">
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
