from __future__ import annotations

import argparse
from ipaddress import ip_address
import json
import sys
from collections import OrderedDict
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlsplit
from typing import Any
import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]

DEFAULT_URL = "https://publicpeers.neilalexander.dev/"


DEFAULT_PREFER_SCHEMES = ["tls", "quic", "wss", "ws", "tcp"]
DEFAULT_MAX_PER_COUNTRY = 5


def _collapse_ws(value: str) -> str:
    return " ".join(value.split())


class PublicPeersHTMLParser(HTMLParser):
    """Extract peers from the public peers HTML page.

    The page structure is roughly:
      <th id='country'>country</th>
      <tr class='statusgood'>
        <td id='address'>...</td>
        <td id='status'>...</td>
        <td id='reliability'>...</td>
      </tr>
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.current_country: str | None = None
        self._in_country_th = False
        self._country_buf: list[str] = []

        self._cell_kind: str | None = None
        self._cell_buf: list[str] = []

        self._current_row: dict[str, str | None] | None = None
        self._current_row_class: str | None = None

        self.results_full: "OrderedDict[str, list[dict[str, str]]]" = OrderedDict()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {k: v for k, v in attrs}

        if tag == "th" and attrs_dict.get("id") == "country":
            self._in_country_th = True
            self._country_buf = []
            return

        if tag == "tr":
            cls = attrs_dict.get("class") or ""
            self._current_row_class = _collapse_ws(cls)
            self._current_row = {"address": None, "status": None, "reliability": None}
            return

        if tag == "td":
            cell_id = attrs_dict.get("id")
            if cell_id in {"address", "status", "reliability"}:
                self._cell_kind = cell_id
                self._cell_buf = []

    def handle_data(self, data: str) -> None:
        if self._in_country_th:
            self._country_buf.append(data)
        if self._cell_kind is not None:
            self._cell_buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "th" and self._in_country_th:
            country = _collapse_ws("".join(self._country_buf)).strip()
            self.current_country = country or None
            self._in_country_th = False
            self._country_buf = []
            return

        if tag == "td" and self._cell_kind is not None:
            value = _collapse_ws("".join(self._cell_buf)).strip()
            if self._current_row is not None:
                self._current_row[self._cell_kind] = value or None
            self._cell_kind = None
            self._cell_buf = []
            return

        if tag == "tr" and self._current_row is not None:
            address = self._current_row.get("address")
            if address:
                # The upstream page uses row classes like "statusgood" / "statusbad".
                # Drop nodes that are not marked as good to avoid injecting unusable peers.
                row_class = (self._current_row_class or "").lower()
                status = (self._current_row.get("status") or "").strip().lower()
                reliability = (self._current_row.get("reliability") or "").strip().lower()

                def _looks_usable() -> bool:
                    if "statusgood" in row_class:
                        return True
                    if "statusbad" in row_class:
                        return False
                    # Fallback heuristics when class changes.
                    if status in {"good", "up", "online", "ok"}:
                        return True
                    m = re.search(r"([0-9]+(?:\.[0-9]+)?)%", reliability)
                    if m:
                        try:
                            return float(m.group(1)) > 0.0
                        except ValueError:
                            return False
                    return False

                if not _looks_usable():
                    self._current_row = None
                    self._current_row_class = None
                    return

                country = self.current_country or "(unknown)"
                entry = {
                    "address": address,
                    "status": self._current_row.get("status") or "",
                    "reliability": self._current_row.get("reliability") or "",
                    "class": self._current_row_class or "",
                }
                self.results_full.setdefault(country, []).append(entry)

            self._current_row = None
            self._current_row_class = None


def parse_public_peers_html(html: str) -> "OrderedDict[str, list[dict[str, str]]]":
    parser = PublicPeersHTMLParser()
    parser.feed(html)
    parser.close()
    return parser.results_full


def _try_requests_get(url: str, timeout_s: int = 20) -> str:
    try:
        import requests  # type: ignore

        resp = requests.get(url, timeout=timeout_s)
        resp.raise_for_status()
        return resp.text
    except ModuleNotFoundError:
        raise RuntimeError(
            "Python package 'requests' is not installed. "
            "Either install it (pip install requests) or use --file/--stdin."
        )
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Failed to fetch URL: {e}")


def load_input_from_args(args: argparse.Namespace) -> str:
    if args.file:
        with open(args.file, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    if args.stdin:
        return sys.stdin.read()
    return _try_requests_get(args.url)


def detect_input_format(data: str) -> str:
    # Cheap heuristic: HTML from publicpeers contains table tags.
    sample = data[:2048].lower()
    if "<th" in sample or "<tr" in sample or "<html" in sample:
        return "html"
    return "text"


def parse_text_grouped_addresses(text: str) -> "OrderedDict[str, list[str]]":
    grouped: "OrderedDict[str, list[str]]" = OrderedDict()
    current_country: str = "(unknown)"
    grouped[current_country] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        if line.startswith("[") and line.endswith("]") and len(line) >= 3:
            country = line[1:-1].strip().lower()
            current_country = country or "(unknown)"
            grouped.setdefault(current_country, [])
            continue

        # Accept formats like "- url" or "* url".
        if line.startswith("- ") or line.startswith("* "):
            addr = line[2:].strip()
        else:
            # Also accept bare URLs without leading dash.
            addr = line

        if addr:
            grouped.setdefault(current_country, []).append(addr)

    # Drop empty default bucket if it remained unused.
    if grouped.get("(unknown)") == []:
        grouped.pop("(unknown)")

    return grouped


def _scheme_rank(scheme: str, prefer: list[str]) -> int:
    scheme = (scheme or "").lower()
    try:
        return prefer.index(scheme)
    except ValueError:
        return len(prefer) + 10


def _service_id(addr: str) -> tuple[str, str]:
    """Return a coarse 'service identity' for de-dup.

    Heuristic: same hostname/IP (+ optional ?key=) is treated as same service.
    """
    try:
        u = urlsplit(addr)
        host = (u.hostname or "").lower()
        if not host:
            return (addr, "")
        q = parse_qs(u.query)
        key = (q.get("key", [""])[0] or "").lower()
        return (host, key)
    except Exception:  # noqa: BLE001
        return (addr, "")


def dedupe_and_limit_grouped(
    grouped: "OrderedDict[str, list[str]]",
    *,
    dedupe: bool,
    max_per_country: int,
    prefer_schemes: list[str],
) -> "OrderedDict[str, list[str]]":
    out: "OrderedDict[str, list[str]]" = OrderedDict()

    for country, addrs in grouped.items():
        if not dedupe and (max_per_country is None or max_per_country <= 0):
            out[country] = list(addrs)
            continue

        best_by_service: "OrderedDict[tuple[str, str], str]" = OrderedDict()
        first_seen_index: dict[tuple[str, str], int] = {}

        for idx, addr in enumerate(addrs):
            sid = _service_id(addr)
            if sid not in first_seen_index:
                first_seen_index[sid] = idx

            if not dedupe:
                # When only limiting, keep unique-by-index behavior by making sid unique.
                sid = (sid[0], f"{sid[1]}#{idx}")

            current = best_by_service.get(sid)
            if current is None:
                best_by_service[sid] = addr
                continue

            # Prefer better transport scheme.
            try:
                cur_scheme = urlsplit(current).scheme
                new_scheme = urlsplit(addr).scheme
            except Exception:  # noqa: BLE001
                cur_scheme = ""
                new_scheme = ""

            if _scheme_rank(new_scheme, prefer_schemes) < _scheme_rank(cur_scheme, prefer_schemes):
                best_by_service[sid] = addr

        chosen = list(best_by_service.items())

        # Sort by preference first, then by original order to keep stable.
        def _sort_key(item: tuple[tuple[str, str], str]) -> tuple[int, int]:
            sid, addr = item
            try:
                scheme = urlsplit(addr).scheme
            except Exception:  # noqa: BLE001
                scheme = ""
            return (
                _scheme_rank(scheme, prefer_schemes),
                first_seen_index.get(sid, 1_000_000),
            )

        chosen.sort(key=_sort_key)
        selected_addrs = [addr for _, addr in chosen]

        if max_per_country and max_per_country > 0:
            selected_addrs = selected_addrs[:max_per_country]

        out[country] = selected_addrs

    return out


def dedupe_and_limit_full(
    full: "OrderedDict[str, list[dict[str, str]]]",
    *,
    dedupe: bool,
    max_per_country: int,
    prefer_schemes: list[str],
) -> "OrderedDict[str, list[dict[str, str]]]":
    if not dedupe and (max_per_country is None or max_per_country <= 0):
        return full

    out: "OrderedDict[str, list[dict[str, str]]]" = OrderedDict()

    for country, entries in full.items():
        # Track stable original order.
        def _addr(e: dict[str, str]) -> str:
            return e.get("address") or ""

        first_seen_index: dict[tuple[str, str], int] = {}

        best_by_service: "OrderedDict[tuple[str, str], dict[str, str]]" = OrderedDict()
        for idx, e in enumerate(entries):
            addr = _addr(e)
            if not addr:
                continue

            sid = _service_id(addr)
            if sid not in first_seen_index:
                first_seen_index[sid] = idx

            if not dedupe:
                sid = (sid[0], f"{sid[1]}#{idx}")

            cur = best_by_service.get(sid)
            if cur is None:
                best_by_service[sid] = e
                continue

            try:
                cur_scheme = urlsplit(_addr(cur)).scheme
                new_scheme = urlsplit(addr).scheme
            except Exception:  # noqa: BLE001
                cur_scheme = ""
                new_scheme = ""

            if _scheme_rank(new_scheme, prefer_schemes) < _scheme_rank(cur_scheme, prefer_schemes):
                best_by_service[sid] = e

        chosen = list(best_by_service.items())

        def _sort_key(item: tuple[tuple[str, str], dict[str, str]]) -> tuple[int, int]:
            sid, e = item
            addr = _addr(e)
            try:
                scheme = urlsplit(addr).scheme
            except Exception:  # noqa: BLE001
                scheme = ""
            return (
                _scheme_rank(scheme, prefer_schemes),
                first_seen_index.get(sid, 1_000_000),
            )

        chosen.sort(key=_sort_key)
        selected = [e for _, e in chosen]

        if max_per_country and max_per_country > 0:
            selected = selected[:max_per_country]

        out[country] = selected

    return out


def to_addresses_only(
    full: "OrderedDict[str, list[dict[str, str]]]",
) -> "OrderedDict[str, list[str]]":
    out: "OrderedDict[str, list[str]]" = OrderedDict()
    for country, entries in full.items():
        out[country] = [e["address"] for e in entries if e.get("address")]
    return out


def format_text_addresses(grouped: "OrderedDict[str, list[str]]") -> str:
    lines: list[str] = []
    for country, addrs in grouped.items():
        lines.append(f"[{country}]")
        for addr in addrs:
            lines.append(f"- {addr}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def format_flat_addresses(grouped: "OrderedDict[str, list[str]]") -> str:
    # Flatten in output order, avoid emitting duplicates by exact string match.
    seen: set[str] = set()
    lines: list[str] = []
    for addrs in grouped.values():
        for addr in addrs:
            if addr in seen:
                continue
            seen.add(addr)
            lines.append(addr)
    return "\n".join(lines).rstrip() + "\n"


def _peer_protocol(address: str) -> str:
    try:
        return (urlsplit(address).scheme or "").lower()
    except Exception:  # noqa: BLE001
        return ""


def _peer_ip_version(address: str) -> str:
    try:
        host = urlsplit(address).hostname
    except Exception:  # noqa: BLE001
        host = None

    if not host:
        return "unknown"

    try:
        return "ipv6" if ip_address(host).version == 6 else "ipv4"
    except ValueError:
        # Not an IP literal (e.g., DNS name)
        return "unknown"


def to_peer_nodes(full: "OrderedDict[str, list[dict[str, str]]]") -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for region, entries in full.items():
        for entry in entries:
            address = (entry.get("address") or "").strip()
            if not address:
                continue
            nodes.append(
                {
                    "address": address,
                    "protocol": _peer_protocol(address),
                    "ipVersion": _peer_ip_version(address),
                    "region": region,
                    "status": entry.get("status") or "",
                    "reliability": entry.get("reliability") or "",
                }
            )
    return nodes


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=(
            "Extract Yggdrasil public peers from the public peers HTML page. "
            "Default behavior writes public_peers.json with all nodes (protocol/ipVersion/region)."
        ),
    )
    src = p.add_mutually_exclusive_group()
    src.add_argument("--url", default=DEFAULT_URL, help=f"Fetch HTML from URL (default: {DEFAULT_URL})")
    src.add_argument("--file", help="Read HTML from a local file")
    src.add_argument("--stdin", action="store_true", help="Read HTML from stdin")

    p.add_argument(
        "--mode",
        choices=["nodes", "addresses", "full"],
        default="nodes",
        help="Output nodes (flat list), grouped addresses, or full grouped rows",
    )
    p.add_argument(
        "--format",
        choices=["text", "json"],
        default="json",
        help="Output format",
    )
    p.add_argument(
        "--out",
        default="yggdrasil/windows10/amd64/public_peers.json",
        help="Output file for JSON (default: public_peers.json).",
    )
    p.add_argument(
        "--stdout",
        action="store_true",
        help="Write JSON to stdout instead of --out.",
    )
    p.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    p.add_argument(
        "--country",
        action="append",
        default=[],
        help="Filter to specific country (can be repeated, matched case-insensitively)",
    )

    p.add_argument(
        "--dedupe",
        action="store_true",
        help="De-duplicate peers by service identity (hostname + optional ?key=).",
    )
    p.add_argument(
        "--max-per-country",
        type=int,
        default=0,
        help=("Limit peers per country after sorting by preferred schemes. " "0 means no limit (default)."),
    )

    args = p.parse_args(argv)

    try:
        data = load_input_from_args(args)
        input_format = detect_input_format(data)

        if input_format == "html":
            full = parse_public_peers_html(data)
        else:
            grouped_addresses = parse_text_grouped_addresses(data)
            # Create a compatible 'full' structure for filtering/output.
            full = OrderedDict(
                (c, [{"address": a, "status": "", "reliability": "", "class": ""} for a in addrs])
                for c, addrs in grouped_addresses.items()
            )

        if args.country:
            wanted = {c.strip().lower() for c in args.country if c.strip()}
            full = OrderedDict((k, v) for k, v in full.items() if k.lower() in wanted)

        if args.dedupe or (args.max_per_country and args.max_per_country > 0):
            full = dedupe_and_limit_full(
                full,
                dedupe=bool(args.dedupe),
                max_per_country=int(args.max_per_country or 0),
                prefer_schemes=list(DEFAULT_PREFER_SCHEMES),
            )

        payload: Any
        if args.mode == "nodes":
            payload = to_peer_nodes(full)
        elif args.mode == "full":
            payload = full
        else:
            payload = to_addresses_only(full)

        if args.format == "json":
            dumped = (
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
                if args.pretty
                else json.dumps(payload, ensure_ascii=False) + "\n"
            )

            if args.stdout:
                sys.stdout.write(dumped)
            else:
                output_file_path = pathlib.Path(args.out)
                if not output_file_path.is_absolute():
                    output_file_path = REPO_ROOT / output_file_path
                output_file_path.parent.mkdir(parents=True, exist_ok=True)
                with open(output_file_path, "w", encoding="utf-8") as f:
                    f.write(dumped)
        else:
            if args.mode == "nodes":
                raise RuntimeError("--mode nodes requires --format json")
            if args.mode == "full":
                # Human-friendly view for full rows
                lines: list[str] = []
                for country, entries in payload.items():
                    lines.append(f"[{country}]")
                    for e in entries:
                        status = e.get("status", "")
                        reliability = e.get("reliability", "")
                        cls = e.get("class", "")
                        meta = " | ".join(x for x in [status, reliability, cls] if x)
                        if meta:
                            lines.append(f"- {e['address']} ({meta})")
                        else:
                            lines.append(f"- {e['address']}")
                    lines.append("")
                sys.stdout.write("\n".join(lines).rstrip() + "\n")
            else:
                grouped = payload
                sys.stdout.write(format_text_addresses(grouped))
                sys.stdout.write("\n")
                sys.stdout.write(format_flat_addresses(grouped))

        return 0
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"Error: {e}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
