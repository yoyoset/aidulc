"""
core/schema.py —— 书包结构定义 + schemaVersion + 对 contracts/ 的校验

三端 conformance 纪律 (R3):
- contracts/bookpack.schema.json 是唯一真相源
- Python 侧在包安装时把 schema 复制进 aidulc_prep/schemas/ (见 scripts/sync_schema)
- validate_bookpack / validate_job_request / validate_progress 都是纯校验函数
"""
from __future__ import annotations

import json
import os
from typing import Any

_SCHEMA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "schemas")

SUPPORTED_BOOKPACK_VERSION = 1


class SchemaError(ValueError):
    """书包/请求/进度行不符合契约"""


def _load_schema(name: str) -> dict:
    path = os.path.join(_SCHEMA_DIR, name)
    if not os.path.exists(path):
        raise SchemaError(f"schema 缺失: {path} (运行 scripts/sync_schema.ps1)")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _validate(obj: Any, schema: dict) -> list[str]:
    """极简 JSON-Schema 校验 (draft-07 子集): required / type / const / enum / items /
    properties / $ref / allOf / if-then。完整校验留给测试期用 jsonschema 库; 运行时用这个轻量版保速度。"""
    errors: list[str] = []
    _walk(obj, schema, "$", errors)
    return errors


def _validate_against(obj: Any, sub_schema: dict, root: dict) -> bool:
    """只判断 obj 是否满足 sub_schema (用于 if 条件), 不收集错误。"""
    if isinstance(sub_schema, dict) and sub_schema.get("properties"):
        for key, sub in sub_schema["properties"].items():
            if key not in obj:
                return False
            if not _validate_against(obj[key], sub, root):
                return False
        return True
    if isinstance(sub_schema, dict) and sub_schema.get("const") is not None:
        return obj == sub_schema["const"]
    return True


def _resolve_ref(schema: dict, root: dict) -> dict:
    ref = schema.get("$ref")
    if not ref:
        return schema
    if ref.startswith("#/definitions/"):
        name = ref[len("#/definitions/"):]
        return root.get("definitions", {}).get(name, schema)
    return schema


def _walk(obj: Any, schema: dict, path: str, errors: list[str], root: dict | None = None):
    if root is None:
        root = schema
    schema = _resolve_ref(schema, root)

    if "allOf" in schema:
        for sub in schema["allOf"]:
            _walk(obj, sub, path, errors, root)
        # 注意: 不 return, 继续走 type/properties 分支 (progress 根 schema 同时有 properties 和 allOf)

    # if/then 条件分支 (progress.schema.json 用)
    if "if" in schema:
        if _validate_against(obj, schema["if"], root):
            if "then" in schema:
                _walk(obj, schema["then"], path, errors, root)
        return
    if "const" in schema:
        if obj != schema["const"]:
            errors.append(f"{path}: 期望 const={schema['const']}, 实得 {obj!r}")
        return
    if "enum" in schema:
        if obj not in schema["enum"]:
            errors.append(f"{path}: 期望 enum={schema['enum']}, 实得 {obj!r}")
        return
    if "required" in schema and "type" not in schema:
        # 裸 required (if/then 条件里的 then), 只查字段存在性
        if isinstance(obj, dict):
            for req in schema["required"]:
                if req not in obj:
                    errors.append(f"{path}.{req}: 缺少 required 字段")
        return

    if "type" in schema:
        t = schema["type"]
        if t == "object":
            if not isinstance(obj, dict):
                errors.append(f"{path}: 期望 object, 实得 {type(obj).__name__}")
                return
            for req in schema.get("required", []):
                if req not in obj:
                    errors.append(f"{path}.{req}: 缺少 required 字段")
            for key, sub in schema.get("properties", {}).items():
                if key in obj:
                    _walk(obj[key], sub, f"{path}.{key}", errors, root)
            if schema.get("additionalProperties") is False:
                for extra in obj.keys() - schema.get("properties", {}).keys():
                    errors.append(f"{path}.{extra}: 未知字段")
        elif t == "array":
            if not isinstance(obj, list):
                errors.append(f"{path}: 期望 array, 实得 {type(obj).__name__}")
                return
            items = schema.get("items", {})
            for i, item in enumerate(obj):
                _walk(item, items, f"{path}[{i}]", errors, root)
        elif t == "string":
            if not isinstance(obj, str):
                errors.append(f"{path}: 期望 string, 实得 {type(obj).__name__}")
        elif t == "integer":
            if not isinstance(obj, int) or isinstance(obj, bool):
                errors.append(f"{path}: 期望 integer, 实得 {type(obj).__name__}")
        elif t == "number":
            if not isinstance(obj, (int, float)) or isinstance(obj, bool):
                errors.append(f"{path}: 期望 number, 实得 {type(obj).__name__}")
        elif t == "boolean":
            if not isinstance(obj, bool):
                errors.append(f"{path}: 期望 boolean, 实得 {type(obj).__name__}")
        elif t == "null":
            if obj is not None:
                errors.append(f"{path}: 期望 null")


def validate_bookpack(bookpack: dict) -> list[str]:
    """返回错误列表; 空 = 合法。schemaVersion > SUPPORTED 报错 (明确拒绝, 不尽力解析)。"""
    schema = _load_schema("bookpack.schema.json")
    if bookpack.get("schemaVersion", 0) > SUPPORTED_BOOKPACK_VERSION:
        return [f"schemaVersion={bookpack['schemaVersion']} 高于支持版本 {SUPPORTED_BOOKPACK_VERSION}, 明确拒绝"]
    return _validate(bookpack, schema)


def validate_job_request(job: dict) -> list[str]:
    schema = _load_schema("job_request.schema.json")
    return _validate(job, schema)


def validate_progress(line: dict) -> list[str]:
    schema = _load_schema("progress.schema.json")
    return _validate(line, schema)
