import dockerProfile from './vendor/docker-seccomp.json' with { type: 'json' }

// Moby's default deny-by-default profile, plus the user/PID/network namespace
// operations and chroot required by Chromium's unprivileged sandbox. The kernel
// still checks capabilities in the target namespace; no SYS_ADMIN is granted.
export const browserSeccomp = JSON.stringify({
  ...dockerProfile,
  syscalls: [
    ...dockerProfile.syscalls,
    {
      names: ['clone', 'setns', 'unshare', 'chroot'],
      action: 'SCMP_ACT_ALLOW',
      comment: 'Allow Chromium unprivileged namespace sandbox; not a privileged container',
    },
  ],
})
