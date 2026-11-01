"""Apply only the acceptance bridge's rules; run the real kin-egress helper."""
import json
import signal
import subprocess
import sys


def run(args, check=True):
    return subprocess.run(["iptables", "-w", "5", *args], check=check, capture_output=True)


def main():
    with open("/fixture/plan.json", encoding="utf-8") as file:
        plan = json.load(file)
    if sys.argv[1:] == ["cleanup"]:
        for rule in plan["del"]:
            run(rule, check=False)
        return
    rules = plan["add"]
    index = 0
    while index < len(rules):
        if "-C" in rules[index]:
            if run(rules[index], check=False).returncode:
                run(rules[index + 1])
            index += 2
        else:
            run(rules[index])
            index += 1
    child = subprocess.Popen(["/fixture/kin-egress", "-config", "/fixture/egress.json"])
    signal.signal(signal.SIGTERM, lambda *_args: child.terminate())
    signal.signal(signal.SIGINT, lambda *_args: child.terminate())
    # Keep the fail-closed forwarding block even if the helper dies. The harness
    # removes it explicitly only after all acceptance browsers have stopped.
    raise SystemExit(child.wait())


if __name__ == "__main__":
    main()
