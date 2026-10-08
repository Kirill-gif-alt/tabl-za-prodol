# Локальный сервер статики для аналитики (http://127.0.0.1:8765).
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
PORT = int(os.environ.get("KRASAVIA_PORT", "8765"))
SHARED_DIR = os.path.join(ROOT, "shared")
# Общие файлы, которые программа может записать через сервер (как ALLOWED_FILES в js/shared-storage.js).
# Запись через сервер не зависит от разрешения браузера на папку, которое сбрасывается при перезапуске.
SHARED_WRITABLE = {
    "profiles.json", "snapshot.json", "activity.json", "flight-comments.json",
    "subsidy-overrides.json", "pkz-nav.json", "sales-management.json", "rms-widget.json",
    "creative-layouts.json", "subsidy-fares.json",
}
MAX_BODY = 64 * 1024 * 1024
WRITE_LOCK = threading.Lock()
ALLOWED_HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Типы заданы явно: на Windows Python берёт их из реестра, и .js там бывает text/plain.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".geojson": "application/geo+json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _same_origin(self):
        # Только страница этого же сервера: чужой сайт в браузере не может записать файлы.
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {"http://" + h for h in ALLOWED_HOSTS}

    def do_GET(self):
        if self.path.split("?")[0] == "/__krasavia/caps":
            if not self._same_origin():
                return self._send_json(403, {"error": "forbidden"})
            return self._send_json(200, {"sharedWrite": os.path.isdir(SHARED_DIR) or os.access(ROOT, os.W_OK)})
        return super().do_GET()

    def do_PUT(self):
        path = self.path.split("?")[0]
        name = path[len("/shared/"):] if path.startswith("/shared/") else ""
        if not self._same_origin():
            return self._send_json(403, {"error": "forbidden"})
        if name not in SHARED_WRITABLE:
            return self._send_json(404, {"error": "not allowed"})
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self._send_json(415, {"error": "json only"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            return self._send_json(413, {"error": "bad size"})
        body = self.rfile.read(length)
        try:
            json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._send_json(400, {"error": "bad json"})
        try:
            with WRITE_LOCK:
                os.makedirs(SHARED_DIR, exist_ok=True)
                # Сначала во временный файл, потом подмена: другие ПК не прочитают недописанный файл.
                fd, tmp = tempfile.mkstemp(prefix="." + name + ".", suffix=".tmp", dir=SHARED_DIR)
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(body)
                    try:
                        os.chmod(tmp, 0o644)  # mkstemp создаёт файл только для владельца
                    except OSError:
                        pass
                    os.replace(tmp, os.path.join(SHARED_DIR, name))
                except BaseException:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
                    raise
        except OSError as e:
            return self._send_json(500, {"error": str(e)})
        return self._send_json(200, {"ok": True})

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        # Защита: не угадывать тип файла, не открывать страницу внутри чужого сайта, не отдавать адрес.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("КРАСАВИА  http://127.0.0.1:%s/" % PORT, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
