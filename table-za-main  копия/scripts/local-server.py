# Локальный сервер статики для аналитики (http://127.0.0.1:8765).
from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import uuid
import urllib.error
import urllib.request
from urllib.parse import unquote, urlparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
PORT = int(os.environ.get("KRASAVIA_PORT", "8765"))
SHARED_DIR = os.path.join(ROOT, "shared")
# Общие файлы, которые программа может записать через сервер (как ALLOWED_FILES в js/shared-storage.js).
# Запись через сервер не зависит от разрешения браузера на папку, которое сбрасывается при перезапуске.
SHARED_WRITABLE = {
    "profiles.json", "fare-grid.json", "snapshot.json", "activity.json", "flight-comments.json",
    "subsidy-overrides.json", "pkz-nav.json", "sales-management.json",
    "creative-layouts.json", "subsidy-fares.json", "subsidy-ref.json", "calendar.json", "flights.json",
    "forecast-now.json", "params.json", "lower-requests.json",
    "export-kk.json", "export-mr.json",
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
    "subsidy-ref.json": (600, 30),
    "calendar.json": (600, 30),
    "flights.json": (600, 30),
    "pkz-nav.json": (600, 30),
    "flight-comments.json": (3600, 24),
    "creative-layouts.json": (3600, 20),
    "params.json": (600, 30),
    "fare-grid.json": (600, 30),
    "lower-requests.json": (600, 30),
}
# Архив продаж (js/sales-archive.js): shared/history/curves-ГГГГ-ММ.json.
ARCHIVE_RE = re.compile(r"^history/(curves-\d{4}-\d{2}|daylog-\d{4}-\d{2}|tickets-\d{4}-\d{2}|import)\.json$", re.ASCII)
# Отметки «Управления продажами»: свой файл у каждого автора (js/sales-management.js).
MARKS_RE = re.compile(r"^sales-marks/\d{4}-\d{2}/[a-z0-9_]{1,40}\.json$", re.ASCII)
MARKS_DIR_RE = re.compile(r"^sales-marks/\d{4}-\d{2}$", re.ASCII)
# Журнал прогнозов загрузки (js/forecast-lab.js): shared/forecast-log/ГГГГ-ММ.json.
FCLOG_RE = re.compile(r"^forecast-log/\d{4}-\d{2}\.json$", re.ASCII)
# Результаты решений в деньгах (js/decision-money.js): shared/decision-money/ГГГГ-ММ.json.
DMONEY_RE = re.compile(r"^decision-money/\d{4}-\d{2}\.json$", re.ASCII)
MAX_BODY = 64 * 1024 * 1024
SOCKET_TIMEOUT = 30   # зависший клиент не держит поток и память бесконечно
_NAME_LOCKS = {}
_NAME_LOCKS_GUARD = threading.Lock()


def _name_lock(name):
    with _NAME_LOCKS_GUARD:
        return _NAME_LOCKS.setdefault(name, threading.Lock())


# Замок на файл между серверами. У каждого ПК свой сервер, а папка shared общая (по сети): замок потоков внутри
# процесса защищает только этот сервер, поэтому проверка отпечатка (X-Krasavia-If-Match) и подмена файла у двух ПК
# могли пройти одновременно и затереть друг друга. Файл-замок «.<имя>.lock» создаётся атомарно (O_EXCL, на SMB тоже)
# на время проверки и записи и удаляется сразу после неё.
LOCK_WAIT = 20          # сколько секунд ждём чужую запись, потом отвечаем «занято» (503)
LOCK_STALE = 10         # замок, который столько секунд не меняется, считаем брошенным (ПК упал посреди записи)


class LockBusy(OSError):
    pass


def _lock_sig(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def acquire_file_lock(target):
    """Взять замок на файл у всех серверов, работающих с этой папкой. Возвращает (путь замка, метка)."""
    lock_path = os.path.join(os.path.dirname(target), "." + os.path.basename(target) + ".lock")
    token = "%s:%d:%s" % (socket.gethostname(), os.getpid(), uuid.uuid4().hex)
    start = time.monotonic()
    seen_sig, seen_at = None, start
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            try:
                os.write(fd, token.encode("utf-8", "replace"))
            finally:
                os.close(fd)
            return lock_path, token
        except FileExistsError:
            pass
        except PermissionError:
            # Windows/SMB: замок как раз удаляют — это ожидание. Нет самого замка — папка закрыта на запись, это ошибка.
            if not os.path.exists(lock_path):
                raise
        now = time.monotonic()
        sig = _lock_sig(lock_path)
        # Устарел ли замок, судим по своим часам: пока мы ждём, он не менялся дольше LOCK_STALE секунд
        # (время файла на сервере и часы ПК могут расходиться, поэтому на возраст файла не смотрим).
        if sig is None:
            seen_sig, seen_at = None, now
            continue
        if sig != seen_sig:
            seen_sig, seen_at = sig, now
        elif now - seen_at > LOCK_STALE:
            if _lock_sig(lock_path) == sig:
                try:
                    os.remove(lock_path)
                    sys.stderr.write("stale lock removed: %s\n" % os.path.basename(lock_path))
                except OSError:
                    pass
            seen_sig, seen_at = None, now
            continue
        if now - start > LOCK_WAIT:
            raise LockBusy("file is busy")
        time.sleep(0.015 + 0.03 * (hash(token) % 7) / 7)


def release_file_lock(lock):
    lock_path, token = lock
    try:
        with open(lock_path, "rb") as f:
            mine = f.read(256).decode("utf-8", "replace") == token
    except OSError:
        return
    if mine:                      # замок могли снять как брошенный и взять другим — чужой не трогаем
        try:
            os.remove(lock_path)
        except OSError:
            pass
ALLOWED_HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}

# Вторая модель прогноза (папка ml-forecast): отдельная служба на своём порту. Сайт ходит к ней через этот сервер,
# чтобы браузеру не нужен был другой адрес. Адрес меняется переменной KRASAVIA_ML_URL (по умолчанию тот же ПК).
ML_URL = os.environ.get("KRASAVIA_ML_URL", "http://127.0.0.1:8077").rstrip("/")
ML_ROUTES = {"/__krasavia/ml/health": ("GET", "/health"),
             "/__krasavia/ml/predict": ("POST", "/predict"),
             "/__krasavia/ml/predict_batch": ("POST", "/predict_batch")}
ML_MAX_BODY = 2 * 1024 * 1024
ML_TIMEOUT = 8


def _history_base(name):
    # forecast-log/2026-10.json → forecast-log_2026-10 (одна папка копий на файл, без подпапок).
    return name[:-5].replace("/", "_")


def _policy_for(name):
    if name in HISTORY_POLICY:
        return HISTORY_POLICY[name]
    if FCLOG_RE.fullmatch(name) or DMONEY_RE.fullmatch(name):
        return (6 * 3600, 10)
    # Архив продаж (кривые по месяцам) — копия раз в сутки, три последних: загрузка истории переписывает все месяцы.
    if ARCHIVE_RE.fullmatch(name):
        return (24 * 3600, 3)
    return None


def _history_versions(name):
    base = _history_base(name)
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
    policy = _policy_for(name)
    target = os.path.join(SHARED_DIR, *name.split("/"))
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
        dest = os.path.join(folder, "%s__%s.json" % (_history_base(name), stamp))
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
    timeout = SOCKET_TIMEOUT
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

    def list_directory(self, path):
        # Списки папок не отдаём: приложению они не нужны.
        self.send_error(404)
        return None

    def _static_blocked(self):
        # Служебное не отдаём: .git и скрытые пути, scripts/, tools/, *.cmd/*.py/*.bat/*.md в корне.
        parts = [p for p in unquote(urlparse(self.path).path).replace("\\", "/").split("/") if p]
        if any(p.startswith(".") for p in parts):
            return True
        if parts and parts[0] in ("scripts", "tools", "ml-forecast"):
            return True
        return len(parts) == 1 and parts[0].lower().endswith((".cmd", ".py", ".bat", ".md"))

    def do_HEAD(self):
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return self._send_json(403, {"error": "forbidden"})
        if self._static_blocked():
            return self._send_json(404, {"error": "not found"})
        return super().do_HEAD()

    def do_GET(self):
        # Чужой сайт, подменивший свой адрес на 127.0.0.1 (DNS rebinding), не прочитает файлы.
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return self._send_json(403, {"error": "forbidden"})
        if self.path.split("?")[0] == "/__krasavia/ml/health":
            return self._ml_proxy("GET", "/health", None)
        if self.path.split("?")[0] == "/__krasavia/caps":
            if not self._same_origin():
                return self._send_json(403, {"error": "forbidden"})
            return self._send_json(200, {"sharedWrite": os.access(SHARED_DIR if os.path.isdir(SHARED_DIR) else ROOT, os.W_OK), "history": True, "cas": True})
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
            if not MARKS_DIR_RE.fullmatch(folder):
                return self._send_json(404, {"error": "not allowed"})
            full = os.path.join(SHARED_DIR, *folder.split("/"))
            names = []
            if os.path.isdir(full):
                names = sorted(n for n in os.listdir(full) if re.match(r"^[a-z0-9_]{1,40}\.json$", n))
            return self._send_json(200, {"files": names})
        if self._static_blocked():
            return self._send_json(404, {"error": "not found"})
        return super().do_GET()

    def _ml_proxy(self, method, path, body):
        """Передаёт запрос службе второй модели. Если она не запущена — спокойный ответ ok=false, а не ошибка."""
        if not self._same_origin():
            return self._send_json(403, {"error": "forbidden"})
        req = urllib.request.Request(ML_URL + path, data=body, method=method,
                                     headers={"Content-Type": "application/json"} if body is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=ML_TIMEOUT) as resp:
                data = resp.read(8 * 1024 * 1024)
                code = resp.status
        except urllib.error.HTTPError as e:      # служба ответила ошибкой (плохой ввод, нет модели) — отдаём как есть
            data, code = e.read(1024 * 1024), e.code
        except (urllib.error.URLError, OSError, ValueError):
            return self._send_json(200, {"ok": False, "offline": True})
        try:
            parsed = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._send_json(200, {"ok": False, "offline": True})
        return self._send_json(200, {"ok": 200 <= code < 300, "status": code, "data": parsed})

    def do_POST(self):
        path = self.path.split("?")[0]
        self.close_connection = True
        route = ML_ROUTES.get(path)
        if route is None or route[0] != "POST":
            return self._send_json(404, {"error": "not allowed"})
        if self.headers.get("Host", "") not in ALLOWED_HOSTS or not self._same_origin():
            return self._send_json(403, {"error": "forbidden"})
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self._send_json(415, {"error": "json only"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > ML_MAX_BODY:
            return self._send_json(413, {"error": "bad size"})
        return self._ml_proxy("POST", route[1], self.rfile.read(length))

    def do_PUT(self):
        path = self.path.split("?")[0]
        name = path[len("/shared/"):] if path.startswith("/shared/") else ""
        # При отказе тело не читаем — закрываем соединение, чтобы остаток не приняли за новый запрос.
        self.close_connection = True
        if not self._same_origin():
            return self._send_json(403, {"error": "forbidden"})
        if name not in SHARED_WRITABLE and not ARCHIVE_RE.fullmatch(name) and not MARKS_RE.fullmatch(name) and not FCLOG_RE.fullmatch(name) and not DMONEY_RE.fullmatch(name):
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
        lock = None
        try:
            os.makedirs(SHARED_DIR, exist_ok=True)
            target = os.path.join(SHARED_DIR, *name.split("/"))
            target_dir = os.path.dirname(target)
            os.makedirs(target_dir, exist_ok=True)
            # Сначала очередь потоков этого сервера, затем замок на файл для остальных серверов (других ПК) на ту же папку.
            with _name_lock(name):
                lock = acquire_file_lock(target)
                # Запись «только если файл не менялся с прочтения»: отпечаток SHA-1 прочитанных байтов или absent (файла не было).
                want = self.headers.get("X-Krasavia-If-Match")
                if want:
                    try:
                        with open(target, "rb") as cf:
                            have = hashlib.sha1(cf.read()).hexdigest()
                    except FileNotFoundError:
                        have = "absent"
                    except OSError:
                        have = None
                    if have != want:
                        return self._send_json(409, {"error": "changed"})
                backup_if_due(name, self.headers.get("X-Krasavia-Backup") == "force")
                # Сначала во временный файл, потом подмена: другие ПК не прочитают недописанный файл.
                fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(target) + ".", suffix=".tmp", dir=target_dir)
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(body)
                        f.flush()
                        os.fsync(f.fileno())
                    try:
                        os.chmod(tmp, 0o644)  # mkstemp создаёт файл только для владельца
                    except OSError:
                        pass
                    # На Windows/SMB замена падает, пока файл открыт читателем (другой ПК) — повторяем.
                    for attempt in range(6):
                        try:
                            os.replace(tmp, target)
                            break
                        except PermissionError:
                            if attempt == 5:
                                raise
                            time.sleep(0.2 * (attempt + 1))
                except BaseException:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
                    raise
        except LockBusy:
            sys.stderr.write("write %s busy: another PC holds the file lock\n" % name)
            return self._send_json(503, {"error": "busy"})
        except OSError as e:
            sys.stderr.write("write %s failed: %s\n" % (name, e))
            return self._send_json(500, {"error": "write failed"})   # без путей к файлам в ответе
        finally:
            if lock:
                release_file_lock(lock)
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
