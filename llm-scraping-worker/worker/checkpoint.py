import json
from pathlib import Path


def ckpt_path(name: str, checkpoints_dir: Path) -> Path:
    return checkpoints_dir / f"{name}.jsonl"


def ckpt_exists(name: str, checkpoints_dir: Path) -> bool:
    p = ckpt_path(name, checkpoints_dir)
    return p.exists() and p.stat().st_size > 0


def save_ckpt(name: str, samples: list[dict], checkpoints_dir: Path) -> None:
    p = ckpt_path(name, checkpoints_dir)
    tmp = p.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    tmp.rename(p)


def load_ckpt(name: str, checkpoints_dir: Path) -> list[dict]:
    samples = []
    with open(ckpt_path(name, checkpoints_dir), "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                samples.append(json.loads(line))
    return samples


def append_ckpt(name: str, samples: list[dict], checkpoints_dir: Path) -> None:
    with open(ckpt_path(name, checkpoints_dir), "a", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
