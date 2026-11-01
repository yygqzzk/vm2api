"""Offline contracts for the browser's network plan and OAuth callback."""
import importlib.util
import time
import unittest
from pathlib import Path

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
        instance = desktop.Desktop()
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


if __name__ == "__main__":
    unittest.main()
