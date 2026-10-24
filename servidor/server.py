#!/usr/bin/env python3
"""API de dados do Meu Treino (substitui o Firestore). Só biblioteca padrão.

Guarda documentos JSON em SQLite, organizados por coleção (workouts, sessions,
drafts, meta). Um único usuário, protegido por token.

Rotas (todas, exceto /health, exigem  Authorization: Bearer <token>):
  GET    /health
  GET    /api/c/<colecao>           lista os documentos
  DELETE /api/c/<colecao>           apaga a coleção inteira
  GET    /api/c/<colecao>/<id>      um documento
  PUT    /api/c/<colecao>/<id>      grava (cria ou substitui)
  DELETE /api/c/<colecao>/<id>      apaga
  GET    /api/export                tudo: {colecao: [docs]}
  POST   /api/import                {colecao: [docs com "id"]}  (upsert)
"""
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

DATA_DIR = os.environ.get("DATA_DIR", "./dados")
TOKEN = os.environ.get("TREINO_TOKEN", "")
ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "https://arodasi-dev.github.io").split(",") if o.strip()]
PORT = int(os.environ.get("PORT", "8787"))
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "14"))
COL_RE = re.compile(r"^[a-z_]{1,32}$")
ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
MAX_BODY = 5_000_000
STATIC_DIR = os.environ.get("STATIC_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
STATIC_RE = re.compile(r"^(index\.html|app\.js|sw\.js|manifest\.webmanifest|icon-\d+\.png|apple-touch-icon\.png)$")

if len(TOKEN) < 16:
    sys.exit("Defina TREINO_TOKEN com pelo menos 16 caracteres.")

os.makedirs(os.path.join(DATA_DIR, "backups"), exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "treino.db")
lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute("PRAGMA journal_mode=WAL")
db.execute(
    "CREATE TABLE IF NOT EXISTS docs ("
    " col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL,"
    " PRIMARY KEY (col, id))"
)
db.commit()


def backup_loop():
    """Uma cópia do banco por dia, mantendo as últimas BACKUP_KEEP."""
    while True:
        name = os.path.join(DATA_DIR, "backups", "treino-%s.db" % datetime.now().strftime("%Y%m%d"))
        if not os.path.exists(name):
            try:
                with lock:
                    dst = sqlite3.connect(name)
                    db.backup(dst)
                    dst.close()
                files = sorted(f for f in os.listdir(os.path.join(DATA_DIR, "backups")) if f.endswith(".db"))
                for old in files[:-BACKUP_KEEP]:
                    os.remove(os.path.join(DATA_DIR, "backups", old))
            except Exception as e:  # noqa: BLE001
                print("backup falhou:", e, file=sys.stderr)
        time.sleep(3600)


class H(BaseHTTPRequestHandler):
    server_version = "treino-api"

    def log_message(self, fmt, *args):  # sem tokens nem corpos nos logs
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---- utilidades ----
    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
            if self.headers.get("Access-Control-Request-Private-Network"):
                self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        if obj is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _auth(self):
        got = self.headers.get("Authorization", "")
        if not hmac.compare_digest(got.encode(), ("Bearer " + TOKEN).encode()):
            self._send(401, {"error": "nao autorizado"})
            return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            self._send(413, {"error": "corpo grande demais"})
            return None
        try:
            return json.loads(self.rfile.read(n) or b"null")
        except ValueError:
            self._send(400, {"error": "JSON invalido"})
            return None

    def _route(self):
        parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/")]
        return parts

    # ---- métodos ----
    def do_OPTIONS(self):
        self._send(204)

    def _static(self, p):
        """Serve o próprio app (só arquivos da lista; nunca o .env nem a pasta de dados)."""
        name = "index.html" if p in ([""], []) else (p[0] if len(p) == 1 else "")
        if not STATIC_RE.match(name):
            return False
        path = os.path.join(STATIC_DIR, name)
        if not os.path.isfile(path):
            return False
        with open(path, "rb") as f:
            body = f.read()
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".webmanifest": "application/manifest+json", ".png": "image/png"}[os.path.splitext(name)[1]]
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_GET(self):
        p = self._route()
        if p == ["health"]:
            return self._send(200, {"ok": True})
        if self._static(p):
            return
        if not self._auth():
            return
        if p == ["api", "export"]:
            with lock:
                rows = db.execute("SELECT col, data FROM docs ORDER BY col").fetchall()
            out = {}
            for col, data in rows:
                out.setdefault(col, []).append(json.loads(data))
            return self._send(200, out)
        if len(p) in (3, 4) and p[:2] == ["api", "c"] and COL_RE.match(p[2]):
            col = p[2]
            if len(p) == 3:
                with lock:
                    rows = db.execute("SELECT data FROM docs WHERE col=?", (col,)).fetchall()
                return self._send(200, [json.loads(r[0]) for r in rows])
            if ID_RE.match(p[3]):
                with lock:
                    row = db.execute("SELECT data FROM docs WHERE col=? AND id=?", (col, p[3])).fetchone()
                return self._send(200, json.loads(row[0])) if row else self._send(404, {"error": "nao existe"})
        self._send(404, {"error": "rota desconhecida"})

    def do_PUT(self):
        p = self._route()
        if not self._auth():
            return
        if len(p) == 4 and p[:2] == ["api", "c"] and COL_RE.match(p[2]) and ID_RE.match(p[3]):
            doc = self._body()
            if doc is None:
                return
            if not isinstance(doc, dict):
                return self._send(400, {"error": "o documento precisa ser um objeto"})
            with lock:
                db.execute(
                    "INSERT INTO docs(col,id,data,updated) VALUES(?,?,?,?) "
                    "ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                    (p[2], p[3], json.dumps(doc, ensure_ascii=False), time.time()),
                )
                db.commit()
            return self._send(200, {"ok": True})
        self._send(404, {"error": "rota desconhecida"})

    def do_POST(self):
        p = self._route()
        if not self._auth():
            return
        if p == ["api", "import"]:
            payload = self._body()
            if payload is None:
                return
            if not isinstance(payload, dict):
                return self._send(400, {"error": "esperado {colecao: [docs]}"})
            counts = {}
            with lock:
                for col, docs in payload.items():
                    if not COL_RE.match(col) or not isinstance(docs, list):
                        return self._send(400, {"error": "colecao invalida: %s" % col})
                    for d in docs:
                        if not isinstance(d, dict) or not ID_RE.match(str(d.get("id", ""))):
                            return self._send(400, {"error": "documento sem id valido em %s" % col})
                    for d in docs:
                        db.execute(
                            "INSERT INTO docs(col,id,data,updated) VALUES(?,?,?,?) "
                            "ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                            (col, str(d["id"]), json.dumps(d, ensure_ascii=False), time.time()),
                        )
                    counts[col] = len(docs)
                db.commit()
            return self._send(200, {"ok": True, "importados": counts})
        self._send(404, {"error": "rota desconhecida"})

    def do_DELETE(self):
        p = self._route()
        if not self._auth():
            return
        if len(p) in (3, 4) and p[:2] == ["api", "c"] and COL_RE.match(p[2]):
            with lock:
                if len(p) == 3:
                    db.execute("DELETE FROM docs WHERE col=?", (p[2],))
                elif ID_RE.match(p[3]):
                    db.execute("DELETE FROM docs WHERE col=? AND id=?", (p[2], p[3]))
                else:
                    return self._send(404, {"error": "rota desconhecida"})
                db.commit()
            return self._send(200, {"ok": True})
        self._send(404, {"error": "rota desconhecida"})


if __name__ == "__main__":
    threading.Thread(target=backup_loop, daemon=True).start()
    host = os.environ.get("HOST", "0.0.0.0")
    print("treino-api em %s:%d  banco: %s" % (host, PORT, DB_PATH), file=sys.stderr)
    ThreadingHTTPServer((host, PORT), H).serve_forever()
