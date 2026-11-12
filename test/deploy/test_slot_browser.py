"""Offline contracts for the browser's network plan and OAuth callback."""
import importlib.util
import hashlib
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / "docker/fork/slot-browser"


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("browser module missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


entrypoint = load("entrypoint")
desktop = load("desktop")
installer = load("install_chromix")


class BrowserContracts(unittest.TestCase):
    def test_dns_is_redirected_before_docker_resolver_and_only_dns_udp_is_allowed(self):
        rules = entrypoint.network_rules("172.30.0.1", 20001)
        self.assertEqual(rules[0], ["-P", "OUTPUT", "DROP"])
        for protocol in ("tcp", "udp"):
            self.assertIn(["-t", "nat", "-I", "OUTPUT", "1", "-p", protocol, "--dport", "53",
                           "-j", "DNAT", "--to-destination", "172.30.0.1:20001"], rules)
        udp = [rule for rule in rules if "udp" in rule and "ACCEPT" in rule]
        self.assertEqual(udp, [["-A", "OUTPUT", "-p", "udp", "-d", "172.30.0.1",
                                "--dport", "20001", "-j", "ACCEPT"]])
        tcp_allow = rules.index(["-A", "OUTPUT", "-p", "tcp", "-j", "ACCEPT"])
        for subnet in entrypoint.PRIVATE_V4:
            self.assertLess(rules.index(["-A", "OUTPUT", "-d", subnet, "-j", "REJECT"]), tcp_allow)

    def test_invalid_dns_config_fails_closed(self):
        for host, port in [("::1", 53), ("8.8.8.8; bad", 53), ("8.8.8.8", 0), ("8.8.8.8", 65536)]:
            with self.assertRaises(ValueError):
                entrypoint.network_rules(host, port)

    def grant(self):
        instance = desktop.Desktop("123456")
        instance.grant = {"state": "test-state-0123456789", "session_id": "session-a", "expires": time.monotonic() + 30}
        return instance

    def test_callback_is_loopback_host_exact_path_mandatory_state_and_single_use(self):
        instance = self.grant()
        callback = "/auth/callback?code=example-code&state=test-state-0123456789"
        self.assertFalse(instance.accept_callback("evil.example:1455", callback))
        self.assertFalse(instance.accept_callback("localhost:1455", "/wrong?code=a&state=test-state-0123456789"))
        self.assertFalse(instance.accept_callback("localhost:1455", "/auth/callback?code=a"))
        self.assertFalse(instance.accept_callback("localhost:1455", callback + "&code=other"))
        self.assertFalse(instance.accept_callback("localhost:1455", "/auth/callback?code=a&state=wrong"))
        self.assertFalse(instance.accept_callback("localhost:1455", "/auth/callback?code=a&state=%E4%B8%AD"))
        self.assertTrue(instance.accept_callback("localhost:1455", callback))
        self.assertFalse(instance.accept_callback("localhost:1455", callback))
        self.assertIsNone(instance.command({"op": "callback", "session_id": "other"})["callback_url"])
        self.assertEqual(instance.command({"op": "callback", "session_id": "session-a"})["callback_url"], "http://localhost:1455" + callback)

    def test_expired_callback_is_rejected(self):
        instance = self.grant()
        instance.grant["expires"] = time.monotonic() - 1
        self.assertFalse(instance.accept_callback("localhost:1455", "/auth/callback?code=a&state=test-state-0123456789"))

    def test_identity_is_created_once_without_changing_legacy_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "chromium" / "Default"
            legacy.mkdir(parents=True)
            (legacy / "Cookies").write_bytes(b"synthetic existing login")
            first = desktop.identity_seed(root)
            self.assertEqual(desktop.identity_seed(root), first)
            self.assertEqual((legacy / "Cookies").read_bytes(), b"synthetic existing login")
            with tempfile.TemporaryDirectory() as other:
                self.assertNotEqual(desktop.identity_seed(Path(other)), first)

    def test_login_reset_preserves_identity_and_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            first = desktop.identity_seed(root)
            identity = (root / desktop.IDENTITY_FILE).read_bytes()
            (root / "chromium").mkdir()
            (root / "chromium" / "Cookies").write_bytes(b"synthetic login")
            target = Path(outside) / "untouched"
            target.write_text("outside profile")
            (root / "external").symlink_to(outside, target_is_directory=True)
            desktop.reset_profile(root)
            self.assertEqual([p.name for p in root.iterdir()], [desktop.IDENTITY_FILE])
            self.assertEqual((root / desktop.IDENTITY_FILE).read_bytes(), identity)
            self.assertEqual(desktop.identity_seed(root), first)
            self.assertEqual(target.read_text(), "outside profile")
            (root / desktop.IDENTITY_FILE).unlink()
            self.assertNotEqual(desktop.identity_seed(root), first)

    def test_invalid_identity_is_not_silently_replaced(self):
        for value in ["broken", '{"version":2,"seed":"12"}', '{"version":1,"seed":"0"}',
                      '{"version":1,"seed":12}', '{"version":1,"seed":"9223372036854775808"}']:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                record = root / desktop.IDENTITY_FILE
                record.write_text(value)
                with self.assertRaises(RuntimeError):
                    desktop.identity_seed(root)
                self.assertEqual(record.read_text(), value)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / desktop.IDENTITY_FILE).symlink_to(root / "missing")
            with self.assertRaises(RuntimeError):
                desktop.identity_seed(root)
            self.assertTrue((root / desktop.IDENTITY_FILE).is_symlink())

    def test_native_flags_align_screen_language_timezone_and_keep_sandbox(self):
        with patch.dict(os.environ, {"TZ": "Asia/Tokyo", "BROWSER_LANGUAGE": "ja-JP"}):
            args = desktop.browser_args("123456")
        for flag in ["--fingerprint=123456", "--fingerprint-platform=linux", "--fingerprint-pixel-noise=seeded",
                     "--fingerprint-audio-render=isolated", "--fingerprint-timezone=Asia/Tokyo",
                     "--fingerprint-locale=ja-JP", "--lang=ja-JP", "--fingerprint-screen-width=1280",
                     "--fingerprint-screen-height=800", "--fingerprint-taskbar-height=0"]:
            self.assertIn(flag, args)
        self.assertNotIn("--no-sandbox", args)
        self.assertNotIn("--enable-unsafe-swiftshader", args)

    def test_installer_rejects_wrong_hash_and_unsafe_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "test.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escape", "unsafe")
            with patch.dict(installer.ARCHIVES, {"test": (archive.name, "wrong")}):
                with self.assertRaisesRegex(ValueError, "SHA-256"):
                    installer.install("test", root, root / "out")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            with patch.dict(installer.ARCHIVES, {"test": (archive.name, digest)}):
                with self.assertRaisesRegex(ValueError, "archive entry"):
                    installer.install("test", root, root / "out")
            self.assertFalse((root / "out").exists())


if __name__ == "__main__":
    unittest.main()
