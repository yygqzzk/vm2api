// Start the exact release image with isolated data and no Internet or host sockets.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const image = process.env.VM2API_TEST_CONTROL_IMAGE
if (!image) throw new Error('VM2API_TEST_CONTROL_IMAGE required')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-image-'))
const name = `vm2api-image-check-${crypto.randomBytes(5).toString('hex')}`
const envFile = path.join(directory, 'local.env')
fs.writeFileSync(
  envFile,
  [
    'VM2API_ADMIN_USER=acceptance',
    'HOST=127.0.0.1',
    'KIN_AUTO_SYNC_WRAP=0',
    ...['VM2API_API_KEY', 'VM2API_ADMIN_PASSWORD', 'VM2API_DB_SECRET'].map(
      (key) => `${key}=${crypto.randomBytes(24).toString('hex')}`,
    ),
  ].join('\n'),
  { mode: 0o600 },
)
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
const healthScript = `const r=await fetch('http://127.0.0.1:8787/healthz');if(!r.ok)process.exit(1)`
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--env-file', envFile, image])
  let ready = false
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      docker(['exec', name, 'node', '--input-type=module', '-e', healthScript])
      ready = true
      break
    } catch {}
    if (docker(['inspect', '--format', '{{.State.Running}}', name]).trim() !== 'true') break
    await delay(500)
  }
  assert.ok(ready, 'isolated control-plane image must become healthy')
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {writeCodexKernelConfig,ensureCodexKernel,stopCodexKernelAndWait} from './src/lib/transport/codex-kernel-supervisor.mjs';
    const page=await fetch('http://127.0.0.1:8787/cc');assert.equal(page.status,200);assert.match(await page.text(),/<!doctype html>/i);
    const login=await fetch('http://127.0.0.1:8787/api/panel/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:process.env.VM2API_ADMIN_USER,password:process.env.VM2API_ADMIN_PASSWORD})});
    assert.equal(login.status,200);const body=await login.json();const token=body.token||body.data?.token;assert.ok(token);
    const rows=await fetch('http://127.0.0.1:8787/api/panel/vms',{headers:{authorization:'Bearer '+token}});assert.equal(rows.status,200);const data=await rows.json();assert.equal(data.data.items.length,0);
    const root='/tmp/codex-image-smoke';const vm={id:'vm-image-smoke',platform:'openai',proxy:{id:'px-local'}};
    const paths=writeCodexKernelConfig(root,vm);fs.writeFileSync(paths.credentialPath,JSON.stringify({accounts:[]}),{mode:0o600});
    const exec={vmId:vm.id,vm,homeDir:root+'/vms/'+vm.id+'/cli-home'};
    try {const started=await ensureCodexKernel(exec);assert.equal(started.ok,true,JSON.stringify(started));}
    finally {await stopCodexKernelAndWait(exec);}
    console.log('PASS: isolated image health, panel login, empty fleet and bundled Codex kernel startup');
  `
  process.stdout.write(docker(['exec', name, 'node', '--input-type=module', '-e', probe]))
} finally {
  try {
    docker(['rm', '-f', name])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
