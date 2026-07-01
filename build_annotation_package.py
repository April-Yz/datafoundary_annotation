#!/usr/bin/env python3
"""Build a lightweight task-label annotation package from a LeRobot dataset.

The output package is self-contained:
- videos/<timestamp>/{hand,view1,view2}.mp4
- previews/<timestamp>/*_{start,middle,end}.jpg when ffmpeg is available
- items.jsonl without task/prompt text
- static UI and local save server

It can be rerun with --append to add more timestamps later.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


TIMESTAMP_RE = re.compile(r"(?<!\d)(20\d{12})(?!\d)")
STATIC_FILES = [
    "index.html",
    "app.js",
    "style.css",
    "label_config.json",
    "annotation_server.py",
    "build_annotation_package.py",
    "build_annotation_chunk_packages.py",
    "README.zh.md",
    "ANNOTATOR_RUN_GUIDE.zh.md",
    "ANNOTATION_LABELING_RULES.zh.md",
]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def find_timestamp(value: Any) -> str | None:
    if isinstance(value, str):
        m = TIMESTAMP_RE.search(value)
        return m.group(1) if m else None
    if isinstance(value, dict):
        for key in (
            "demo_timestamp",
            "timestamp",
            "episode_timestamp",
            "source_timestamp",
            "raw_timestamp",
            "source_path",
            "raw_path",
            "path",
        ):
            if key in value:
                ts = find_timestamp(value[key])
                if ts:
                    return ts
        for item in value.values():
            ts = find_timestamp(item)
            if ts:
                return ts
    if isinstance(value, list):
        for item in value:
            ts = find_timestamp(item)
            if ts:
                return ts
    return None


def get_episode_index(row: dict[str, Any], fallback: int) -> int:
    for key in ("episode_index", "episode_id", "episode", "index"):
        val = row.get(key)
        if isinstance(val, int):
            return val
        if isinstance(val, str) and val.isdigit():
            return int(val)
    return fallback


def get_episode_length(row: dict[str, Any]) -> int | None:
    for key in ("length", "num_frames", "episode_length", "frames"):
        val = row.get(key)
        if isinstance(val, int):
            return val
        if isinstance(val, str) and val.isdigit():
            return int(val)
    return None


def infer_view_name(video_path: Path) -> str:
    parent = video_path.parent.name.lower()
    name = video_path.name.lower()
    probe = f"{parent}/{name}"
    if "hand" in probe:
        return "hand"
    if "view1" in probe or "external" in probe:
        return "view1"
    if "view2" in probe or "wrist" in probe:
        return "view2"
    return parent.replace("observation.images.", "").replace("/", "_")


def dataset_chunk_size(dataset: Path) -> int:
    info_path = dataset / "meta" / "info.json"
    if info_path.exists():
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            value = int(info.get("chunks_size") or 1000)
            return value if value > 0 else 1000
        except Exception:
            return 1000
    return 1000


def find_episode_videos(dataset: Path, episode_index: int, chunk_size: int = 1000) -> dict[str, Path]:
    ep_name = f"episode_{episode_index:06d}.mp4"
    chunk = f"chunk-{episode_index // chunk_size:03d}"
    direct_candidates = [
        dataset / "videos" / chunk / "observation.images.hand" / ep_name,
        dataset / "videos" / chunk / "observation.images.view1" / ep_name,
        dataset / "videos" / chunk / "observation.images.view2" / ep_name,
    ]
    candidates = [p for p in direct_candidates if p.exists()]
    if not candidates:
        candidates = list((dataset / "videos").glob(f"**/{ep_name}"))
    videos: dict[str, Path] = {}
    for path in candidates:
        view = infer_view_name(path)
        # Keep first known view, but do not drop unknown views if they are the only match.
        videos.setdefault(view, path)
    return videos


def find_episode_parquet(dataset: Path, episode_index: int, chunk_size: int = 1000) -> Path | None:
    ep_name = f"episode_{episode_index:06d}.parquet"
    direct = dataset / "data" / f"chunk-{episode_index // chunk_size:03d}" / ep_name
    if direct.exists():
        return direct
    candidates = list((dataset / "data").glob(f"**/{ep_name}"))
    return candidates[0] if candidates else None


def safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        out = float(value)
        if out != out:
            return None
        return out
    except Exception:
        return None


def load_source_subtask_segments(
    dataset: Path,
    episode_index: int,
    row: dict[str, Any],
    fallback_fps: float,
    chunk_size: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Read per-frame subtask labels from the source parquet and convert them to UI segments.

    The annotation UI intentionally hides the original task/prompt, but source subtask
    boundaries are not a semantic hint by themselves; they are useful to avoid forcing
    annotators to redraw already-valid segments.  We therefore expose only segment ids
    and frame/time spans, not the original task label.
    """

    parquet_path = find_episode_parquet(dataset, episode_index, chunk_size)
    meta: dict[str, Any] = {
        "status": "missing_parquet",
        "source": row.get("subtask_source"),
        "num_boundaries_meta": row.get("subtask_num_boundaries"),
        "num_labels_meta": row.get("subtask_num_labels"),
        "parquet": str(parquet_path) if parquet_path else None,
        "unique_labels": [],
        "segment_count": 0,
        "segments": [],
    }
    if parquet_path is None:
        return meta, []

    try:
        import pandas as pd  # type: ignore
    except Exception as exc:
        meta["status"] = "pandas_unavailable"
        meta["error"] = str(exc)
        return meta, []

    try:
        df = pd.read_parquet(parquet_path)
    except Exception as exc:
        meta["status"] = "read_error"
        meta["error"] = str(exc)
        return meta, []

    if "subtask" not in df.columns:
        meta["status"] = "no_subtask_column"
        return meta, []
    if len(df) == 0:
        meta["status"] = "empty_parquet"
        return meta, []

    labels: list[int] = []
    for val in df["subtask"].tolist():
        try:
            labels.append(int(val))
        except Exception:
            labels.append(0)

    unique_labels = sorted({v for v in labels if v > 0})
    meta["unique_labels"] = unique_labels
    if not unique_labels:
        meta["status"] = "all_zero_or_missing"
        return meta, []

    if "frame_index" in df.columns:
        frame_values = [int(v) for v in df["frame_index"].tolist()]
    else:
        frame_values = list(range(len(df)))

    if "timestamp" in df.columns:
        time_values = [safe_float(v) for v in df["timestamp"].tolist()]
    else:
        time_values = [i / fallback_fps for i in range(len(df))]

    segments: list[dict[str, Any]] = []
    start_i = 0
    current = labels[0]
    for i in range(1, len(labels) + 1):
        changed = i == len(labels) or labels[i] != current
        if not changed:
            continue
        end_i = i - 1
        if current > 0:
            start_frame = frame_values[start_i]
            end_frame = frame_values[end_i]
            start_time = time_values[start_i]
            end_time = time_values[end_i]
            if start_time is None:
                start_time = start_frame / fallback_fps
            if end_time is None:
                end_time = end_frame / fallback_fps
            segments.append(
                {
                    "id": str(current),
                    "source_subtask_id": current,
                    "start_frame": start_frame,
                    "end_frame": end_frame,
                    "start_time": round(float(start_time), 6),
                    "end_time": round(float(end_time), 6),
                    "source": "parquet_subtask",
                    "preloaded": True,
                }
            )
        if i < len(labels):
            start_i = i
            current = labels[i]

    meta["status"] = "ok" if segments else "no_positive_segments"
    meta["segment_count"] = len(segments)
    meta["segments"] = segments
    initial_segments = [
        {
            "id": seg["id"],
            "start_frame": seg["start_frame"],
            "end_frame": seg["end_frame"],
            "start_time": seg["start_time"],
            "end_time": seg["end_time"],
            "source": "preloaded_parquet_subtask",
            "preloaded": True,
        }
        for seg in segments
    ]
    return meta, initial_segments


def link_or_copy(src: Path, dst: Path, mode: str) -> str:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    if mode == "symlink":
        dst.symlink_to(src)
        return "symlink"
    if mode == "hardlink":
        try:
            os.link(src, dst)
            return "hardlink"
        except OSError:
            shutil.copy2(src, dst)
            return "copy_fallback"
    shutil.copy2(src, dst)
    return "copy"


def ffprobe_duration(video: Path) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.check_output(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nokey=1:noprint_wrappers=1",
                str(video),
            ],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=20,
        ).strip()
        return float(out) if out else None
    except Exception:
        return None


def make_preview(video: Path, out: Path, seconds: float) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{max(seconds, 0.0):.3f}",
        "-i",
        str(video),
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=60)
        return out.exists() and out.stat().st_size > 0
    except Exception:
        return False


def create_previews(video: Path, preview_dir: Path, view: str) -> dict[str, str]:
    duration = ffprobe_duration(video)
    if duration and duration > 1:
        points = {
            "start": min(0.25, duration * 0.05),
            "middle": duration * 0.5,
            "end": max(duration - 0.35, 0.0),
        }
    else:
        points = {"start": 0.1, "middle": 1.0, "end": 2.0}

    result: dict[str, str] = {}
    for label, sec in points.items():
        out = preview_dir / f"{view}_{label}.jpg"
        if make_preview(video, out, sec):
            result[label] = str(out.relative_to(preview_dir.parents[1]))
    return result


def load_timestamp_list(args: argparse.Namespace) -> list[str] | None:
    timestamps: list[str] = []
    if args.timestamp:
        timestamps.extend(args.timestamp)
    if args.timestamp_file:
        with Path(args.timestamp_file).open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = TIMESTAMP_RE.search(line)
                if m:
                    timestamps.append(m.group(1))
    if not timestamps:
        return None
    seen: set[str] = set()
    uniq: list[str] = []
    for ts in timestamps:
        m = TIMESTAMP_RE.search(ts)
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            uniq.append(m.group(1))
    return uniq


def copy_static_files(tool_dir: Path, package_dir: Path, label_config: Path | None) -> None:
    for name in STATIC_FILES:
        src = label_config if name == "label_config.json" and label_config else tool_dir / name
        dst = package_dir / name
        shutil.copy2(src, dst)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="LeRobot dataset root")
    parser.add_argument("--package-dir", required=True, help="Output annotation package root")
    parser.add_argument("--timestamp", action="append", help="Timestamp to include; can repeat")
    parser.add_argument("--timestamp-file", help="File containing timestamps")
    parser.add_argument("--episode-index-min", type=int, help="Include episodes with episode_index >= this value")
    parser.add_argument("--episode-index-max", type=int, help="Include episodes with episode_index <= this value")
    parser.add_argument("--limit", type=int, help="Limit number of selected episodes")
    parser.add_argument("--append", action="store_true", help="Append new items to an existing package")
    parser.add_argument("--keep-existing-annotations", action="store_true", help="Do not reset annotations files when rebuilding a package without --append")
    parser.add_argument("--copy-mode", choices=["hardlink", "copy", "symlink"], default="hardlink")
    parser.add_argument("--no-previews", action="store_true", help="Do not generate start/middle/end preview JPGs")
    parser.add_argument("--shuffle", action="store_true", help="Shuffle item order")
    parser.add_argument("--seed", type=int, default=20260630)
    parser.add_argument("--fps", type=float, default=15.0, help="Fallback fps when parquet has no timestamp column")
    parser.add_argument("--label-config", help="Override label config JSON")
    args = parser.parse_args()

    dataset = Path(args.dataset).expanduser().resolve()
    package_dir = Path(args.package_dir).expanduser().resolve()
    tool_dir = Path(__file__).resolve().parent
    label_config = Path(args.label_config).expanduser().resolve() if args.label_config else None

    episodes_path = dataset / "meta" / "episodes.jsonl"
    if not episodes_path.exists():
        raise SystemExit(f"missing LeRobot episodes metadata: {episodes_path}")

    chunk_size = dataset_chunk_size(dataset)
    package_dir.mkdir(parents=True, exist_ok=True)
    copy_static_files(tool_dir, package_dir, label_config)
    if not args.append and not args.keep_existing_annotations:
        (package_dir / "annotations.jsonl").write_text("", encoding="utf-8")
        (package_dir / "annotations_latest.json").write_text("{}\n", encoding="utf-8")

    rows = read_jsonl(episodes_path)
    requested = load_timestamp_list(args)
    requested_set = set(requested or [])
    existing_rows: list[dict[str, Any]] = []
    existing_ts: set[str] = set()
    items_path = package_dir / "items.jsonl"
    if args.append and items_path.exists():
        existing_rows = read_jsonl(items_path)
        existing_ts = {str(r.get("demo_timestamp")) for r in existing_rows if r.get("demo_timestamp")}

    selected: list[tuple[str, int, dict[str, Any]]] = []
    missing_requested = set(requested_set)
    for fallback, row in enumerate(rows):
        ts = find_timestamp(row)
        if not ts:
            continue
        episode_index = get_episode_index(row, fallback)
        if args.episode_index_min is not None and episode_index < args.episode_index_min:
            continue
        if args.episode_index_max is not None and episode_index > args.episode_index_max:
            continue
        if requested_set and ts not in requested_set:
            continue
        missing_requested.discard(ts)
        if ts in existing_ts:
            continue
        selected.append((ts, episode_index, row))

    if args.shuffle:
        random.Random(args.seed).shuffle(selected)
    if args.limit is not None:
        selected = selected[: args.limit]

    built: list[dict[str, Any]] = []
    linkage_counts: dict[str, int] = {}
    missing_video_items: list[str] = []
    for ts, episode_index, row in selected:
        videos = find_episode_videos(dataset, episode_index, chunk_size)
        if not videos:
            missing_video_items.append(ts)
            continue

        item_video_dir = package_dir / "videos" / ts
        item_preview_dir = package_dir / "previews" / ts
        rel_videos: dict[str, str] = {}
        previews: dict[str, dict[str, str]] = {}

        for preferred_view in ("hand", "view1", "view2"):
            if preferred_view not in videos:
                continue
            src = videos[preferred_view]
            dst = item_video_dir / f"{preferred_view}.mp4"
            method = link_or_copy(src, dst, args.copy_mode)
            linkage_counts[method] = linkage_counts.get(method, 0) + 1
            rel_videos[preferred_view] = str(dst.relative_to(package_dir))
            previews[preferred_view] = {} if args.no_previews else create_previews(dst, item_preview_dir, preferred_view)

        # Include any unexpected extra view after known three.
        for view, src in sorted(videos.items()):
            if view in rel_videos:
                continue
            safe_view = re.sub(r"[^A-Za-z0-9_.-]+", "_", view)
            dst = item_video_dir / f"{safe_view}.mp4"
            method = link_or_copy(src, dst, args.copy_mode)
            linkage_counts[method] = linkage_counts.get(method, 0) + 1
            rel_videos[safe_view] = str(dst.relative_to(package_dir))
            previews[safe_view] = {} if args.no_previews else create_previews(dst, item_preview_dir, safe_view)

        source_subtask, initial_subtask_segments = load_source_subtask_segments(
            dataset=dataset,
            episode_index=episode_index,
            row=row,
            fallback_fps=args.fps,
            chunk_size=chunk_size,
        )
        built.append(
            {
                "item_id": ts,
                "demo_timestamp": ts,
                "episode_index": episode_index,
                "length": get_episode_length(row),
                "videos": rel_videos,
                "previews": previews,
                "source_subtask": source_subtask,
                "initial_subtask_segments": initial_subtask_segments,
            }
        )

    all_items = existing_rows + built
    write_jsonl(items_path, all_items)

    manifest = {
        "dataset": str(dataset),
        "package_dir": str(package_dir),
        "items_total": len(all_items),
        "items_added": len(built),
        "requested_missing": sorted(missing_requested),
        "missing_video_items": missing_video_items,
        "copy_mode": args.copy_mode,
        "linkage_counts": linkage_counts,
        "task_prompt_excluded": True,
        "source_subtask_preloaded": True,
        "fps": args.fps,
        "chunks_size": chunk_size,
        "episode_index_min": args.episode_index_min,
        "episode_index_max": args.episode_index_max,
        "previews_generated": not args.no_previews,
        "annotations_reset": (not args.append and not args.keep_existing_annotations),
        "label_config": str((label_config or tool_dir / "label_config.json").resolve()),
    }
    (package_dir / "package_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"package: {package_dir}")
    print(f"items_total: {len(all_items)}")
    print(f"items_added: {len(built)}")
    print(f"task_prompt_excluded: true")
    print(f"linkage_counts: {json.dumps(linkage_counts, ensure_ascii=False, sort_keys=True)}")
    if missing_requested:
        print(f"requested_missing: {len(missing_requested)}", file=sys.stderr)
    if missing_video_items:
        print(f"missing_video_items: {len(missing_video_items)}", file=sys.stderr)


if __name__ == "__main__":
    main()
