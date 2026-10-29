#!/usr/bin/env python3
"""Fast pre-commit secret, key, and private-identifier scanner for Talk Tracks.

Talk Tracks is a public repository (CLAUDE.md, ticket 0008): keys, signed tokens, concrete bucket names,
private/public host IPs, env files, and spend ledgers must never be committed. This stdlib-only scanner checks staged
paths and staged additions in a fraction of a second on Linux, macOS, and Windows.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

FORBIDDEN_EXACT_NAMES = frozenset({".env", "ledger.jsonl"})
FORBIDDEN_SUFFIXES = (".jwk", ".pem", ".key")

PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z0-9 -]*PRIVATE KEY(?: BLOCK)?-----")
BRACE_OBJECT_RE = re.compile(r"\{[^{}]*\}", re.DOTALL)
JWK_KTY_RE = re.compile(r'"kty"\s*:\s*"[A-Za-z0-9_-]+"')
JWK_D_RE = re.compile(r'"d"\s*:\s*"[A-Za-z0-9+/=_-]{4,}"')

JWT_RE = re.compile(
    r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])"
)
API_KEY_RE = re.compile(r"\b(META_API_KEY|MODEL_API_KEY)\s*[:=]\s*['\"]?([A-Za-z0-9_-]{12,})(?!\s*\()")

GCS_URI_RE = re.compile(r"gs://([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])(?=$|[/\s\"'`)>,;:])")
ALLOWED_GCS_BUCKETS = frozenset({"bucket", "my-bucket", "example", "example-bucket", "your-bucket", "name"})

IPV4_CANDIDATE_RE = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
ALLOWED_IPV4_EXACT = frozenset({"0.0.0.0", "127.0.0.1", "169.254.169.254"})
ALLOWED_IPV4_PREFIXES = ("172.29.0.", "192.0.2.", "198.51.100.", "203.0.113.")
NON_IP_CONTEXT_RE = re.compile(
    r"(?:(?<![A-Za-z0-9_])[vV]|§|(?:version|ver)\s*[\"']?\s*[:=]\s*[\"']?|==|>=|<=|~=|!="
    r"|(?:section|sec\.?|clause|iso/iec\s+[\d-]+|rfc\s+\d+)\s+)$",
    re.IGNORECASE,
)

HUNK_HEADER_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


@dataclass(frozen=True, slots=True)
class Finding:
    path: str
    line: int | None
    rule: str
    message: str
    snippet: str = ""

    def format(self) -> str:
        loc = f"{self.path}:{self.line}" if self.line is not None else self.path
        detail = f" ({self.snippet})" if self.snippet else ""
        return f"  {loc}: [{self.rule}] {self.message}{detail}"


def check_path(path: str) -> Finding | None:
    """Return a Finding if ``path`` has a forbidden secret/private filename."""
    norm = path.replace("\\", "/")
    name = PurePosixPath(norm).name.lower()
    if (
        name in FORBIDDEN_EXACT_NAMES
        or (name.endswith(".env") and not name.endswith(".env.example"))
        or (name.startswith(".env.") and not name.endswith(".example"))
        or name.endswith(FORBIDDEN_SUFFIXES)
        or name.startswith("id_rsa")
    ):
        return Finding(
            path=norm,
            line=None,
            rule="forbidden-file",
            message="forbidden secret, key, or ledger filename",
            snippet=PurePosixPath(norm).name,
        )
    return None


def _is_valid_ipv4(token: str) -> bool:
    parts = token.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if len(part) > 1 and part.startswith("0"):
            return False
        if int(part) > 255:
            return False
    return True


def _is_allowed_ipv4(ip: str, line_prefix: str) -> bool:
    if ip in ALLOWED_IPV4_EXACT or ip.startswith(ALLOWED_IPV4_PREFIXES):
        return True
    return NON_IP_CONTEXT_RE.search(line_prefix) is not None


def scan_line(path: str, line_no: int, line: str) -> list[Finding]:
    """Scan one text line for private keys, JWTs, API keys, concrete GCS buckets, and concrete IPv4s."""
    findings: list[Finding] = []

    if pk := PRIVATE_KEY_RE.search(line):
        findings.append(
            Finding(path=path, line=line_no, rule="private-key", message="private key header", snippet=pk.group(0))
        )

    if jwt := JWT_RE.search(line):
        findings.append(
            Finding(
                path=path,
                line=line_no,
                rule="jwt",
                message="signed JWT literal",
                snippet=f"{jwt.group(0)[:12]}...<redacted>",
            )
        )

    if key := API_KEY_RE.search(line):
        var_name = key.group(1)
        findings.append(
            Finding(
                path=path,
                line=line_no,
                rule="api-key",
                message=f"assigned {var_name} secret",
                snippet=f"{var_name}=<redacted>",
            )
        )

    for gcs in GCS_URI_RE.finditer(line):
        bucket = gcs.group(1)
        if bucket not in ALLOWED_GCS_BUCKETS:
            findings.append(
                Finding(
                    path=path,
                    line=line_no,
                    rule="gcs-bucket",
                    message="concrete gs:// bucket URI (use gs://$BUCKET or gs://<bucket>)",
                    snippet=f"gs://{bucket}",
                )
            )

    for ip_match in IPV4_CANDIDATE_RE.finditer(line):
        ip = ip_match.group(1)
        if _is_valid_ipv4(ip) and not _is_allowed_ipv4(ip, line[: ip_match.start()]):
            findings.append(
                Finding(
                    path=path,
                    line=line_no,
                    rule="ipv4",
                    message="concrete IPv4 address literal",
                    snippet=ip,
                )
            )

    return findings


def scan_jwk(path: str, text: str, *, added_lines: set[int] | None = None) -> list[Finding]:
    """Scan JSON-like brace blocks for JWK private keys containing both ``"kty"`` and ``"d"``."""
    findings: list[Finding] = []
    for block_match in BRACE_OBJECT_RE.finditer(text):
        block = block_match.group(0)
        if not JWK_KTY_RE.search(block):
            continue
        d_match = JWK_D_RE.search(block)
        if d_match is None:
            continue
        start_line = text.count("\n", 0, block_match.start()) + 1
        end_line = text.count("\n", 0, block_match.end()) + 1
        if added_lines is not None and not any(ln in added_lines for ln in range(start_line, end_line + 1)):
            continue
        d_line = text.count("\n", 0, block_match.start() + d_match.start()) + 1
        findings.append(
            Finding(
                path=path,
                line=d_line,
                rule="jwk-private-key",
                message='JWK private key ("d" parameter alongside "kty")',
                snippet='"d": "<redacted>"',
            )
        )
    return findings


def scan_text(path: str, text: str) -> list[Finding]:
    """Scan the full contents of a text file."""
    norm = path.replace("\\", "/")
    findings: list[Finding] = []
    for idx, line in enumerate(text.splitlines(), start=1):
        findings.extend(scan_line(norm, idx, line))
    findings.extend(scan_jwk(norm, text))
    findings.sort(key=lambda f: (f.path, f.line or 0, f.rule))
    return findings


def parse_unified_diff(diff_text: str) -> dict[str, list[tuple[int, str]]]:
    """Extract ``{path: [(new_line_no, line_text), ...]}`` from ``git diff -U0`` output."""
    added: dict[str, list[tuple[int, str]]] = {}
    current_path: str | None = None
    in_hunk = False
    line_no = 0

    for raw_line in diff_text.splitlines():
        if raw_line.startswith("diff --git "):
            current_path = None
            in_hunk = False
            continue
        if not in_hunk:
            if raw_line.startswith("+++ b/"):
                current_path = raw_line[6:]
                added.setdefault(current_path, [])
                continue
            if raw_line.startswith("+++ /dev/null"):
                current_path = None
                continue
        if raw_line.startswith("@@ "):
            if m := HUNK_HEADER_RE.match(raw_line):
                line_no = int(m.group(1))
                in_hunk = True
            continue
        if in_hunk and current_path is not None:
            if raw_line.startswith("+"):
                added[current_path].append((line_no, raw_line[1:]))
                line_no += 1
            elif not raw_line.startswith(("-", "\\")):
                line_no += 1

    return added


def _git_env(repo: Path | None) -> dict[str, str] | None:
    if repo is None:
        return None
    env = os.environ.copy()
    for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(var, None)
    return env


def _run_git(args: Sequence[str], *, repo: Path | None = None) -> bytes:
    proc = subprocess.run(
        ["git", *args],
        cwd=repo,
        env=_git_env(repo),
        check=True,
        capture_output=True,
    )
    return proc.stdout


def _repo_root(repo: Path | None) -> Path:
    if repo is not None:
        return repo
    out = _run_git(["rev-parse", "--show-toplevel"]).decode("utf-8", errors="replace").strip()
    return Path(out)


def scan_staged(repo: Path | None = None) -> list[Finding]:
    """Scan staged added/copied/modified/renamed paths and staged content additions."""
    names_raw = _run_git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], repo=repo)
    staged_paths = [p.decode("utf-8", errors="replace") for p in names_raw.split(b"\x00") if p]
    if not staged_paths:
        return []

    findings: list[Finding] = []
    for path in staged_paths:
        if path_finding := check_path(path):
            findings.append(path_finding)

    diff_bytes = _run_git(
        [
            "-c",
            "core.quotepath=false",
            "diff",
            "--cached",
            "--no-color",
            "--no-ext-diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "-U0",
            "--diff-filter=ACMR",
        ],
        repo=repo,
    )
    added_by_file = parse_unified_diff(diff_bytes.decode("utf-8", errors="replace"))

    for path, added_lines in added_by_file.items():
        need_jwk_blob_check = False
        for line_no, line in added_lines:
            findings.extend(scan_line(path, line_no, line))
            if '"d"' in line or '"kty"' in line:
                need_jwk_blob_check = True
        if need_jwk_blob_check:
            blob = _run_git(["show", f":{path}"], repo=repo)
            if b"\x00" not in blob:
                line_numbers = {ln for ln, _ in added_lines}
                findings.extend(scan_jwk(path, blob.decode("utf-8", errors="replace"), added_lines=line_numbers))

    findings.sort(key=lambda f: (f.path, f.line or 0, f.rule))
    return findings


def scan_all_tracked(repo: Path | None = None) -> list[Finding]:
    """Scan every git-tracked file in the repository (used for repo-wide verification)."""
    root = _repo_root(repo)
    tracked_raw = _run_git(["ls-files", "-z"], repo=repo)
    tracked_paths = [p.decode("utf-8", errors="replace") for p in tracked_raw.split(b"\x00") if p]

    findings: list[Finding] = []
    for rel_path in tracked_paths:
        if path_finding := check_path(rel_path):
            findings.append(path_finding)
        file_path = root / rel_path
        if not file_path.is_file():
            continue
        raw = file_path.read_bytes()
        if b"\x00" in raw:
            continue
        findings.extend(scan_text(rel_path, raw.decode("utf-8", errors="replace")))

    findings.sort(key=lambda f: (f.path, f.line or 0, f.rule))
    return findings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Scan staged files for secrets and private identifiers.")
    parser.add_argument(
        "--all-tracked",
        action="store_true",
        help="scan all git-tracked files in the repository instead of only staged changes",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=None,
        help="path to the git repository root (defaults to current git worktree)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    findings = scan_all_tracked(args.repo) if args.all_tracked else scan_staged(args.repo)
    if not findings:
        return 0
    scope = "tracked files" if args.all_tracked else "staged changes"
    print(f"pre-commit blocked: {len(findings)} secret/privacy issue(s) in {scope}:", file=sys.stderr)
    for finding in findings:
        print(finding.format(), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
