#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 KToolBox 源码提取 API 定义，输出 JSON（纯 AST 解析，零第三方依赖，兼容 Python 3.8）。

提取对象（两类全要）：
  1. PawchiveClient 对外 API（ktoolbox/api/client.py 的 14 个方法）
     —— HTTP 方法 + URL 模板 + 完整参数列表（名称/类型/必填/默认/in）+ 返回值模型及字段
  2. WebUI FastAPI 路由（ktoolbox/webui/*.py 的 @router.* 装饰器）
     —— 路径 + HTTP 方法 + 参数（名称/类型/必填/默认/in: query|path|body|header|depends）+ response_model 及字段
  3. pydantic 模型字段字典（api/parameters.py + api/generated/models.py + webui 各 models）
     —— 供 1/2 的参数与返回值展开为「完整字段列表」，也单独输出一份 ktool-models.json

用法：
  python3 tools/extract-ktool-apis.py [--repo 上游源码根] [--outdir 输出目录]

输出（每模块一个 JSON）：
  ktool-api-client.json   —— PawchiveClient 方法清单
  ktool-webui-routes.json —— WebUI 路由清单
  ktool-models.json       —— 全部 pydantic 模型字段字典
"""

import argparse
import ast
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# 小型 AST → 字符串 转换（替代 3.9+ 的 ast.unparse，兼容 3.8）
# ---------------------------------------------------------------------------

def unparse(node):
    """把 AST 节点转回源代码片段。覆盖本项目用到的子集：Name/Attribute/Subscript/
    BinOp/Tuple/List/Call/Constant/JoinedStr/Index（类型注解与默认值场景足够）。"""
    if node is None:
        return None
    if isinstance(node, ast.Index):  # Python 3.8：Subscript.slice 是 Index 包装
        return unparse(node.value)
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return unparse(node.value) + "." + node.attr
    if isinstance(node, ast.Constant):
        if isinstance(node.value, str):
            return repr(node.value)
        return str(node.value)
    if isinstance(node, ast.Subscript):
        return unparse(node.value) + "[" + unparse(node.slice) + "]"
    if isinstance(node, ast.Tuple):
        return "(" + ", ".join(unparse(e) for e in node.elts) + ")"
    if isinstance(node, ast.List):
        return "[" + ", ".join(unparse(e) for e in node.elts) + "]"
    if isinstance(node, ast.BinOp):
        op = {ast.BitOr: "|", ast.Add: "+", ast.Sub: "-"}.get(type(node.op), "?")
        return unparse(node.left) + " " + op + " " + unparse(node.right)
    if isinstance(node, ast.Call):
        args = [unparse(a) for a in node.args]
        kwargs = [kw.arg + "=" + unparse(kw.value) for kw in node.keywords if kw.arg]
        return unparse(node.func) + "(" + ", ".join(args + kwargs) + ")"
    if isinstance(node, ast.JoinedStr):
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(str(v.value))
            else:
                parts.append("{" + unparse(v) + "}")
        return "".join(parts)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return "-" + unparse(node.operand)
    # 兜底：打印节点类型，避免崩溃
    return "<" + type(node).__name__ + ">"


# ---------------------------------------------------------------------------
# 1) pydantic 模型提取（含继承合并、字段 docstring 描述、Annotated/Field 参数）
# ---------------------------------------------------------------------------

def _field_base_and_args(annotation):
    """解析类型注解：Annotated[X, Field(...)] → (X 字符串, {field 参数})；普通注解 → (注解, {})。"""
    if isinstance(annotation, ast.Subscript) and isinstance(annotation.value, ast.Name) \
            and annotation.value.id == "Annotated":
        slice_node = annotation.slice.value if isinstance(annotation.slice, ast.Index) else annotation.slice
        if isinstance(slice_node, ast.Tuple):
            base = slice_node.elts[0]
            field_args = {}
            for elt in slice_node.elts[1:]:
                if isinstance(elt, ast.Call) and isinstance(elt.func, ast.Name) and elt.func.id == "Field":
                    for kw in elt.keywords:
                        if kw.arg:
                            field_args[kw.arg] = unparse(kw.value)
            return unparse(base), field_args
    return unparse(annotation), {}


def _model_fields(model_name, tree, seen=None):
    """从 AST 提取单个 pydantic 类的字段；父类字段合并（继承优先=自己覆盖父类）。"""
    if seen is None:
        seen = []
    if model_name in seen:
        return {}  # 防循环继承
    seen = seen + [model_name]
    fields = {}
    bases = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == model_name:
            for base in node.bases:
                if isinstance(base, ast.Name):
                    bases.append(base.id)
            body = node.body
            # 逐条语句：AnnAssign 收集字段，其后的字符串常量收为该字段描述
            pending_desc = None
            for stmt in body:
                if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) \
                        and isinstance(stmt.value.value, str):
                    pending_desc = stmt.value.value.strip().replace("\n", " ")
                    continue
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    name = stmt.target.id
                    base_type, field_args = _field_base_and_args(stmt.annotation)
                    # 必填判定：无赋值（=必填）；Optional[..] 或 默认 None（=可选）
                    if stmt.value is None:
                        default = None
                        required = True
                    else:
                        default = unparse(stmt.value)
                        required = False
                    # Optional[X] = None 显式标记可选（pydantic 语义）
                    desc = field_args.pop("description", None) or pending_desc
                    field_info = {
                        "name": name,
                        "type": base_type,
                        "required": required,
                        "default": default,
                        "description": desc,
                    }
                    for k in ("min_length", "max_length", "pattern", "ge", "le", "gt", "lt"):
                        if k in field_args:
                            field_info[k] = field_args[k]
                    fields[name] = field_info
                    pending_desc = None
            break
    # 合并父类字段（父类在前，自己覆盖）
    merged = {}
    for base in bases:
        merged.update(_model_fields(base, tree, seen))
    merged.update(fields)
    return merged


def extract_models(tree, module_name):
    """提取一个模块内全部 pydantic 模型（继承 BaseModel / 有 AnnAssign 字段的类）。"""
    models = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            is_model = any(isinstance(b, ast.Name) and b.id == "BaseModel" for b in node.bases) \
                or any(isinstance(b, ast.Name) and b.id in ("BaseModel", "RootModel") for b in node.bases)
            has_fields = any(isinstance(s, ast.AnnAssign) for s in node.body)
            if is_model or has_fields:
                fields = _model_fields(node.name, tree)
                if fields or is_model:
                    models[node.name] = {
                        "module": module_name,
                        "fields": list(fields.values()),
                    }
    return models


# ---------------------------------------------------------------------------
# 2) PawchiveClient 对外方法提取
# ---------------------------------------------------------------------------

def _positional_default(defaults, arg_index, total_args):
    """按位置取位置参数默认值节点；无默认返回 None（None 亦表示"没有默认值"，区分于 Constant(None)）。"""
    n = len(defaults)
    if n == 0:
        return None
    start = total_args - n  # 默认值从末尾参数开始对齐
    if arg_index >= start:
        return defaults[arg_index - start]
    return None


def _fstring_template(node):
    """把 f-string（JoinedStr）转成 URL 模板：{self._segment(parameters.service)} → {service}。"""
    parts = []
    for v in node.values:
        if isinstance(v, ast.Constant):
            parts.append(str(v.value))
        else:
            # 递归找形如 parameters.xxx / parameters["xxx"] 的引用作为占位名
            placeholder = None
            stack = [v]
            while stack:
                cur = stack.pop()
                if isinstance(cur, ast.Attribute) and isinstance(cur.value, ast.Name) \
                        and cur.value.id == "parameters":
                    placeholder = cur.attr
                    break
                if isinstance(cur, ast.Subscript) and isinstance(cur.value, ast.Name) \
                        and cur.value.id == "parameters":
                    placeholder = unparse(cur.slice).strip("'\"")
                    break
                stack.extend(list(ast.iter_child_nodes(cur)))
            parts.append("{" + (placeholder or "?") + "}")
    return "".join(parts)


def _method_url_and_verb(body):
    """在方法体里找 self._request("GET", <path>)：返回 (http_method, url_template)。"""
    for node in ast.walk(body):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "self" \
                and node.func.attr == "_request":
            if not node.args:
                continue
            method = node.args[0].value if isinstance(node.args[0], ast.Constant) else None
            path_node = node.args[1] if len(node.args) > 1 else None
            if isinstance(path_node, ast.JoinedStr):
                return method, _fstring_template(path_node)
            if isinstance(path_node, ast.Name):
                # path = f"..." 赋值
                for assign in ast.walk(body):
                    if isinstance(assign, ast.Assign) and any(
                            isinstance(t, ast.Name) and t.id == path_node.id for t in assign.targets):
                        if isinstance(assign.value, ast.JoinedStr):
                            return method, _fstring_template(assign.value)
            if isinstance(path_node, ast.Constant):
                return method, str(path_node.value)
    return None, None


def extract_client_methods(tree, models):
    """提取 PawchiveClient 的对外方法（跳过下划线私有与 dunder）。"""
    methods = []
    client_node = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "PawchiveClient":
            client_node = node
            break
    if client_node is None:
        return methods
    for node in client_node.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        name = node.name
        if name.startswith("_"):  # _request/_url/_segment/... 与 dunder
            continue
        method, url_template = _method_url_and_verb(node)
        if method is None:
            continue  # 未调用 self._request 的生命周期/辅助方法（aclose 等）不收录
        params = []
        total_args = len(node.args.args)
        for idx, arg in enumerate(node.args.args):
            if arg.arg == "self":  # 实例方法第一个参数不属 API 参数
                continue
            dflt = _positional_default(node.args.defaults, idx, total_args)
            p = {
                "name": arg.arg,
                "type": unparse(arg.annotation) if arg.annotation else None,
                "required": dflt is None,
                "default": unparse(dflt) if dflt else None,
            }
            # in 推断：URL 模板里出现 → path；否则 query（本项目无 body 参数）
            p["in"] = "path" if url_template and "{" + arg.arg + "}" in url_template else "query"
            params.append(p)
        # keyword-only 参数（*, query: str | None = None）——默认值在 kw_defaults，元素 None=无默认
        for idx, arg in enumerate(node.args.kwonlyargs):
            dflt = node.args.kw_defaults[idx] if idx < len(node.args.kw_defaults) else None
            p = {
                "name": arg.arg,
                "type": unparse(arg.annotation) if arg.annotation else None,
                "required": dflt is None,
                "default": unparse(dflt) if dflt else None,
            }
            p["in"] = "path" if url_template and "{" + arg.arg + "}" in url_template else "query"
            params.append(p)
        # 返回模型展开
        returns = unparse(node.returns) if node.returns else None
        return_model = None
        return_fields = None
        if returns:
            base = returns.replace("list[", "").rstrip("]").strip()
            if base in models:
                return_model = base
                return_fields = [f["name"] for f in models[base]["fields"]]
        methods.append({
            "name": name,
            "http_method": method,
            "url_template": url_template,
            "params": params,
            "returns": {
                "type": returns,
                "model": return_model,
                "fields": return_fields,
            },
        })
    return methods


# ---------------------------------------------------------------------------
# 3) WebUI FastAPI 路由提取
# ---------------------------------------------------------------------------

_HTTP_VERBS = ("get", "post", "put", "delete", "patch", "options", "head")


def _route_inference(param_annotation, path_template, models):
    """推断 FastAPI 参数位置：Annotated 元数据 > 路径占位 > 默认 query。"""
    if isinstance(param_annotation, ast.Subscript) and isinstance(param_annotation.value, ast.Name) \
            and param_annotation.value.id == "Annotated":
        slice_node = param_annotation.slice.value if isinstance(param_annotation.slice, ast.Index) \
            else param_annotation.slice
        if isinstance(slice_node, ast.Tuple):
            for elt in slice_node.elts[1:]:
                if isinstance(elt, ast.Call) and isinstance(elt.func, ast.Name):
                    fn = elt.func.id
                    if fn in ("Query",):
                        return "query"
                    if fn == "Path":
                        return "path"
                    if fn == "Header":
                        return "header"
                    if fn == "Body":
                        return "body"
                    if fn == "Depends":
                        return "depends"
    return None  # 无 Annotated，交由调用方按占位/类型判断


def _router_prefix(owner_func_node, tree):
    """找 APIRouter(prefix=...) 的 prefix：优先路由所在函数体内，其次模块级。"""
    candidates = []
    if owner_func_node is not None:
        candidates.append(owner_func_node)
    candidates.append(tree)
    for scope in candidates:
        for node in ast.walk(scope):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                    and node.func.id == "APIRouter":
                for kw in node.keywords:
                    if kw.arg == "prefix" and isinstance(kw.value, ast.Constant) \
                            and isinstance(kw.value.value, str):
                        return kw.value.value
    return ""


def extract_webui_routes(tree, module_name, models):
    """提取一个模块内所有 @router.<verb>(...) 装饰的路由。"""
    routes = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        decorator = None
        for dec in node.decorator_list:
            if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) \
                    and dec.func.attr in _HTTP_VERBS:
                decorator = dec
                break
        if decorator is None:
            continue
        method = decorator.func.attr
        path_template = None
        response_model = None
        status_code = None
        summary = None
        if decorator.args:
            arg0 = decorator.args[0]
            if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                path_template = arg0.value
            elif isinstance(arg0, ast.JoinedStr):  # f-string 前缀路径
                path_template = unparse(arg0)
            else:
                path_template = unparse(arg0)
        for kw in decorator.keywords:
            if kw.arg == "response_model":
                response_model = unparse(kw.value)
            elif kw.arg == "status_code":
                status_code = unparse(kw.value)
            elif kw.arg == "summary":
                summary = kw.value.value if isinstance(kw.value, ast.Constant) else None
        # 函数 docstring 首行兜底 summary
        if summary is None and node.body and isinstance(node.body[0], ast.Expr) \
                and isinstance(node.body[0].value, ast.Constant):
            summary = node.body[0].value.value.strip().split("\n")[0]
        params = []
        all_args = list(node.args.args) + list(node.args.kwonlyargs)
        for arg in all_args:
            if arg.arg in ("request", "response", "background_tasks", "websocket"):
                continue
            ann = arg.annotation
            inferred = _route_inference(ann, path_template, models) if ann else None
            dflt = None
            if arg in node.args.args:
                dflt = _positional_default(node.args.defaults, node.args.args.index(arg), len(node.args.args))
            elif arg in node.args.kwonlyargs:
                dflt = node.args.kw_defaults[node.args.kwonlyargs.index(arg)]
            p = {
                "name": arg.arg,
                "type": unparse(ann) if ann else None,
                "required": dflt is None,
                "default": unparse(dflt) if dflt else None,
                "in": inferred or ("path" if path_template and "{" + arg.arg + "}" in path_template else "query"),
            }
            params.append(p)
        # response_model 展开字段
        resp_fields = None
        if response_model:
            base = response_model.replace("list[", "").rstrip("]").strip()
            if base in models:
                resp_fields = [f["name"] for f in models[base]["fields"]]
        prefix = _router_prefix(node, tree)
        full_path = prefix + (path_template or "")
        routes.append({
            "path": path_template,
            "full_path": full_path,
            "prefix": prefix,
            "method": method.upper(),
            "module": module_name,
            "handler": node.name,
            "summary": summary,
            "status_code": status_code,
            "response_model": response_model,
            "response_fields": resp_fields,
            "params": params,
        })
    return routes


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def parse_file(path):
    with open(path, encoding="utf-8") as fh:
        return ast.parse(fh.read(), filename=str(path))


def relative_module(repo_root, file_path):
    rel = file_path.relative_to(repo_root)
    parts = list(rel.parts)
    if parts[-1] == "__init__.py":
        parts = parts[:-1]
    else:
        parts[-1] = parts[-1][:-3]  # 去 .py
    return ".".join(parts)


def main():
    parser = argparse.ArgumentParser(description="从 KToolBox 源码提取 API 定义输出 JSON（纯 AST，零依赖）")
    parser.add_argument("--repo", default=None,
                        help="ktool 源码根目录（含 ktoolbox/ 的目录）；默认取脚本同级 ../.probe-ktoolbox")
    parser.add_argument("--outdir", default=None,
                        help="JSON 输出目录；默认与脚本同目录")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    repo_root = Path(args.repo).resolve() if args.repo else (script_dir.parent / ".probe-ktoolbox").resolve()
    outdir = Path(args.outdir).resolve() if args.outdir else script_dir
    if not (repo_root / "ktoolbox").is_dir():
        print(f"错误：{repo_root} 下没有 ktoolbox/ 目录（--repo 指定上游源码根）", file=sys.stderr)
        sys.exit(1)

    # 收集模型（顺序：api/parameters + api/generated + webui 全部 models，让路由/方法展开时模型齐全）
    models = {}
    api_dir = repo_root / "ktoolbox" / "api"
    for f in (api_dir / "parameters.py", api_dir / "generated" / "models.py"):
        if f.is_file():
            tree = parse_file(f)
            models.update(extract_models(tree, relative_module(repo_root, f)))
    for f in sorted((repo_root / "ktoolbox" / "webui").glob("*.py")):
        tree = parse_file(f)
        models.update(extract_models(tree, relative_module(repo_root, f)))

    # client 方法
    client_file = api_dir / "client.py"
    client_methods = []
    base_url = "https://pawchive.pw/api/v1"
    if client_file.is_file():
        tree = parse_file(client_file)
        client_methods = extract_client_methods(tree, models)
        # base_url：DEFAULT_API_BASE_URL 常量
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "DEFAULT_API_BASE_URL" for t in node.targets):
                if isinstance(node.value, ast.Constant):
                    base_url = str(node.value.value)

    # webui 路由
    webui_routes = []
    for f in sorted((repo_root / "ktoolbox" / "webui").glob("*.py")):
        tree = parse_file(f)
        webui_routes.extend(extract_webui_routes(tree, relative_module(repo_root, f), models))
    webui_routes.sort(key=lambda r: (r["path"] or "", r["method"]))

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    meta = {
        "generator": "tools/extract-ktool-apis.py",
        "source_repo": str(repo_root),
        "extracted_at": now,
        "python_version": sys.version.split()[0],
    }

    # 输出 1：client API
    client_payload = {
        "meta": meta,
        "client_class": "PawchiveClient",
        "module": "ktoolbox.api.client",
        "base_url": base_url,
        "methods": client_methods,
    }
    (outdir / "ktool-api-client.json").write_text(
        json.dumps(client_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # 输出 2：webui 路由
    routes_payload = {
        "meta": meta,
        "count": len(webui_routes),
        "routes": webui_routes,
    }
    (outdir / "ktool-webui-routes.json").write_text(
        json.dumps(routes_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # 输出 3：模型字段字典
    models_payload = {
        "meta": meta,
        "count": len(models),
        "models": models,
    }
    (outdir / "ktool-models.json").write_text(
        json.dumps(models_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"✓ 输出目录: {outdir}")
    print(f"✓ client 方法: {len(client_methods)} 条 → ktool-api-client.json")
    print(f"✓ webui 路由: {len(webui_routes)} 条 → ktool-webui-routes.json")
    print(f"✓ 模型: {len(models)} 个 → ktool-models.json")


if __name__ == "__main__":
    main()
