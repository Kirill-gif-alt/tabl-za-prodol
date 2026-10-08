# Локальный сервер статики для аналитики (http://127.0.0.1:8765).
from __future__ import annotations

import json
import os
import re
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
# Резервные копии перед перезаписью: shared/_history/<имя>/<имя>__ГГГГ-ММ-ДД_ЧЧ-ММ-СС.json.
# every — не чаще раза в столько секунд, keep — сколько последних копий хранить.
# Такая же политика в js/shared-storage.js (HISTORY_POLICY) для записи без сервера.
HISTORY_DIR = os.path.join(SHARED_DIR, "_history")
HISTORY_POLICY = {
    "snapshot.json": (6 * 3600, 4),
    "profiles.json": (600, 30),
    "sales-management.json": (3600, 24),
    "subsidy-overrides.json": (600, 30),
    "subsidy-fares.json": (600, 30),
    "pkz-nav.json": (600, 30),
    "flight-comments.json": (3600, 24),
    "creative-layouts.json": (3600, 20),
}
# Архив продаж (js/sales-archive.js): shared/history/curves-ГГГГ-ММ.json и slices-ГГГГ-ММ.json.
ARCHIVE_RE = re.compile(r"^history/(curves|slices)-\d{4}-\d{2}\.json$")
# Отметки «Управления продажами»: свой файл у каждого автора (js/sales-management.js).
MARKS_RE = re.compile(r"^sales-marks/\d{4}-\d{2}/[a-z0-9_]{1,40}\.json$")
MARKS_DIR_RE = re.compile(r"^sales-marks/\d{4}-\d{2}$")
MAX_BODY = 64 * 1024 * 1024
WRITE_LOCK = threading.Lock()
ALLOWED_HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}


def _history_versions(name):
    base = name[:-5]
    folder = os.path.join(HISTORY_DIR, base)
    if not os.path.isdir(folder):
        return folder, []
    items = []
    for fn in os.listdir(folder):
        if fn.startswith(base + "__") and fn.endswith(".json"):
            full = os.path.join(folder, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            items.append((fn, st.st_size, st.st_mtime))
    items.sort(key=lambda x: x[0], reverse=True)
    return folder, items


def backup_if_due(name, force=False):
    """Копия текущей версии файла перед перезаписью. Ошибка копии не мешает записи."""
    policy = HISTORY_POLICY.get(name)
    target = os.path.join(SHARED_DIR, name)
    if not policy or not os.path.isfile(target):
        return
    every, keep = policy
    try:
        import shutil
        import time
        folder, items = _history_versions(name)
        if items and not force and time.time() - items[0][2] < every:
            return
        os.makedirs(folder, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(os.path.getmtime(target)))
        dest = os.path.join(folder, "%s__%s.json" % (name[:-5], stamp))
        if not os.path.exists(dest):
            shutil.copy2(target, dest)
            os.utime(dest)  # время копии — для интервала; время версии — в имени
        _, items = _history_versions(name)
        for fn, _, _ in items[keep:]:
            try:
                os.remove(os.path.join(folder, fn))
            except OSError:
                pass
    except OSError as e:
        sys.stderr.write("backup %s: %s\n" % (name, e))


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
            return self._send_json(200, {"sharedWrite": os.path.isdir(SHARED_DIR) or os.access(ROOT, os.W_OK), "history": True})
        if self.path.split("?")[0] == "/__krasavia/history":
            if not self._same_origin():
                return self._send_json(403, {"error": "forbidden"})
            out = {}
            for name in HISTORY_POLICY:
                _, items = _history_versions(name)
                out[name] = [{"id": fn, "size": size} for fn, size, _ in items]
            return self._send_json(200, {"files": out})
        if self.path.split("?")[0] == "/__krasavia/list":
            if not self._same_origin():
                return self._send_json(403, {"error": "forbidden"})
            from urllib.parse import parse_qs, urlparse
            folder = (parse_qs(urlparse(self.path).query).get("dir") or [""])[0]
            if not MARKS_DIR_RE.match(folder):
                return self._send_json(404, {"error": "not allowed"})
            full = os.path.join(SHARED_DIR, *folder.split("/"))
            names = []
            if os.path.isdir(full):
                names = sorted(n for n in os.listdir(full) if re.match(r"^[a-z0-9_]{1,40}\.json$", n))
            return self._send_json(200, {"files": names})
        return super().do_GET()

    def do_PUT(self):
        path = self.path.split("?")[0]
        name = path[len("/shared/"):] if path.startswith("/shared/") else ""
        if not self._same_origin():
            return self._send_json(403, {"error": "forbidden"})
        if name not in SHARED_WRITABLE and not ARCHIVE_RE.match(name) and not MARKS_RE.match(name):
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
                backup_if_due(name, self.headers.get("X-Krasavia-Backup") == "force")
                # Сначала во временный файл, потом подмена: другие ПК не прочитают недописанный файл.
                target = os.path.join(SHARED_DIR, *name.split("/"))
                target_dir = os.path.dirname(target)
                os.makedirs(target_dir, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(target) + ".", suffix=".tmp", dir=target_dir)
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(body)
                    try:
                        os.chmod(tmp, 0o644)  # mkstemp создаёт файл только для владельца
                    except OSError:
                        pass
                    os.replace(tmp, target)
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
