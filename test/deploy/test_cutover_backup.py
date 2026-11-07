import sys
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
