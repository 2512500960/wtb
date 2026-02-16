#!/usr/bin/env python3
"""Sign WTB website index payload.json and produce a signed index.json envelope.

The Electron app expects an envelope JSON with:
  - payloadJson: the *exact* raw text of payload.json
  - sigB64: base64 signature over payloadJson bytes (UTF-8)
  - alg: "ed25519" (default)

Default paths (repo layout in dev):
  payload: ./payload.json
  out:     ./wtb-data/web/index.json

Signing backend:
  - Python package: pycryptodome
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import sys
import getpass
from typing import Literal


Alg = Literal["ed25519"]


def _repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent.parent


def _file() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent


# def _default_payload_path() -> pathlib.Path:
#   return _repo_root() / "payload.json"


def _default_payload_path() -> pathlib.Path:
    return _file() / "payload.json"


def _default_web_root() -> pathlib.Path:
    # Matches main process getWebRootDir(): path.join(getAppDataDir(), 'web')
    # In dev, getAppDataDir() => <repo>/wtb-data
    return _repo_root() / "wtb-data" / "web"


def _read_text(p: pathlib.Path) -> str:
    return p.read_text(encoding="utf-8")


def _write_text(p: pathlib.Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _ensure_template_payload(path: pathlib.Path) -> None:
    if path.exists():
        return
    template = {
        "version": 1,
        "generatedAt": "2026-02-16T00:00:00.000Z",
        "rows": [
            {
                "id": 1,
                "url": "http://[xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx]/",
                "desc": "服务说明（例如：论坛/搜索/文件/镜像站）",
                "notice": "公告（可空）",
            }
        ],
    }
    _write_text(path, json.dumps(template, ensure_ascii=False, indent=2) + "\n")


def _load_private_key(
    private_key_pem: bytes,
    *,
    passphrase_bytes: bytes | None,
):
    from Crypto.PublicKey import ECC

    passphrase: str | None = None
    if passphrase_bytes is not None:
        passphrase = passphrase_bytes.decode("utf-8")
    return ECC.import_key(private_key_pem, passphrase=passphrase)


def _require_pycryptodome() -> None:
    try:
        import Crypto  # noqa: F401
    except ModuleNotFoundError as e:
        raise RuntimeError(
            '缺少依赖 pycryptodome。请先执行：python -m pip install pycryptodome',
        ) from e


def _prompt_passphrase_if_needed(
    *,
    private_key_path: pathlib.Path,
    passphrase_env: str | None,
    passphrase: str | None,
) -> str | None:
    if passphrase is not None:
        return passphrase
    if passphrase_env:
        v = os.environ.get(passphrase_env)
        if v is not None and v != "":
            return v
    # As a last resort, prompt.
    return getpass.getpass(
        prompt=f"请输入私钥密码（{private_key_path.name}）：",
    )


def sign_payload(
    payload_text: str,
    private_key_path: pathlib.Path,
    alg: Alg,
    passphrase_env: str | None,
    passphrase: str | None,
) -> str:
    _require_pycryptodome()
    payload = payload_text.encode("utf-8")
    private_key_pem = private_key_path.read_bytes()

    # First try without passphrase; if encrypted, ask for it.
    try:
        key = _load_private_key(private_key_pem, passphrase_bytes=None)
    except (TypeError, ValueError):
        pw = _prompt_passphrase_if_needed(
            private_key_path=private_key_path,
            passphrase_env=passphrase_env,
            passphrase=passphrase,
        )
        if pw is None or pw == "":
            raise RuntimeError("私钥需要密码，但未提供")
        key = _load_private_key(private_key_pem, passphrase_bytes=pw.encode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"不支持的私钥格式/算法：{e}") from e

    if alg != "ed25519":
        raise RuntimeError(f"不支持的 alg：{alg}")

    try:
        from Crypto.Signature import eddsa

        signer = eddsa.new(key, mode="rfc8032")
        sig = signer.sign(payload)
    except Exception as e:
        raise RuntimeError(f"签名失败：{e}") from e
    return base64.b64encode(sig).decode("ascii")


def main(argv: list[str]) -> int:
    # 固定文件路径：
    # - payload.json：仓库根目录（保持不变）
    # - index.json：脚本同目录
    # - 私钥：脚本同目录 index_sign_private.enc.pem
    payload_path = _default_payload_path()
    script_dir = pathlib.Path(__file__).resolve().parent
    private_key_path = script_dir / "index_sign_private.enc.pem"
    out_path = script_dir / "index.json"

    if not payload_path.exists():
        print(f"ERROR: payload 不存在：{payload_path}", file=sys.stderr)
        return 2

    if not private_key_path.exists():
        print(f"ERROR: 私钥不存在：{private_key_path}", file=sys.stderr)
        return 2

    print(f"payload: {payload_path}")
    print(f"私钥:   {private_key_path}")
    print(f"输出:   {out_path}")

    # 仅交互输入一次私钥密码
    password = getpass.getpass("请输入私钥密码（如无密码可直接回车）：")
    if password == "":
        password = None

    payload_text = _read_text(payload_path)

    # 确认 payload.json 是合法 JSON
    try:
        json.loads(payload_text)
    except json.JSONDecodeError as e:
        print(f"ERROR: payload.json 不是合法 JSON：{e}", file=sys.stderr)
        return 2

    # 计算签名（仍然对原始 JSON 文本签名）
    try:
        sig_b64 = sign_payload(
            payload_text,
            private_key_path=private_key_path,
            alg="ed25519",
            passphrase_env=None,
            passphrase=password,
        )
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: 签名失败：{e}", file=sys.stderr)
        return 3

    # payloadJson 字段改为 base64 编码后的 JSON 文本
    payload_b64 = base64.b64encode(payload_text.encode("utf-8")).decode("ascii")
    env = {
        "payloadJson": payload_b64,
        "sigB64": sig_b64,
        "alg": "ed25519",
    }

    out_text = json.dumps(env, ensure_ascii=False, indent=2) + "\n"
    _write_text(out_path, out_text)

    print(f"已生成签名索引：{out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
