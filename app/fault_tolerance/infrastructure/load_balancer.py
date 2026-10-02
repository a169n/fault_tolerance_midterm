from __future__ import annotations

from typing import Callable, Dict, List

from ...core.eventlog import ft_enabled

_cursor: Dict[str, int] = {}


def ring(pool: str, instances: List[str], is_up: Callable[[str], bool]) -> List[str]:
    candidates = [i for i in instances if is_up(i)] if ft_enabled() else instances  # H1 + S4; baseline is blind
    live = candidates or instances  # all down: try anyway
    n = _cursor.get(pool, 0) % len(live)
    _cursor[pool] = n + 1
    return live[n:] + live[:n]  # rotated: a retry hits the next replica
