import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy" / "fork"))
import cutover  # noqa: E402


class ProtectedVmFiles(unittest.TestCase):
    def test_keeps_identity_and_drops_regenerable_binaries_and_sockets(self):
        with tempfile.TemporaryDirectory() as tmp:
            vmroot = Path(tmp)
            keep = [
                "vm-a/codex-credentials.json",
                "vm-a/machine-id",
                "vm-a/kvm/fingerprint/pc_identity.json",
                "vm-a/cli-home/.claude/settings.json",
                "vm-a/cli-home/.claude/kin-seed.json",
                "vm-a/cli-home/.claude/claude.setting",
                "vm-a/run/codex-installation-id",
                "vm-a/run/kernel.json",
            ]
            drop = [
                "vm-a/cli-home/.kin/cli-node",
                "vm-a/cli-home/.kin/cc-node",
                "vm-a/cli-home/.kin/kin-kernel",
                "vm-a/cli-home/.kin/kin-kernel.bin",
                "vm-a/cli-home/.kin/glibc239/ld-linux.so",
                "vm-a/cli-home/.kin/crag-v2/crag-v2",
                "vm-a/run/worker.sock",
                "vm-a/run/codex-kernel.sock",
            ]
            for rel in keep + drop:
                target = vmroot / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("x")
            selected = {p.relative_to(vmroot).as_posix() for p in cutover.protected_vm_files(vmroot)}
            self.assertEqual(selected, set(keep), f"unexpected selection: {sorted(selected)}")


class CutoverVerification(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.before = {
            "control": {"Id": "old-control", "Name": "/vm2api", "Image": "sha256:old",
                        "Mounts": [], "Config": {"Labels": {"org.opencontainers.image.revision": "old-revision"},
                                                 "Env": ["BASE=1", "EXTRA=production"]}},
            "slots": {}, "files": {}, "database": {"protected": {}},
        }
        self.live = {
            **self.before["control"], "Id": "new-control", "Image": "sha256:new",
            "Config": {"Labels": {"org.opencontainers.image.revision": "new-revision"},
                       "Env": ["BASE=1", "EXTRA=production"]},
        }
        self.image = {"Id": "sha256:new", "Config": {"Env": ["BASE=1"]}}
        self.cutover = cutover.Cutover.__new__(cutover.Cutover)
        self.cutover.root = self.root
        self.cutover.control = self.before["control"]
        self.cutover.port = "8787"
        self.cutover.image = "registry.example/vm2api@sha256:manifest"
        self.cutover.browser_image = None
        self.cutover.revision = "new-revision"
        cutover.save(self.root / "before.json", self.before)
        cutover.save(self.root / "database.json", self.before["database"])
        cutover.save(self.root / "manifest.json", {"database_quick_check": "ok"})
        cutover.save(self.root / "compose-environment.json", {"EXTRA": "production"})

    def test_browser_upgrade_changes_only_the_explicit_browser_reference(self):
        c = self.cutover
        c.browser_image = "registry.example/browser@sha256:new"
        c.compose_prefix = Mock(return_value=["docker", "compose"])
        c.compose_env = Mock(return_value={})
        old = {"services": {"vm2api": {"image": "old", "environment": {"EXTRA": "production", "VM2API_BROWSER_IMAGE": "old-browser"}}}}
        new = {"services": {"vm2api": {"image": c.image, "pull_policy": "never", "environment": {"EXTRA": "production", "VM2API_BROWSER_IMAGE": c.browser_image}}}}
        c.write_candidate(self.root)
        self.assertIn(c.browser_image, c.candidate_file(self.root).read_text())
        with patch.object(cutover, "output", side_effect=[json.dumps(old), json.dumps(new)]):
            self.assertEqual(c.validate_compose(self.root), new["services"]["vm2api"]["environment"])
        new["services"]["vm2api"]["environment"]["EXTRA"] = "modified"
        with patch.object(cutover, "output", side_effect=[json.dumps(old), json.dumps(new)]), \
             self.assertRaisesRegex(RuntimeError, "changes more than the image"):
            c.validate_compose(self.root)

    def test_browser_upgrade_requires_matching_revision_architecture_and_fingerprint(self):
        c = self.cutover
        c.browser_image = "registry.example/browser@sha256:new"
        control = {"Os": "linux", "Architecture": "amd64", "Config": {"Labels": {"org.opencontainers.image.revision": c.revision}}}
        browser = {"Os": "linux", "Architecture": "amd64", "Config": {"Labels": {"org.opencontainers.image.revision": c.revision, "io.vm2api.browser.fingerprint": "chromix-1"}}}
        with patch.object(cutover, "output", side_effect=[json.dumps([control]), json.dumps([browser])]):
            self.assertEqual(c.ensure_image(), control)
        for bad in [
            {**browser, "Architecture": "arm64"},
            {**browser, "Config": {"Labels": {"org.opencontainers.image.revision": "old"}}},
            {**browser, "Config": {"Labels": {"org.opencontainers.image.revision": c.revision}}},
        ]:
            with patch.object(cutover, "output", side_effect=[json.dumps([control]), json.dumps([bad])]), self.assertRaises(RuntimeError):
                c.ensure_image()

    def test_snapshot_refreshes_control_without_replacing_the_rollback_baseline(self):
        self.cutover.api = Mock(return_value=[])
        self.cutover.compose_files = []
        self.cutover.vmroot = self.root / "vms"
        self.cutover.mounts = {"/opt/vm2api/src/config": self.root / "config", "/opt/vm2api/data": self.root}
        (self.root / ".env").write_text("EXTRA=production\n")
        (self.root / "kin.db").touch()
        rolled_back = {**self.before["control"], "Id": "rollback-control"}
        with patch.object(cutover, "inspect_container", side_effect=[self.live, rolled_back]) as inspect, \
             patch.object(cutover, "db_state", return_value=self.before["database"]):
            self.assertEqual(self.cutover.snapshot()["control"], self.live)
            self.assertEqual(self.cutover.snapshot()["control"], rolled_back)
        self.assertEqual(inspect.call_args_list, [unittest.mock.call("vm2api"), unittest.mock.call("vm2api")])
        self.assertIs(self.cutover.control, self.before["control"])

    def verify(self, live, reference="registry.example/vm2api@sha256:manifest"):
        self.cutover.snapshot = Mock(return_value={**self.before, "control": live})
        with patch.object(cutover, "output", return_value=json.dumps([self.image])), \
             patch.object(cutover.urllib.request, "urlopen") as urlopen:
            response = urlopen.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b"<!doctype html><html></html>"
            return self.cutover.verify(self.root, self.before, reference, "new-revision")

    def test_verify_resolves_digest_tag_and_id_to_the_expected_image(self):
        for reference in ("registry.example/vm2api@sha256:manifest", "local/vm2api:fork-revision", "sha256:new"):
            with self.subTest(reference=reference):
                result = self.verify(self.live, reference)
                self.assertTrue(result["passed"])
                self.assertEqual(result["image_id"], "sha256:new")

    def test_verify_still_rejects_wrong_images_revisions_mounts_and_environment(self):
        cases = [
            ({**self.live, "Image": "sha256:other"}, "Wrong running image"),
            ({**self.live, "Config": {**self.live["Config"], "Labels": {"org.opencontainers.image.revision": "wrong"}}}, "Wrong running revision"),
            ({**self.live, "Mounts": [{"Type": "bind", "Source": "/other", "Destination": "/data", "RW": True}]}, "Control mounts changed"),
            ({**self.live, "Config": {**self.live["Config"], "Env": ["BASE=1"]}}, "Effective container environment"),
        ]
        for live, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(RuntimeError, error):
                self.verify(live)

    def test_deploy_persists_compose_environment_before_replacement(self):
        c = self.cutover
        c.ensure_image = Mock(return_value={**self.image, "Config": {**self.image["Config"], "Labels": {"org.opencontainers.image.revision": c.revision}}})
        c.validate_compose = Mock(return_value={"EXTRA": "production"})
        c.compose_prefix = Mock(return_value=["docker", "compose"])
        c.compose_env = Mock(return_value={})
        c.hold_and_drain = Mock()
        c.wait_idle = Mock(return_value=True)
        c.snapshot = Mock(return_value=self.before)
        c.wait_health = Mock()
        c.warm_kernels = Mock()
        c.resume = Mock(return_value={"ok": True})
        c.verify = Mock(return_value={"passed": True})
        cutover.save(self.root / "compose-environment.json", {})
        with patch.object(cutover, "inspect_container", return_value=self.before["control"]), \
             patch.object(cutover.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            def replace(*args, **kwargs):
                self.assertEqual(json.loads((self.root / "compose-environment.json").read_text()), {"EXTRA": "production"})
                return SimpleNamespace(returncode=0)
            run.side_effect = replace
            c.deploy(self.root)
        self.assertTrue(json.loads((self.root / "deployment.json").read_text())["deployed"])
        c.verify.assert_called_once_with(self.root, self.before, c.image, c.revision)

    def test_warm_kernels_uses_controller_only_for_previously_running_slots(self):
        self.cutover.api = Mock(side_effect=[{"actions": ["warm"]},
                                            {"action": "warm", "ok_count": 1, "failed_count": 0},
                                            {"action": "warm", "ok_count": 1, "failed_count": 0}])
        before = {"slots": {"vm-a": {"status": "running"}, "vm-stopped": {"status": "stopped"},
                            "vm-b": {"status": "running"}}}
        with patch.object(cutover.subprocess, "run") as run:
            self.cutover.warm_kernels(self.root, before)
        run.assert_not_called()
        self.assertEqual([call.args[0] for call in self.cutover.api.call_args_list],
                         ["/api/panel/vms/fleet-status", "/api/panel/vms/fleet-update", "/api/panel/vms/fleet-update"])
        self.assertEqual([call.kwargs["body"] for call in self.cutover.api.call_args_list[1:]],
                         [{"action": "warm", "ids": [vid], "concurrency": 1} for vid in ("vm-a", "vm-b")])
        self.assertEqual(json.loads((self.root / "warm.json").read_text()), {"started": ["vm-a", "vm-b"]})

    def test_warm_kernel_api_failure_aborts_without_claiming_the_slot_warmed(self):
        self.cutover.api = Mock(side_effect=[{"actions": ["warm"]},
                                            {"action": "warm", "ok_count": 0, "failed_count": 1}])
        with self.assertRaisesRegex(RuntimeError, "Controller kernel warm-up failed"):
            self.cutover.warm_kernels(self.root, {"slots": {"vm-a": {"status": "running"}}})
        self.assertFalse((self.root / "warm.json").exists())

    def test_warm_kernel_rollback_supports_images_without_the_warm_action(self):
        self.cutover.api = Mock(return_value={"items": []})
        with patch.object(cutover.subprocess, "run",
                          return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            self.cutover.warm_kernels(self.root, {"slots": {"vm-a": {"status": "running"}}})
        self.assertEqual(run.call_args.args[0][:5], ["docker", "exec", "-i", "vm2api", "node"])
        self.assertIn('"vm-a"', run.call_args.kwargs["input"])
        self.assertEqual(len(self.cutover.api.call_args_list), 1)


if __name__ == "__main__":
    unittest.main()
