#!/usr/bin/env python3
"""Tiny local annotation server.

It serves a prebuilt annotation package and accepts POST /api/save.
The server deliberately has no heavy dependency so it can run on cartin1/cartin2/pine2
with system Python.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
from pathlib import Path
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def atomic_write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_latest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


class AnnotationHandler(SimpleHTTPRequestHandler):
    package_dir: Path
    annotator: str
    _range: tuple[int, int] | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(self.package_dir), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):  # type: ignore[override]
        """Serve static files with byte-range support.

        Browsers need HTTP 206 Range responses to seek MP4 files reliably. Python's
        stock SimpleHTTPRequestHandler is not consistently good enough across
        server versions, so we provide the small subset we need here.
        """
        self._range = None
        if self.path.startswith("/api/"):
            return super().send_head()

        path = Path(self.translate_path(self.path))
        if path.is_dir():
            return super().send_head()
        if not path.exists() or not path.is_file():
            return super().send_head()

        file_size = path.stat().st_size
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        match = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
        if not match:
            self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "Invalid Range header")
            return None

        start_s, end_s = match.groups()
        if start_s == "" and end_s == "":
            self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "Invalid Range header")
            return None
        if start_s == "":
            suffix_len = int(end_s)
            start = max(file_size - suffix_len, 0)
            end = file_size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else file_size - 1

        if start >= file_size or end < start:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{file_size}")
            self.end_headers()
            return None

        end = min(end, file_size - 1)
        content_length = end - start + 1
        ctype = self.guess_type(str(path))
        f = path.open("rb")
        f.seek(start)
        self._range = (start, end)
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Last-Modified", self.date_time_string(path.stat().st_mtime))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):  # type: ignore[override]
        if self._range is None:
            return super().copyfile(source, outputfile)
        start, end = self._range
        remaining = end - start + 1
        bufsize = 1024 * 1024
        while remaining > 0:
            chunk = source.read(min(bufsize, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def _write_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/api/annotations_latest.json"):
            latest = load_latest(self.package_dir / "annotations_latest.json")
            self._write_json(latest)
            return
        if self.path == "/api/health":
            self._write_json({"ok": True, "package_dir": str(self.package_dir)})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/api/save":
            self._write_json({"ok": False, "error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            record = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            self._write_json({"ok": False, "error": f"bad json: {exc}"}, HTTPStatus.BAD_REQUEST)
            return

        ts = str(record.get("demo_timestamp") or record.get("item_id") or "").strip()
        if not ts:
            self._write_json({"ok": False, "error": "missing demo_timestamp"}, HTTPStatus.BAD_REQUEST)
            return

        try:
            episode_index = int(record["episode_index"])
        except (KeyError, TypeError, ValueError):
            self._write_json({"ok": False, "error": "invalid episode_index"}, HTTPStatus.BAD_REQUEST)
            return

        chasis_label = str(record.get("chasis_label") or "").strip()
        if chasis_label not in {"large", "small"}:
            self._write_json(
                {"ok": False, "error": "chasis_label must be large or small"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        boolean_fields = ("camera_shift", "bad_demo", "是否跳变")
        invalid_boolean_fields = [name for name in boolean_fields if not isinstance(record.get(name), bool)]
        if invalid_boolean_fields:
            self._write_json(
                {"ok": False, "error": f"invalid boolean fields: {', '.join(invalid_boolean_fields)}"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        # The 565h+ branch intentionally emits a strict six-field schema. This
        # also strips task/subtask fields from records posted by stale browser tabs.
        record = {
            "episode_index": episode_index,
            "demo_timestamp": ts,
            "camera_shift": record["camera_shift"],
            "bad_demo": record["bad_demo"],
            "是否跳变": record["是否跳变"],
            "chasis_label": chasis_label,
        }

        jsonl_path = self.package_dir / "annotations.jsonl"
        with jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

        latest_path = self.package_dir / "annotations_latest.json"
        latest = load_latest(latest_path)
        latest[ts] = record
        atomic_write_json(latest_path, latest)

        self._write_json({"ok": True, "demo_timestamp": ts, "saved_count": len(latest)})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", required=True, help="Annotation package root")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--annotator", default=os.environ.get("USER", "annotator"))
    args = parser.parse_args()

    package_dir = Path(args.package_dir).expanduser().resolve()
    if not (package_dir / "index.html").exists():
        raise SystemExit(f"missing index.html in package dir: {package_dir}")

    AnnotationHandler.package_dir = package_dir
    AnnotationHandler.annotator = args.annotator
    server = ThreadingHTTPServer((args.host, args.port), AnnotationHandler)
    print(f"Serving annotation package: {package_dir}", flush=True)
    print(f"Open: http://{args.host}:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
