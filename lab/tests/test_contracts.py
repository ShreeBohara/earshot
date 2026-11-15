"""Parity tests: the fixtures in packages/core/fixtures must mean the same thing here as in Zod.

Pydantic validates in strict JSON mode, so it doesn't coerce types that Zod would reject
(for example the string "5" where an integer is expected).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from earshot_lab import contracts

FIXTURES = Path(__file__).resolve().parents[2] / "packages" / "core" / "fixtures"


def model_for(path: Path) -> type[BaseModel]:
    name = path.name.split(".", 1)[0]
    model: object = getattr(contracts, name, None)
    assert isinstance(model, type) and issubclass(model, BaseModel), f"no model named {name}"
    return model


def fixtures(kind: str) -> list[Path]:
    return sorted((FIXTURES / kind).glob("*.json"))


@pytest.mark.parametrize("path", fixtures("valid"), ids=lambda p: p.name)
def test_valid_fixture_parses(path: Path) -> None:
    model_for(path).model_validate_json(path.read_text(encoding="utf-8"), strict=True)


@pytest.mark.parametrize("path", fixtures("invalid"), ids=lambda p: p.name)
def test_invalid_fixture_is_rejected(path: Path) -> None:
    with pytest.raises(ValidationError):
        model_for(path).model_validate_json(path.read_text(encoding="utf-8"), strict=True)


def test_every_model_has_a_valid_fixture() -> None:
    covered = {p.name.split(".", 1)[0] for p in fixtures("valid")}
    assert set(contracts.__all__) <= covered
