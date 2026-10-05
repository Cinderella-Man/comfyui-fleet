"""Lossless JSON snapshots. Each delta refers directly to its revision's base."""

import copy

from .validation import canonical


def difference(base, value):
    changes = []

    def visit(old, new, path):
        if not isinstance(old, (dict, list)) and type(old) is type(new) and old == new:
            return
        if isinstance(old, dict) and isinstance(new, dict):
            for key in old.keys() - new.keys():
                changes.append([path + [key]])
            for key, item in new.items():
                if key in old:
                    visit(old[key], item, path + [key])
                else:
                    changes.append([path + [key], item])
        elif isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
            for index, item in enumerate(new):
                visit(old[index], item, path + [index])
        else:
            changes.append([path, new])

    visit(base, value, [])
    delta, full = canonical({"changes": changes}), canonical({"full": value})
    return delta if len(delta.encode()) < len(full.encode()) else full


def reconstruct(base, delta):
    if "full" in delta:
        return copy.deepcopy(delta["full"])
    value = copy.deepcopy(base)
    for change in delta["changes"]:
        path = change[0]
        if not path:
            value = copy.deepcopy(change[1])
            continue
        parent = value
        for key in path[:-1]:
            parent = parent[key]
        if len(change) == 1:
            del parent[path[-1]]
        else:
            parent[path[-1]] = copy.deepcopy(change[1])
    return value
