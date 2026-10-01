"""Shared version floors; a verified baseline is not an exact-version requirement."""

from packaging.version import InvalidVersion, Version

MINIMUM = {"core": "0.37.0", "frontend": "1.52.7"}
VERIFIED = {"core": "0.37.0", "frontend": "1.52.7"}


def require_version(name, version, minimum):
    requirement = f"Fleet requires {name} {minimum} or newer"
    try:
        if not isinstance(version, str):
            raise InvalidVersion(str(version))
        parsed = Version(version)
    except InvalidVersion:
        raise ValueError(f"Cannot read {name} version {version!r}; {requirement}") from None
    if parsed < Version(minimum):
        raise ValueError(f"{requirement}; found {name} {version}")


def require_core(version):
    require_version("ComfyUI", version, MINIMUM["core"])


def controller_compatibility(core, frontend):
    require_core(core)
    require_version("frontend", frontend, MINIMUM["frontend"])
    warnings = []
    if {"core": core, "frontend": frontend} != VERIFIED:
        warnings.append(
            f"Fleet is running with ComfyUI {core} / frontend {frontend}. "
            f"The verified baseline is ComfyUI {VERIFIED['core']} / frontend {VERIFIED['frontend']}; "
            "newer versions are allowed but have not all been verified."
        )
    return {
        "core": core,
        "frontend": frontend,
        "minimum": dict(MINIMUM),
        "verified": dict(VERIFIED),
        "warnings": warnings,
    }
