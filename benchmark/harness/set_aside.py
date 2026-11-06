"""Moves answer-set records aside without ever overwriting a file: a name that is taken gets the next free suffix (.1, .2, ...).
Usage: set_aside.py DEST_DIR FILE [FILE ...]   Prints each destination. Raw results are never deleted or replaced."""
import shutil
import sys
from pathlib import Path

dest = Path(sys.argv[1])
dest.mkdir(parents=True, exist_ok=True)
for src in map(Path, sys.argv[2:]):
    name = "-".join(src.parts[-2:]) if src.parent.name in ("tuck", "tuck-lexical", "A", "B") else src.name
    target, n = dest / name, 0
    while target.exists():
        n += 1
        target = dest / f"{name}.{n}"
    shutil.move(str(src), str(target))
    print(f"{src} -> {target}")
