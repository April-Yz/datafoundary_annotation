#!/usr/bin/env python3
"""Build annotation-ready packages in LeRobot chunk units.

Each output directory is a standalone annotation package:
- static UI code and docs
- items.jsonl without original task/prompt text
- videos/<timestamp>/{hand,view1,view2}.mp4
- empty annotations.jsonl / annotations_latest.json

The default chunk size follows the source LeRobot dataset meta/info.json
(`chunks_size`, usually 1000).  Package directories are named by episode range,
so future appended data can continue from the current last chunk.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any


def read_info(dataset: Path) -> dict[str, Any]:
    info_path = dataset / "meta" / "info.json"
    if not info_path.exists():
        raise SystemExit(f"missing {info_path}")
    return json.loads(info_path.read_text(encoding="utf-8"))


def count_episode_rows(dataset: Path) -> tuple[int, int]:
    episodes_path = dataset / "meta" / "episodes.jsonl"
    if not episodes_path.exists():
        raise SystemExit(f"missing {episodes_path}")
    rows = 0
    max_index = -1
    with episodes_path.open("r", encoding="utf-8") as f:
        for fallback, line in enumerate(f):
            if not line.strip():
                continue
            row = json.loads(line)
            rows += 1
            idx = row.get("episode_index", fallback)
            try:
                max_index = max(max_index, int(idx))
            except Exception:
                max_index = max(max_index, fallback)
    return rows, max_index


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="LeRobot clean_final dataset root")
    parser.add_argument("--out-root", required=True, help="Output root for annotation packages")
    parser.add_argument("--name-prefix", default="annotation_chunk", help="Package directory prefix")
    parser.add_argument("--start-chunk", type=int, default=0)
    parser.add_argument("--end-chunk", type=int, help="Inclusive chunk id to build")
    parser.add_argument("--copy-mode", choices=["hardlink", "copy", "symlink"], default="hardlink")
    parser.add_argument("--fps", type=float, default=15.0)
    parser.add_argument("--with-previews", action="store_true", help="Generate preview JPGs; slower and larger")
    parser.add_argument("--shuffle", action="store_true", help="Shuffle item order inside each package")
    parser.add_argument("--seed", type=int, default=20260630)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dataset = Path(args.dataset).expanduser().resolve()
    out_root = Path(args.out_root).expanduser().resolve()
    tool_dir = Path(__file__).resolve().parent
    builder = tool_dir / "build_annotation_package.py"

    info = read_info(dataset)
    chunk_size = int(info.get("chunks_size") or 1000)
    total_rows, max_index = count_episode_rows(dataset)
    max_chunk = max_index // chunk_size
    end_chunk = args.end_chunk if args.end_chunk is not None else max_chunk
    end_chunk = min(end_chunk, max_chunk)

    out_root.mkdir(parents=True, exist_ok=True)
    plan: list[dict[str, Any]] = []
    for chunk_id in range(args.start_chunk, end_chunk + 1):
        start = chunk_id * chunk_size
        end = min((chunk_id + 1) * chunk_size - 1, max_index)
        if start > max_index:
            continue
        package_name = f"{args.name_prefix}_{chunk_id:03d}_ep{start:06d}_{end:06d}"
        package_dir = out_root / package_name
        cmd = [
            sys.executable,
            str(builder),
            "--dataset",
            str(dataset),
            "--package-dir",
            str(package_dir),
            "--episode-index-min",
            str(start),
            "--episode-index-max",
            str(end),
            "--copy-mode",
            args.copy_mode,
            "--fps",
            str(args.fps),
        ]
        if not args.with_previews:
            cmd.append("--no-previews")
        if args.shuffle:
            cmd.extend(["--shuffle", "--seed", str(args.seed + chunk_id)])
        plan.append(
            {
                "chunk_id": chunk_id,
                "episode_start": start,
                "episode_end": end,
                "package_dir": str(package_dir),
                "command": cmd,
            }
        )

    manifest = {
        "dataset": str(dataset),
        "out_root": str(out_root),
        "total_episode_rows": total_rows,
        "max_episode_index": max_index,
        "chunk_size": chunk_size,
        "start_chunk": args.start_chunk,
        "end_chunk": end_chunk,
        "copy_mode": args.copy_mode,
        "with_previews": args.with_previews,
        "task_prompt_excluded": True,
        "packages": plan,
    }
    (out_root / "chunk_build_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"dataset={dataset}")
    print(f"out_root={out_root}")
    print(f"total_episode_rows={total_rows} max_episode_index={max_index} chunk_size={chunk_size}")
    print(f"packages_planned={len(plan)}")
    if args.dry_run:
        for row in plan:
            print(f"DRY {row['chunk_id']:03d}: {row['episode_start']}..{row['episode_end']} -> {row['package_dir']}")
        return

    for row in plan:
        print(f"=== build chunk {row['chunk_id']:03d}: {row['episode_start']}..{row['episode_end']} ===", flush=True)
        subprocess.run(row["command"], check=True)

    print("done")


if __name__ == "__main__":
    main()
