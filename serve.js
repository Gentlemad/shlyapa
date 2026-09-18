/* Локальный статический сервер для проверки сборки. Запуск: node serve.js */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const TYPES = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon"
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if(p === "/" || p === "") p = "/index.html";
  const file = path.join(ROOT, p);
  if(!file.startsWith(ROOT)){ res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if(err){ res.writeHead(404, {"content-type":"text/plain; charset=utf-8"}).end("не найдено"); return; }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}).listen(PORT, () => console.log("Шляпа на http://localhost:" + PORT));
