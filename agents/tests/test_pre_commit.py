from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Protocol, cast

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "pre_commit_check.py"
HOOK_PATH = REPO_ROOT / ".githooks" / "pre-commit"


class FindingProto(Protocol):
    @property
    def path(self) -> str: ...
    @property
    def line(self) -> int | None: ...
    @property
    def rule(self) -> str: ...
    @property
    def message(self) -> str: ...
    @property
    def snippet(self) -> str: ...
    def format(self) -> str: ...


class ScannerModule(Protocol):
    def check_path(self, path: str) -> FindingProto | None: ...
    def scan_text(self, path: str, text: str) -> list[FindingProto]: ...
    def scan_staged(self, repo: Path | None = None) -> list[FindingProto]: ...
    def scan_all_tracked(self, repo: Path | None = None) -> list[FindingProto]: ...
    def main(self, argv: Sequence[str] | None = None) -> int: ...


def _load_scanner() -> ScannerModule:
    spec = importlib.util.spec_from_file_location("pre_commit_check", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return cast(ScannerModule, cast(object, module))


scanner = _load_scanner()


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(var, None)
    env.setdefault("GIT_AUTHOR_NAME", "Test")
    env.setdefault("GIT_AUTHOR_EMAIL", "test@example.invalid")
    env.setdefault("GIT_COMMITTER_NAME", "Test")
    env.setdefault("GIT_COMMITTER_EMAIL", "test@example.invalid")
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        env=env,
        check=check,
        text=True,
        capture_output=True,
    )


def _init_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    return repo


@pytest.mark.parametrize(
    "bad_path",
    [
        ".env",
        "deploy/.env",
        "meta.env",
        "secrets/prod.env",
        ".env.local",
        "private.jwk",
        "agents/data/keys/public.jwk",
        "tls/cert.pem",
        "tls/server.key",
        "id_rsa",
        "keys/id_rsa.pub",
        "keys/id_rsa_deploy",
        "ledger.jsonl",
        "data/ledger.jsonl",
    ],
)
def test_check_path_blocks_forbidden_filenames(bad_path: str) -> None:
    finding = scanner.check_path(bad_path)
    assert finding is not None
    assert finding.rule == "forbidden-file"


@pytest.mark.parametrize(
    "good_path",
    [
        ".env.example",
        "deploy/meta.env.example",
        "agents/src/talk_tracks/llm/ledger.py",
        "bench/results/check.jsonl",
        "README.md",
        "web/src/App.tsx",
    ],
)
def test_check_path_allows_safe_filenames(good_path: str) -> None:
    assert scanner.check_path(good_path) is None


def test_private_key_headers_and_jwk_detection() -> None:
    pem_priv = "-----BEGIN " + "EC PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEG\n"
    assert [f.rule for f in scanner.scan_text("doc.md", pem_priv)] == ["private-key"]

    openssh_priv = "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n"
    assert [f.rule for f in scanner.scan_text("doc.md", openssh_priv)] == ["private-key"]

    pem_pub = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n"
    assert scanner.scan_text("doc.md", pem_pub) == []

    jwk_priv_multiline = (
        "{\n"
        '  "kty": "EC",\n'
        '  "crv": "P-256",\n'
        '  "x": "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",\n'
        '  "d": "' + "870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE" + '"\n'
        "}\n"
    )
    jwk_findings = scanner.scan_text("note.json", jwk_priv_multiline)
    assert len(jwk_findings) == 1
    assert jwk_findings[0].rule == "jwk-private-key"
    assert jwk_findings[0].line == 5

    jwk_pub = '{"kty": "EC", "crv": "P-256", "x": "abc12345", "y": "def67890"}\n'
    assert scanner.scan_text("note.json", jwk_pub) == []

    unrelated_json = '{"id": 42, "d": "some_unrelated_value_1234"}\n'
    assert scanner.scan_text("slice.json", unrelated_json) == []


def test_signed_jwt_and_api_key_detection() -> None:
    fake_jwt = "eyJhbGciOiJFUzI1NiJ9." + "eyJzdWIiOiJ0ZXN0c2NvcGUifQ." + "c2lnbmF0dXJlX2Jhc2U2NHVybA"
    findings = scanner.scan_text("url.txt", f"https://localhost/talk/dev?jwt={fake_jwt}\n")
    assert [f.rule for f in findings] == ["jwt"]
    assert fake_jwt not in findings[0].format()

    assert scanner.scan_text("tokens.md", "https://<host>/talk/R?token=<token>\n") == []

    key_val = "sk_meta_" + "1234567890abcdef"
    for line in (f"META_API_KEY={key_val}\n", f'MODEL_API_KEY = "{key_val}"\n', f"META_API_KEY: {key_val}\n"):
        key_findings = scanner.scan_text("cfg.txt", line)
        assert [f.rule for f in key_findings] == ["api-key"]
        assert key_val not in key_findings[0].format()

    safe_key_refs = (
        "META_API_KEY=...\n"
        "docker compose run -e META_API_KEY captions\n"
        'key = os.environ.get("META_API_KEY") or os.environ.get("MODEL_API_KEY")\n'
        "META_API_KEY=${META_API_KEY}\n"
    )
    assert scanner.scan_text("docs.md", safe_key_refs) == []


def test_gcs_bucket_detection_and_placeholders() -> None:
    concrete = "gcloud storage ls gs://" + "talk-tracks-prod-archive/live\n"
    findings = scanner.scan_text("deploy.md", concrete)
    assert [f.rule for f in findings] == ["gcs-bucket"]

    placeholders = (
        "gcloud storage rsync gs://$BUCKET/archive ~/tt-data/archive\n"
        "gcloud storage rsync gs://${BUCKET}/demo ~/tt-data/demo\n"
        "TT_ARCHIVE_BUCKET=gs://<bucket>[/<folder>]\n"
        "copying to gs://{bucket.name}/{bucket.folder}\n"
        "``gs://name[/folder]``\n"
        'GcsBucket("gs://my-bucket")\n'
    )
    assert scanner.scan_text("archive.md", placeholders) == []


def test_ipv4_detection_and_allowlists() -> None:
    blocked_ips = [
        "34.120." + "55.9",
        "http://35.198." + "10.42:4443",
        "ssh ubuntu@203.0." + "114.8",
        "10.128." + "0.5",
        "192.168." + "1.20",
        "172.17." + "0.2",
        "172.29." + "1.10",
    ]
    for sample in blocked_ips:
        findings = scanner.scan_text("host.txt", sample + "\n")
        assert [f.rule for f in findings] == ["ipv4"], f"expected block for {sample}"

    allowed_samples = (
        "http://127.0.0.1:8080\n"
        "listen 0.0.0.0:4443\n"
        "METADATA = 'http://169.254.169.254'\n"
        "subnet: 172.29.0.0/24\n"
        "ipv4_address: 172.29.0.50\n"
        "example_a: 192.0.2.1\n"
        "example_b: 198.51.100.12\n"
        "example_c: 203.0.113.99\n"
        "image: talk-tracks-relay:0.17.8\n"
        "tag: v1.2.3.4\n"
        '"version": "1.2.3.4"\n'
        "dep==2.4.6.8\n"
        "End of Group (D18 §11.2.1.1)\n"
        "AVCDecoderConfigurationRecord (ISO/IEC 14496-15 5.3.3.1)\n"
        "oid: 1.2.3.4.5\n"
        "not_ip: 999.1.2.3\n"
    )
    assert scanner.scan_text("safe.md", allowed_samples) == []


def test_scan_staged_inspects_only_staged_changes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    repo = _init_repo(tmp_path)

    # Initial clean commit with a public JWK.
    jwk_file = repo / "public_config.json"
    jwk_file.write_text('{\n  "kty": "EC",\n  "crv": "P-256"\n}\n', encoding="utf-8")
    _git(repo, "add", "public_config.json")
    _git(repo, "commit", "-q", "-m", "init")

    # Unstaged secret in working tree must NOT block a clean staged file.
    (repo / "unstaged.txt").write_text("META_API_KEY=" + "secret_unstaged_123456\n", encoding="utf-8")
    (repo / "clean.md").write_text("# Clean note\nLocalhost is 127.0.0.1.\n", encoding="utf-8")
    _git(repo, "add", "clean.md")
    assert scanner.main(["--repo", str(repo)]) == 0

    # Staging a forbidden filename blocks commit; .env.example is allowed.
    (repo / ".env.example").write_text("TT_ROOM=dev\n", encoding="utf-8")
    (repo / ".env").write_text("TT_ROOM=dev\n", encoding="utf-8")
    _git(repo, "add", ".env.example", ".env")
    assert scanner.main(["--repo", str(repo)]) == 1
    err = capsys.readouterr().err
    assert ".env" in err and ".env.example" not in err
    _git(repo, "reset", "-q", "HEAD", ".env")

    # Modifying an existing public JWK to add a private "d" parameter is caught via staged blob inspection.
    jwk_file.write_text(
        '{\n  "kty": "EC",\n  "crv": "P-256",\n  "d": "' + "private_scalar_abcdef1234" + '"\n}\n',
        encoding="utf-8",
    )
    _git(repo, "add", "public_config.json")
    staged_findings = scanner.scan_staged(repo)
    assert [f.rule for f in staged_findings] == ["jwk-private-key"]
    assert staged_findings[0].line == 4


def test_pre_commit_hook_blocks_secrets_and_allows_clean_commits(tmp_path: Path) -> None:
    hook_bytes = HOOK_PATH.read_bytes().replace(b"\r\n", b"\n")
    assert hook_bytes.startswith(b"#!/bin/sh\n")

    repo = _init_repo(tmp_path)
    (repo / ".githooks").mkdir()
    (repo / "scripts").mkdir()
    (repo / ".githooks" / "pre-commit").write_bytes(hook_bytes)
    shutil.copyfile(SCRIPT_PATH, repo / "scripts" / "pre_commit_check.py")
    os.chmod(repo / ".githooks" / "pre-commit", 0o755)
    _git(repo, "config", "core.hooksPath", ".githooks")

    # Clean commit (including a web/ file when web/node_modules is absent) passes through .githooks/pre-commit.
    (repo / "README.md").write_text("# Demo\nBucket placeholder: gs://$BUCKET/archive\n", encoding="utf-8")
    (repo / "web" / "src").mkdir(parents=True)
    (repo / "web" / "src" / "App.tsx").write_text("export const App = () => null;\n", encoding="utf-8")
    _git(repo, "add", "README.md", "web/src/App.tsx")
    ok = _git(repo, "commit", "-m", "clean readme and web file", check=False)
    assert ok.returncode == 0, ok.stderr

    # Secret IPv4 addition is blocked by .githooks/pre-commit.
    (repo / "README.md").write_text("# Demo\nVM IP: " + "34.120." + "88.19\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    blocked = _git(repo, "commit", "-m", "accidental vm ip", check=False)
    assert blocked.returncode != 0
    assert "ipv4" in blocked.stderr
    _git(repo, "reset", "--hard", "HEAD")

    # When web/node_modules/.bin exists, eslint & prettier run inside web/ with stripped relative paths.
    bin_dir = repo / "web" / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    eslint_shim = bin_dir / "eslint"
    prettier_shim = bin_dir / "prettier"
    eslint_shim.write_bytes(b'#!/bin/sh\nprintf "%s\\n" "$*" > eslint.args\n')
    prettier_shim.write_bytes(b'#!/bin/sh\nprintf "%s\\n" "$*" > prettier.args\n')
    os.chmod(eslint_shim, 0o755)
    os.chmod(prettier_shim, 0o755)

    (repo / "web" / "src" / "App.tsx").write_text("export const App = () => <div />;\n", encoding="utf-8")
    (repo / "web" / "src" / "app.css").write_text("body { margin: 0; }\n", encoding="utf-8")
    _git(repo, "add", "web/src/App.tsx", "web/src/app.css")
    web_ok = _git(repo, "commit", "-m", "web changes", check=False)
    assert web_ok.returncode == 0, web_ok.stderr
    assert (repo / "web" / "eslint.args").read_text(encoding="utf-8").strip() == "src/App.tsx"
    assert (repo / "web" / "prettier.args").read_text(encoding="utf-8").strip() == "--check src/App.tsx src/app.css"


def test_all_tracked_files_in_repo_have_zero_false_positives() -> None:
    findings = scanner.scan_all_tracked(REPO_ROOT)
    assert findings == [], "unexpected findings in tracked files:\n" + "\n".join(f.format() for f in findings)
