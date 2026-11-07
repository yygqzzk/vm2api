#!/usr/bin/env python3
"""vm2api fork cutover: backup -> hold/drain -> swap control plane -> verify/rollback.

Runs on the production host as root. The image reference must be immutable
(registry digest or a local tag already loaded from the tested CI artifact).
Only the control-plane container is replaced; slot containers, credentials,
fingerprints, routing and the business database are preserved.

  python3 deploy/fork/cutover.py preflight --release <SHA>   # pull + compose check, no changes
  python3 deploy/fork/cutover.py backup    --release <SHA>
  python3 deploy/fork/cutover.py deploy    --release <SHA>
  python3 deploy/fork/cutover.py verify    --release <SHA>

--release resolves <repo>:fork-<SHA> and pulls it when missing; --image/--revision
accept any explicit reference instead.
"""

import argparse
import gzip
import hashlib
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROTECTED_COLUMNS = {
    "users": ["id", "email", "username", "password_hash", "role", "concurrency", "status", "created_at", "deleted_at", "vm_create_quota"],
    "api_keys": ["id", "name", "key", "key_hash", "key_secret", "status", "max_concurrency", "rpm", "expires_at", "user_id", "group_id", "allowed_vms", "vm_pool_id", "ip_whitelist", "ip_blacklist", "deleted_at"],
    "accounts": ["id", "vm_id", "email", "name", "platform", "type", "proxy_id", "created_at", "deleted_at"],
}
# Regenerable from the image/payload: slot CLI binaries and runtime scratch.
# Everything else under vms/ (credentials, fingerprints, settings, machine-id,
# kvm identity) is irreplaceable and always archived.
REGENERABLE_VM_PATHS = (
    "cli-home/.kin/cli-node",
    "cli-home/.kin/cc-node",
    "cli-home/.kin/kin-kernel",
    "cli-home/.kin/kin-kernel.bin",
    "cli-home/.kin/glibc239",
    "cli-home/.kin/crag-v2",
)
HOLD_REASON_PREFIX = "fork-cutover-"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def output(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs)


def inspect_container(name):
    return json.loads(output(["docker", "inspect", name]))[0]


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_hash(file):
    h = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def save(file, value):
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    file.chmod(0o600)


class Cutover:
    def __init__(self, args):
        self.root = Path(args.root)
        self.repo = args.repo
        self.image = args.image
        self.revision = args.revision
        self.keep = args.keep_backups
        self.drain_timeout = args.drain_timeout
        self.control = inspect_container(args.container)
        self.mounts = {m["Destination"]: Path(m["Source"]) for m in self.control["Mounts"] if m["Type"] == "bind"}
        self.vmroot = self.mounts["/opt/vm2api/vms"]
        self.labels = self.control["Config"]["Labels"]
        self.compose_files = self.labels["com.docker.compose.project.config_files"].split(",")
        require(all(Path(f).is_file() for f in self.compose_files), "Compose chain file missing")
        env = dict(item.split("=", 1) for item in self.control["Config"]["Env"] if "=" in item)
        self.api_key = env.get("VM2API_API_KEY") or env.get("KIN_API_KEY") or ""
        require(bool(self.api_key), "Current API credential missing")
        self.port = env.get("PORT", "8787")

    # ---------- live state ----------

    def api(self, route, body=None, timeout=20):
        headers = {"Authorization": "Bearer " + self.api_key}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{route}", headers=headers, data=data)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
        return payload.get("data", payload)

    def ensure_image(self):
        """Pull the exact reference when it is not on the host; return its inspect record."""
        try:
            image = json.loads(output(["docker", "image", "inspect", self.image]))[0]
        except subprocess.CalledProcessError:
            subprocess.run(["docker", "pull", self.image], check=True)
            image = self._inspect_after_pull()
        require(image["Config"]["Labels"].get("org.opencontainers.image.revision") == self.revision,
                "Image revision label does not match --revision")
        require(image["Os"] == "linux" and image["Architecture"] == "amd64", "Image is not linux/amd64")
        return image

    def _inspect_after_pull(self):
        """containerd image store publishes the tag shortly after pull returns."""
        for _ in range(15):
            try:
                return json.loads(output(["docker", "image", "inspect", self.image]))[0]
            except subprocess.CalledProcessError:
                time.sleep(1)
        raise RuntimeError("Pulled image is not visible to the Docker daemon")

    def install(self):
        install_cutover(self.root, self.repo)

    def preflight(self):
        image = self.ensure_image()
        before = self.snapshot()
        folder = Path(tempfile.mkdtemp(prefix="cutover-preflight-"))
        self.write_candidate(folder)
        save(folder / "compose-environment.json", self.validate_compose(folder))
        result = {"ok": True, "image": self.image, "revision": self.revision,
                  "digest": image.get("Descriptor", {}).get("digest"), "platform": "linux/amd64",
                  "compose_merges_cleanly": True, **self.fleet_summary(before)}
        print(json.dumps(result))

    def snapshot(self):
        listing = self.api("/api/panel/vms")
        rows = listing if isinstance(listing, list) else listing["items"]
        slots = {}
        for row in rows:
            vid = row["id"]
            record = json.loads((self.vmroot / (vid + ".json")).read_text())
            detail = self.api("/api/panel/vms/" + urllib.parse.quote(vid, safe=""))
            kernel = detail.get("kernel") or {}
            health = kernel.get("codex_health") or kernel.get("rust_health") or kernel.get("go_health") or {}
            ci = inspect_container("kin-" + vid)
            creds = self.vmroot / vid / "codex-credentials.json"
            identities = []
            if creds.is_file():
                identities = [{f: a.get(f) for f in ("id", "email", "chatgpt_account_id")} for a in json.loads(creds.read_text()).get("accounts", [])]
            protected = ("id", "name", "platform", "family", "created_at", "owner_user_id", "proxy", "timezone", "locale",
                         "fingerprint", "machine", "seed_policy", "policy", "allowed_models", "kernel", "dataplane", "crag_kernel_version")
            slots[vid] = {
                "protected_hash": digest({f: record.get(f) for f in protected}),
                "account_identity_hash": digest(identities),
                "status": row.get("status"), "schedulable": row.get("schedulable"), "schedule_state": row.get("schedule_state"),
                "inflight": row.get("inflight") or 0, "queue_depth": row.get("queue_depth") or 0,
                "healthy": health.get("status") == 200 and health.get("healthy") is True and health.get("process_up") is True,
                "container_id": ci["Id"], "started_at": ci["State"]["StartedAt"], "image_id": ci["Image"],
                "container_mounts_hash": digest(ci["Mounts"]),
            }
        paths = [self.root / ".env", *[Path(f) for f in self.compose_files]]
        paths.extend(f for f in self.mounts["/opt/vm2api/src/config"].rglob("*") if f.is_file())
        paths.extend(f for f in self.protected_vm_files())
        with sqlite3.connect("file:" + str(self.mounts["/opt/vm2api/data"] / "kin.db") + "?mode=ro", uri=True) as db:
            database = db_state(db)
        return {"control": self.control, "slots": slots, "files": {str(f): file_hash(f) for f in paths}, "database": database}

    def protected_vm_files(self):
        yield from protected_vm_files(self.vmroot)

    def fleet_summary(self, state):
        return {"slots": len(state["slots"]),
                "healthy": sum(s["healthy"] for s in state["slots"].values()),
                "inflight": sum(s["inflight"] for s in state["slots"].values()),
                "queue_depth": sum(s["queue_depth"] for s in state["slots"].values())}

    def browser_idle(self):
        require(not output(["docker", "ps", "-q", "--filter", "name=kin-browser-"]).strip(),
                "Browser is active; quiescent profile snapshot required first")

    # ---------- compose ----------

    def compose_prefix(self):
        prefix = ["docker", "compose", "-p", self.labels["com.docker.compose.project"]]
        for f in self.compose_files:
            prefix += ["-f", f]
        return prefix

    def compose_env(self):
        return {**os.environ, "VM2API_FORK_IMAGE": self.control["Config"]["Image"]}

    def candidate_file(self, folder):
        return folder / "compose.candidate.yml"

    def write_candidate(self, folder):
        candidate = self.candidate_file(folder)
        require(not candidate.exists(), "Candidate compose already exists in backup folder")
        candidate.write_text(f"services:\n  vm2api:\n    image: {self.image}\n    pull_policy: never\n")
        candidate.chmod(0o600)
        return candidate

    def validate_compose(self, folder):
        candidate = self.candidate_file(folder)
        prefix = self.compose_prefix()
        env = self.compose_env()
        old = json.loads(output(prefix + ["config", "--format", "json"], cwd=self.root, env=env))
        new = json.loads(output(prefix + ["-f", str(candidate), "config", "--format", "json"], cwd=self.root, env=env))
        require(new["services"]["vm2api"]["image"] == self.image, "Candidate image mismatch")
        for config in (old, new):
            config["services"]["vm2api"].pop("image", None)
            config["services"]["vm2api"].pop("pull_policy", None)
        require(old == new, "Candidate changes more than the image")
        return new["services"]["vm2api"].get("environment", {})

    # ---------- backup ----------

    def backup(self):
        self.browser_idle()
        before = self.snapshot()
        summary = self.fleet_summary(before)
        require(summary["healthy"] == summary["slots"] and summary["slots"] > 0, "Fleet not fully healthy")
        folder = self.root / "backups" / ("cutover-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
        folder.mkdir(mode=0o700)
        save(folder / "before.json", before)
        save(folder / "compose-environment.json", self.validate_compose(folder) if self.candidate_file(folder).exists() else {})
        dbfile = self.mounts["/opt/vm2api/data"] / "kin.db"
        require(shutil.disk_usage(self.root).free > dbfile.stat().st_size + 512 * 1024**2, "Insufficient space for a fresh backup")
        source = sqlite3.connect("file:" + str(dbfile) + "?mode=ro", uri=True)
        target = sqlite3.connect(folder / "kin.db")
        source.backup(target, pages=2048, sleep=0.01)
        source.close()
        require(target.execute("PRAGMA quick_check").fetchone()[0] == "ok", "Fresh SQLite backup failed quick_check")
        save(folder / "database.json", db_state(target))
        target.close()
        raw = folder / "kin.db"
        raw_hash = file_hash(raw)
        with raw.open("rb") as src, gzip.open(folder / "kin.db.gz", "xb", compresslevel=6) as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
        h = hashlib.sha256()
        with gzip.open(folder / "kin.db.gz", "rb") as restored:
            for chunk in iter(lambda: restored.read(1024 * 1024), b""):
                h.update(chunk)
        require(h.hexdigest() == raw_hash, "Backup compression round-trip failed")
        raw.unlink()  # Only the staging copy this run just made.

        def keep(member):
            if not (member.isfile() or member.isdir()):
                return None
            return member

        with tarfile.open(folder / "config.tar.gz", "w:gz", compresslevel=1) as tar:
            for src, name in [(self.root / ".env", ".env"), (self.mounts["/opt/vm2api/src/config"], "config")]:
                tar.add(src, arcname=name, filter=keep)
            for index, f in enumerate(self.compose_files):
                tar.add(f, arcname=f"compose/{index}-{Path(f).name}")
            for vid in before["slots"]:
                tar.add(self.vmroot / (vid + ".json"), arcname=f"vms/{vid}.json")
                for item in self.protected_vm_files():
                    rel = item.relative_to(self.vmroot).as_posix()
                    if rel.split("/")[0] == vid:
                        tar.add(item, arcname="vms/" + rel)
        with tarfile.open(folder / "config.tar.gz", "r:gz") as tar:
            names = set(tar.getnames())
            require(".env" in names and "config/routing.json" in names, "Config archive incomplete")
            require(all(f"vms/{vid}.json" in names for vid in before["slots"]), "Slot records missing from archive")
            require(any(name.endswith("codex-credentials.json") for name in names), "Credentials missing from archive")
        self.browser_idle()
        volumes = browser_volumes()
        if volumes:
            with tarfile.open(folder / "browser-profiles.tar.gz", "w:gz", compresslevel=1) as tar:
                for name, mountpoint in volumes.items():
                    tar.add(mountpoint, arcname=name, filter=keep)
            self.browser_idle()
            require(browser_volumes() == volumes, "Browser volume set changed during backup")
        require(inspect_container("vm2api")["Id"] == before["control"]["Id"], "Control changed during backup")
        save(folder / "manifest.json", {
            "database_quick_check": "ok", "database_sha256": raw_hash,
            "sha256": {n: file_hash(folder / n) for n in sorted(p.name for p in folder.iterdir() if p.suffix == ".gz")},
            "browser_volume_count": len(volumes), "browser_profiles_quiescent": True,
            "slim": True, "excluded": list(REGENERABLE_VM_PATHS),
            "candidate_image": self.image, "revision": self.revision,
        })
        print(json.dumps({"fresh_backup": str(folder), "sqlite_quick_check": "ok", "browser_volumes": len(volumes),
                          "free_bytes": shutil.disk_usage(self.root).free, **summary}))
        return folder

    # ---------- deploy / verify ----------

    def wait_health(self):
        deadline = time.monotonic() + 120
        last_error = None
        while time.monotonic() < deadline:
            try:
                if self.api("/health", timeout=5).get("status") == "ok":
                    return
            except Exception as error:  # container may still be starting; retry until deadline
                last_error = error
            time.sleep(1)
        raise RuntimeError(f"Control health readiness timed out (last: {last_error})")

    def hold_and_drain(self):
        reason = HOLD_REASON_PREFIX + self.revision[:12]
        deadline = time.monotonic() + self.drain_timeout
        while True:
            try:
                return self.api("/api/panel/vms/schedule/hold", body={"reason": reason}, timeout=150)
            except urllib.error.HTTPError as e:
                if e.code != 409 or time.monotonic() > deadline:
                    raise
                time.sleep(10)

    def resume(self):
        return self.api("/api/panel/vms/schedule/resume", body={"reason": HOLD_REASON_PREFIX + self.revision[:12]})

    def warm_kernels(self, folder, before, timeout=1200):
        ids = [vid for vid, slot in before["slots"].items() if slot["status"] == "running"]
        if not ids:
            return
        code = """
import fs from 'node:fs';
import {ensureCodexKernel} from '/opt/vm2api/src/lib/transport/codex-kernel-supervisor.mjs';
import {slotExec} from '/opt/vm2api/src/lib/vm/slot-runtime.mjs';
for (const id of IDS) {
  const vm = JSON.parse(fs.readFileSync('/opt/vm2api/vms/'+id+'.json','utf8'));
  const result = await ensureCodexKernel(slotExec('/opt/vm2api',vm),{timeoutMs:8000});
  if (!result.ok) process.exit(1);
}
""".replace("IDS", json.dumps(ids))
        result = subprocess.run(["docker", "exec", "-i", "vm2api", "node", "--input-type=module"],
                                input=code, capture_output=True, text=True, timeout=timeout)
        (folder / "warm.log").write_text(result.stdout + result.stderr)
        (folder / "warm.log").chmod(0o600)
        require(result.returncode == 0, "Kernel warm-up failed; see restricted warm.log")

    def verify(self, folder, before, target_image, revision):
        after = self.snapshot()
        save(folder / ("after-" + revision[:12] + ".json"), after)
        require(after["control"]["Image"] == target_image, "Wrong running image")
        require(after["control"]["Config"]["Labels"].get("org.opencontainers.image.revision") == revision, "Wrong running revision")

        def mount_signature(control):
            return sorted((m["Type"], m["Source"], m["Destination"], m["RW"]) for m in control["Mounts"])

        require(mount_signature(after["control"]) == mount_signature(before["control"]), "Control mounts changed")
        expected_env = dict(item.split("=", 1) for item in json.loads(output(["docker", "image", "inspect", target_image]))[0]["Config"]["Env"] if "=" in item)
        expected_env.update(json.loads((folder / "compose-environment.json").read_text()))
        actual_env = dict(item.split("=", 1) for item in after["control"]["Config"]["Env"] if "=" in item)
        require(actual_env == expected_env, "Effective container environment differs from Compose and image")
        require(set(after["slots"]) == set(before["slots"]), "Slot set changed")
        for vid, old in before["slots"].items():
            for field in ("protected_hash", "account_identity_hash", "status", "schedulable", "schedule_state",
                          "container_id", "started_at", "image_id", "container_mounts_hash"):
                require(after["slots"][vid][field] == old[field],
                        "Protected slot field changed: " + hashlib.sha256(vid.encode()).hexdigest()[:12] + ":" + field)
        require(self.fleet_summary(after)["healthy"] == len(before["slots"]), "Not all kernels healthy")
        expected_db = json.loads((folder / "database.json").read_text())
        additions = {}
        for table, expected_rows in expected_db["protected"].items():
            live_rows = after["database"]["protected"][table]
            for row_id, row_hash in expected_rows.items():
                require(live_rows.get(row_id) == row_hash, "Protected row removed or modified: " + table + ":" + row_id[:12])
            added = sorted(set(live_rows) - set(expected_rows))
            if added:
                additions[table] = added
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/cc", timeout=15) as response:
            require(response.status == 200 and b"<!doctype html>" in response.read().lower(), "Web console probe failed")
        return {"passed": True, "revision": revision, "image_id": target_image,
                "mounts_and_compose_environment_preserved": True, "protected_configuration_preserved": True,
                "account_identity_and_fingerprints_preserved": True, "slot_containers_unchanged": True,
                "protected_rows_unchanged": True, "business_additions_during_window": additions,
                **self.fleet_summary(after)}

    def rollback_script(self, folder):
        prefix = self.compose_prefix()
        script = folder / "rollback.sh"
        script.write_text("#!/bin/sh\nset -eu\n# Restores the previous program only; the business database is kept.\ncd " + shlex.quote(str(self.root)) + "\n"
                          + shlex.join(prefix + ["up", "-d", "--no-deps", "--pull", "never", "vm2api"]) + "\n")
        script.chmod(0o700)
        return script

    def deploy(self, backup_dir):
        folder = Path(backup_dir)
        before = json.loads((folder / "before.json").read_text())
        if inspect_container("vm2api")["Id"] != before["control"]["Id"]:
            # Stale baseline (e.g. an older cutover set): take a fresh one instead
            # of aborting, so a single deploy command stays sufficient.
            print(json.dumps({"stale_backup": str(folder), "action": "fresh_backup"}))
            folder = self.backup()
            before = json.loads((folder / "before.json").read_text())
        require(json.loads((folder / "manifest.json").read_text())["database_quick_check"] == "ok", "Backup not validated")
        image = self.ensure_image()
        require(image["Config"]["Labels"].get("org.opencontainers.image.revision") == self.revision, "Candidate revision mismatch")
        candidate = self.candidate_file(folder) if self.candidate_file(folder).exists() else self.write_candidate(folder)
        self.validate_compose(folder)
        self.hold_and_drain()
        immediate = self.snapshot()
        summary = self.fleet_summary(immediate)
        require(summary["inflight"] == 0 and summary["queue_depth"] == 0, "New request arrived before replacement")
        save(folder / "immediate-before.json", immediate)
        prefix = self.compose_prefix() + ["-f", str(candidate)]
        old_image = before["control"]["Image"]
        old_revision = before["control"]["Config"]["Labels"].get("org.opencontainers.image.revision")
        started = time.time()
        try:
            with (folder / "compose-up.log").open("x") as log:
                result = subprocess.run(prefix + ["up", "-d", "--no-deps", "--pull", "never", "vm2api"],
                                        cwd=self.root, env=self.compose_env(), stdout=log, stderr=log, timeout=180)
            require(result.returncode == 0, "Compose replacement failed; see restricted log")
            self.wait_health()
            self.warm_kernels(folder, before)
            save(folder / "maintenance-resumed.json", self.resume())
            result = self.verify(folder, before, self.image, self.revision)
            result.update({"deployed": True, "rollback_executed": False, "backup_dir": str(folder),
                           "seconds_to_verified": round(time.time() - started, 2)})
            save(folder / "deployment.json", result)
            print(json.dumps(result))
        except Exception as error:
            with (folder / "rollback.log").open("a") as log:
                reverted = subprocess.run([str(self.rollback_script(folder))], cwd=self.root, stdout=log, stderr=log, timeout=180)
            require(reverted.returncode == 0, "Rollback command failed; see restricted log")
            self.wait_health()
            self.warm_kernels(folder, before)
            save(folder / "maintenance-resumed.json", self.resume())
            result = self.verify(folder, before, old_image, old_revision)
            result.update({"deployed": False, "rollback_executed": True, "backup_dir": str(folder),
                           "failure_type": type(error).__name__, "failure": str(error)})
            save(folder / "rolled-back.json", result)
            print(json.dumps(result))
            raise SystemExit(1) from error

    def prune_backups(self):
        dirs = sorted(self.root.glob("backups/cutover-*"), key=lambda p: p.name)
        for old in dirs[:-self.keep] if len(dirs) > self.keep else []:
            shutil.rmtree(old)
            print(json.dumps({"pruned_backup": str(old)}))


def protected_vm_files(vmroot):
    """Files under vms/ that cannot be regenerated from image + payload."""
    for item in vmroot.rglob("*"):
        if not item.is_file():
            continue
        rel = item.relative_to(vmroot).as_posix()
        parts = rel.split("/")
        if len(parts) < 2 or parts[0].endswith(".json"):
            continue
        inner = "/".join(parts[1:])
        if any(inner == r or inner.startswith(r + "/") for r in REGENERABLE_VM_PATHS):
            continue
        if inner.startswith("run/") and inner.endswith(".sock"):
            continue
        yield item


def install_cutover(root, repo):
    """Copy this script to a stable host path and write a no-flag wrapper."""
    target = root / "deploy" / "fork" / "cutover.py"
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copy2(Path(__file__).resolve(), target)
    target.chmod(0o700)
    wrapper = Path(os.environ.get("VM2API_CUTOVER_BIN", "/usr/local/bin/vm2api-cutover"))
    wrapper.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    wrapper.write_text(
        "#!/bin/sh\n"
        f"exec python3 {shlex.quote(str(target))} "
        '--repo "${VM2API_IMAGE_REPO:-' + repo + '}" "$@"\n'
    )
    wrapper.chmod(0o755)
    print(json.dumps({"installed": str(target), "wrapper": str(wrapper), "default_repo": repo,
                      "next": "vm2api-cutover preflight --release <SHA>"}))


def db_state(db):
    protected = {}
    for table, columns in PROTECTED_COLUMNS.items():
        rows = {}
        for row in db.execute("SELECT " + ",".join(columns) + " FROM " + table + " ORDER BY id"):
            rows[hashlib.sha256(str(row[0]).encode()).hexdigest()] = digest([list(row)])
        protected[table] = rows
    return {
        "counts": {t: db.execute("SELECT COUNT(*) FROM " + t).fetchone()[0] for t in ("users", "api_keys", "accounts", "vms", "usage_logs")},
        "protected": protected,
        "migrations": db.execute("SELECT version,name,checksum FROM schema_migrations ORDER BY version").fetchall(),
    }


def browser_volumes():
    names = output(["docker", "volume", "ls", "--filter", "name=kin-browser-profile-", "--format", "{{.Name}}"]).splitlines()
    volumes = json.loads(output(["docker", "volume", "inspect", *names])) if names else []
    return {v["Name"]: v["Mountpoint"] for v in volumes}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=["backup", "deploy", "verify", "preflight", "install"])
    parser.add_argument("--release", help="Commit SHA; resolves ghcr.io/yygqzzk/vm2api:fork-<SHA>")
    parser.add_argument("--repo", default=os.environ.get("VM2API_IMAGE_REPO", "ghcr.io/yygqzzk/vm2api"))
    parser.add_argument("--image", help="Image reference (default with --release: <repo>:fork-<SHA>)")
    parser.add_argument("--revision", help="Expected OCI revision label (default with --release: release SHA)")
    parser.add_argument("--root", default="/opt/vm2api")
    parser.add_argument("--container", default="vm2api")
    parser.add_argument("--backup-dir", default=None, help="deploy/verify: existing backup folder (default: newest cutover-*)")
    parser.add_argument("--keep-backups", type=int, default=3, help="Cutover backup sets to keep after a successful deploy")
    parser.add_argument("--drain-timeout", type=int, default=900, help="Seconds to hold scheduling while in-flight requests drain")
    args = parser.parse_args()
    require(args.action == "install" or bool(args.release or (args.image and args.revision)), "Pass --release SHA, or both --image and --revision")
    if args.action == "install":
        os.umask(0o077)
        install_cutover(Path(args.root), args.repo)
        return
    if args.release:
        args.revision = args.revision or args.release
        args.image = args.image or f"{args.repo}:fork-{args.release}"
    os.umask(0o077)
    cutover = Cutover(args)
    if args.action == "preflight":
        cutover.preflight()
        return
    if args.action == "backup":
        cutover.backup()
        return
    backup_dir = args.backup_dir
    if not backup_dir:
        dirs = sorted(Path(args.root).glob("backups/cutover-*"), key=lambda p: p.name)
        require(dirs, "No cutover backup found; run backup first")
        backup_dir = str(dirs[-1])
    if args.action == "deploy":
        cutover.deploy(backup_dir)
        cutover.prune_backups()
    else:
        folder = Path(backup_dir)
        before = json.loads((folder / "before.json").read_text())
        result = cutover.verify(folder, before, args.image, args.revision)
        save(folder / "verified.json", result)
        print(json.dumps(result))


if __name__ == "__main__":
    main()
