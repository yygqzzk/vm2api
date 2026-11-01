"""Install fail-closed rules in this container's namespace, then drop all capabilities."""
import ipaddress
import os
import subprocess
from pathlib import Path

PRIVATE_V4 = (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15",
    "224.0.0.0/4", "240.0.0.0/4",
)


def network_rules(dns_host, dns_port):
    ipaddress.IPv4Address(dns_host)
    port = int(dns_port)
    if not 1 <= port <= 65535:
        raise ValueError("invalid DNS port")
    rules = [["-P", "OUTPUT", "DROP"], ["-P", "INPUT", "DROP"], ["-P", "FORWARD", "DROP"]]
    for chain in ("INPUT", "OUTPUT"):
        rules.append(["-A", chain, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"])
        rules.append(["-A", chain, "-o" if chain == "OUTPUT" else "-i", "lo", "-j", "ACCEPT"])
    for protocol in ("tcp", "udp"):
        # Docker's embedded DNS must not resolve via the node's resolver. Insert
        # ahead of Docker's OUTPUT rules, including requests to 127.0.0.11.
        rules.append(["-t", "nat", "-I", "OUTPUT", "1", "-p", protocol, "--dport", "53",
                      "-j", "DNAT", "--to-destination", f"{dns_host}:{port}"])
        # DNAT from 127.0.0.11 also needs its loopback source translated. This
        # exception covers only the configured DNS helper, never general traffic.
        rules.append(["-t", "nat", "-A", "POSTROUTING", "-s", "127.0.0.0/8", "-d", dns_host,
                      "-p", protocol, "--dport", str(port), "-j", "MASQUERADE"])
        rules.append(["-A", "OUTPUT", "-p", protocol, "-d", dns_host,
                      "--dport", str(port), "-j", "ACCEPT"])
    for subnet in PRIVATE_V4:
        rules.append(["-A", "OUTPUT", "-d", subnet, "-j", "REJECT"])
    rules.append(["-A", "OUTPUT", "-p", "tcp", "-j", "ACCEPT"])
    return rules


def main():
    os.umask(0o077)
    for rule in network_rules(os.environ["BROWSER_DNS_HOST"], os.environ["BROWSER_DNS_PORT"]):
        subprocess.run(["iptables", "-w", "5", *rule], check=True)
    # No IPv6 bypass, including hosts whose Docker IPv6 configuration changes.
    for chain in ("INPUT", "OUTPUT", "FORWARD"):
        subprocess.run(["ip6tables", "-w", "5", "-P", chain, "DROP"], check=True)
    for directory in ("/profile", "/run/browser"):
        Path(directory).mkdir(parents=True, exist_ok=True)
        os.chown(directory, 1000, 1000)
    os.chmod("/profile", 0o700)
    os.chmod("/run/browser", 0o700)
    # Replace PID 1 with a fixed privilege-drop program; no shell or caller command.
    os.execv("/usr/bin/setpriv", ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups",  # noqa: S606
                         "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
                         "--no-new-privs", "python3", "/opt/slot-browser/desktop.py"])


if __name__ == "__main__":
    main()
