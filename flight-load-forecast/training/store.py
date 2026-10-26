"""Хранилище версий модели.

Раскладка каталога (по умолчанию ``artifacts/``)::

    artifacts/
        current.json                     # указатель на актуальную версию (пишется атомарно)
        v20240801T031500Z_ab12cd34ef56/  # версия: <UTC-время>_<первые 12 символов хеша входа>
            ensemble.joblib
            table.joblib
            metadata.json

Гарантии:
  * запись атомарная: версия собирается во временной папке ``*.tmp`` в том же каталоге и
    одним ``os.replace`` становится видимой; указатель ``current.json`` пишется так же;
  * идемпотентность: если версия с таким же хешем входа (файлы + параметры) уже есть, новая
    не создаётся (в лог пишется «версия уже есть»), пока не передан ``force=True``;
  * недописанные ``*.tmp`` (упавший процесс) чистятся при создании хранилища;
  * хранятся последние ``keep`` версий (по умолчанию 5), текущая не удаляется никогда.

В метаданные попадают только агрегаты (метрики, счётчики, периоды, версии библиотек) —
никаких значений из файлов с билетами и персональных данных.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import joblib

log = logging.getLogger(__name__)

KEEP_VERSIONS = 5
CURRENT_FILE = "current.json"
_VERSION_RE = re.compile(r"^v\d{8}T\d{6}Z_[0-9a-zA-Z]+(-\d+)?$")
_HASH_VERSION = "1"          # менять при несовместимых изменениях логики подготовки данных


class InputError(ValueError):
    """Плохие входные данные (нет файла, пустая история, неверные колонки). CLI превращает в exit code 2."""


class ModelNotFoundError(FileNotFoundError):
    """В хранилище нет ни одной пригодной версии."""


# ---------------------------------------------------------------- хеши входа

def file_sha256(path) -> str:
    """SHA-256 содержимого файла (потоково, чтобы не держать большой файл в памяти)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_inputs(files: dict[str, list] | None = None, params: dict | None = None, extra: str = "") -> tuple[str, list]:
    """Хеш входа = SHA-256 от (роль файла, хеш содержимого) и параметров.

    files: {"history": [path], "tickets": [p1, p2], ...}. Для ролей с несколькими файлами порядок
    не важен. Имена и пути в хеш НЕ входят — только содержимое, поэтому тот же файл под другим именем
    даёт тот же хеш. Возвращает (хеш, список описаний файлов для metadata: роль, имя, sha256, размер).
    """
    described, parts = [], []
    for role in sorted(files or {}):
        entries = []
        for p in (files or {})[role]:
            p = Path(p)
            try:
                digest = file_sha256(p)
                size = p.stat().st_size
            except OSError as e:
                raise InputError(f"Не удаётся прочитать файл «{p}»: {e.strerror or e}") from e
            entries.append((digest, p.name, size))
        for digest, name, size in sorted(entries):
            parts.append([role, digest])
            described.append({"role": role, "name": name, "sha256": digest, "size": size})
    payload = json.dumps({"v": _HASH_VERSION, "files": parts, "params": params or {}, "extra": extra},
                         sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest(), described


# ---------------------------------------------------------------- служебное

def lib_versions() -> dict:
    """Версии библиотек, влияющих на воспроизводимость и совместимость pickle."""
    out = {}
    for name in ("numpy", "pandas", "lightgbm", "sklearn", "joblib"):
        try:
            mod = __import__(name)
            out[name] = str(getattr(mod, "__version__", "?"))
        except Exception:   # библиотеки нет — так и пишем
            out[name] = None
    return out


def jsonable(obj):
    """Приводит метрики и метаданные к чистому JSON: numpy -> python, NaN/Inf -> None."""
    if isinstance(obj, dict):
        return {str(k): jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [jsonable(v) for v in obj]
    if hasattr(obj, "item") and not isinstance(obj, (str, bytes)):
        try:
            obj = obj.item()
        except Exception:
            return str(obj)
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, (int, str, bool)) or obj is None:
        return obj
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return str(obj)


def _fsync_path(path: Path) -> None:
    """Сбрасывает файл/каталог на диск (где ОС это позволяет)."""
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def _atomic_write_text(path: Path, text: str) -> None:
    """Пишет файл через временный ``*.tmp`` рядом и ``os.replace``."""
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    _fsync_path(path.parent)


def _table_summary(table) -> tuple[int | None, dict | None]:
    """Число вылетов и период данных (min/max дата вылета) — без значений ПДн."""
    try:
        n = int(len(table))
    except Exception:
        n = None
    period = None
    try:
        fd = table.df["flydate"]
        if len(fd):
            period = {"from": fd.min().strftime("%Y-%m-%d"), "to": fd.max().strftime("%Y-%m-%d")}
    except Exception:
        pass
    return n, period


# ---------------------------------------------------------------- хранилище

class ArtifactStore:
    """Версионируемое хранилище (ensemble.joblib + table.joblib + metadata.json)."""

    def __init__(self, root="artifacts", keep: int = KEEP_VERSIONS, cleanup: bool = True,
                 tmp_max_age_s: float = 3600.0):
        """cleanup=False — режим только для чтения (сервис прогнозов ничего не удаляет).

        tmp_max_age_s: чистятся только ``*.tmp`` старше этого возраста, чтобы не снести временную
        папку параллельно работающего обучения. Для тестов можно передать 0.
        """
        self.root = Path(root)
        self.keep = max(int(keep), 1)
        if cleanup:
            self.root.mkdir(parents=True, exist_ok=True)
            self.cleanup_tmp(tmp_max_age_s)

    # ----- служебные

    def cleanup_tmp(self, max_age_s: float = 0.0) -> int:
        """Удаляет недописанные ``*.tmp`` (папки и файлы). Возвращает число удалённых."""
        n = 0
        if not self.root.is_dir():
            return 0
        now = time.time()
        for p in self.root.glob("*.tmp"):
            try:
                if now - p.stat().st_mtime < max_age_s:
                    continue
                shutil.rmtree(p) if p.is_dir() else p.unlink()
                n += 1
            except OSError as e:
                log.warning("Не удалось удалить временный объект %s: %s", p.name, e)
        if n:
            log.info("Удалено недописанных временных объектов: %d", n)
        return n

    def _version_dirs(self) -> list[Path]:
        if not self.root.is_dir():
            return []
        return sorted((p for p in self.root.iterdir()
                       if p.is_dir() and _VERSION_RE.match(p.name) and (p / "metadata.json").is_file()),
                      key=lambda p: p.name)

    # ----- чтение

    def list_versions(self) -> list[str]:
        """Имена версий, от новой к старой."""
        return [p.name for p in reversed(self._version_dirs())]

    def read_metadata(self, version: str) -> dict:
        with open(self.root / version / "metadata.json", encoding="utf-8") as f:
            return json.load(f)

    def current_version(self) -> str | None:
        """Версия из current.json, если указатель цел и версия существует."""
        try:
            with open(self.root / CURRENT_FILE, encoding="utf-8") as f:
                v = json.load(f).get("version")
        except (OSError, ValueError):
            return None
        if v and (self.root / v / "metadata.json").is_file():
            return v
        return None

    def resolve_current(self) -> str | None:
        """Текущая версия; если указатель потерян или битый — самая свежая целая версия."""
        v = self.current_version()
        if v:
            return v
        for p in reversed(self._version_dirs()):
            if (p / "ensemble.joblib").is_file() and (p / "table.joblib").is_file():
                log.warning("current.json отсутствует или указывает в пустоту — беру самую свежую версию %s", p.name)
                return p.name
        return None

    def current_metadata(self) -> dict | None:
        v = self.resolve_current()
        return self.read_metadata(v) if v else None

    def find_by_hash(self, input_hash: str) -> str | None:
        """Версия с таким же хешем входа (самая свежая) или None."""
        for p in reversed(self._version_dirs()):
            try:
                if self.read_metadata(p.name).get("input_hash") == input_hash:
                    return p.name
            except (OSError, ValueError):
                continue
        return None

    def load(self, version: str):
        d = self.root / version
        ens = joblib.load(d / "ensemble.joblib")
        table = joblib.load(d / "table.joblib")
        return ens, table, self.read_metadata(version)

    def load_current(self):
        """(ensemble, table, metadata) текущей версии. Нет версии -> ModelNotFoundError."""
        v = self.resolve_current()
        if v is None:
            raise ModelNotFoundError(f"В «{self.root}» нет обученной модели")
        return self.load(v)

    # ----- запись

    def save(self, ensemble, table, metadata: dict, force: bool = False) -> str:
        """Сохраняет новую версию и делает её текущей. Возвращает имя версии.

        metadata["input_hash"] — хеш входа; если версия с таким хешем уже есть и force=False, новая не
        создаётся, возвращается имя существующей (указатель current.json не трогается).
        Поля version, created_utc, libs, n_flights, data_period заполняются здесь, если не заданы.
        """
        self.root.mkdir(parents=True, exist_ok=True)
        meta = dict(metadata or {})
        input_hash = meta.get("input_hash") or uuid.uuid4().hex * 2   # без хеша идемпотентности нет
        meta["input_hash"] = input_hash

        if not force:
            existing = self.find_by_hash(input_hash)
            if existing:
                log.info("Версия уже есть: %s (хеш входа %s) — новая не создаётся", existing, input_hash[:12])
                return existing

        now = datetime.now(timezone.utc).replace(microsecond=0)
        # имена должны сортироваться по времени создания: если новейшая версия в ту же секунду (или «из будущего»),
        # сдвигаем метку на секунду вперёд
        dirs = self._version_dirs()
        if dirs:
            newest = datetime.strptime(dirs[-1].name[1:16], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
            if newest >= now:
                now = newest + timedelta(seconds=1)
        version = f"v{now:%Y%m%dT%H%M%SZ}_{input_hash[:12]}"
        n_flights, period = _table_summary(table)
        meta.update({"version": version, "created_utc": now.isoformat().replace("+00:00", "Z")})
        meta.setdefault("libs", lib_versions())
        meta.setdefault("n_flights", n_flights)
        meta.setdefault("data_period", period)

        tmp = self.root / f"{version}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
        tmp.mkdir()
        try:
            joblib.dump(ensemble, tmp / "ensemble.joblib", compress=3)
            joblib.dump(table, tmp / "table.joblib", compress=3)
            with open(tmp / "metadata.json", "w", encoding="utf-8") as f:
                json.dump(jsonable(meta), f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            _fsync_path(tmp)
            os.replace(tmp, self.root / version)
        except OSError as e:
            shutil.rmtree(tmp, ignore_errors=True)
            if (self.root / version / "metadata.json").is_file():   # параллельный процесс успел раньше
                log.info("Версия %s уже записана другим процессом", version)
                return version
            raise
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        _fsync_path(self.root)
        self._write_current(version, input_hash)
        log.info("Сохранена версия %s", version)
        self._prune()
        return version

    def _write_current(self, version: str, input_hash: str) -> None:
        payload = {"version": version, "input_hash": input_hash,
                   "updated_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")}
        _atomic_write_text(self.root / CURRENT_FILE, json.dumps(payload, ensure_ascii=False, indent=2))

    def set_current(self, version: str) -> None:
        """Откат/переключение на существующую версию."""
        if not (self.root / version / "metadata.json").is_file():
            raise ModelNotFoundError(f"Версии «{version}» нет в хранилище")
        self._write_current(version, self.read_metadata(version).get("input_hash", ""))

    def _prune(self) -> None:
        """Оставляет последние ``keep`` версий; текущая не удаляется. Удаление через переименование в *.tmp."""
        cur = self.current_version()
        dirs = self._version_dirs()
        for p in dirs[:max(len(dirs) - self.keep, 0)]:
            if p.name == cur:
                continue
            doomed = p.with_name(f"{p.name}.{uuid.uuid4().hex[:8]}.tmp")
            try:
                os.replace(p, doomed)
                shutil.rmtree(doomed, ignore_errors=True)
                log.info("Удалена старая версия %s (хранится последних %d)", p.name, self.keep)
            except OSError as e:
                log.warning("Не удалось удалить старую версию %s: %s", p.name, e)
