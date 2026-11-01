# Vendored Docker seccomp profile

`docker-seccomp.json` is an unmodified copy of `seccomp/default.json` from
https://github.com/moby/profiles/tree/4b8214fc4971e06172938a1f1554ccff6647ee80
under the Apache License 2.0 (see `LICENSE.moby`).

`../seccomp.mjs` derives the browser policy by adding `clone`, `setns`, `unshare`
and `chroot` for Chromium's unprivileged namespace sandbox. It does not grant
`SYS_ADMIN`, disable Chromium's sandbox, or set seccomp to `unconfined`.

Keep this file byte-identical to its pinned upstream source; validate the derived
policy on both amd64 and arm64 before changing the pin.
