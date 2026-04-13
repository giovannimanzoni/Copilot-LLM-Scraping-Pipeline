import random


def to_fim(code: str) -> str:
    lines = code.split("\n")
    if len(lines) < 6:
        return code
    total = len(lines)
    a = random.randint(max(1, total // 6), total // 3)
    b = random.randint(total // 2, min(total - 1, 5 * total // 6))
    prefix = "\n".join(lines[:a])
    middle = "\n".join(lines[a:b])
    suffix = "\n".join(lines[b:])
    return f"<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>{middle}<|eot_id|>"
