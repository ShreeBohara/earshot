"""Generate Pydantic models from the JSON Schemas exported by packages/core.

Run through `pnpm contracts:gen` from the repo root, which exports the schemas first.
"""

from __future__ import annotations

import re
from pathlib import Path

from datamodel_code_generator import PythonVersion, generate
from datamodel_code_generator.enums import DataModelType, InputFileType
from datamodel_code_generator.format import Formatter

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "packages" / "core" / "schemas"
OUT = ROOT / "lab" / "src" / "earshot_lab" / "contracts"


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.py"):
        old.unlink()

    exports: list[tuple[str, str]] = []
    for schema in sorted(SCHEMAS.glob("*.json")):
        name = schema.stem
        module = snake(name)
        generate(
            schema.read_text(encoding="utf-8"),
            input_file_type=InputFileType.JsonSchema,
            input_filename=schema.name,
            output=OUT / f"{module}.py",
            output_model_type=DataModelType.PydanticV2BaseModel,
            target_python_version=PythonVersion.PY_313,
            use_standard_collections=True,
            use_union_operator=True,
            use_annotated=True,
            field_constraints=True,
            formatters=[Formatter.BUILTIN],
            disable_timestamp=True,
            class_name=name,
        )
        exports.append((module, name))

    lines = [
        '"""Generated from packages/core/schemas. Do not edit; run `pnpm contracts:gen`."""',
        "",
        *(f"from .{module} import {name}" for module, name in exports),
        "",
        "__all__ = [" + ", ".join(f'"{name}"' for _, name in exports) + "]",
        "",
    ]
    (OUT / "__init__.py").write_text("\n".join(lines), encoding="utf-8")
    print(f"generated {len(exports)} models in lab/src/earshot_lab/contracts")


if __name__ == "__main__":
    main()
