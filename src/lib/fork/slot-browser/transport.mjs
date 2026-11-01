import { Transform } from 'node:stream'
import { openExecStream } from '../../cluster/docker-remote.mjs'
import { BrowserError } from './spec.mjs'

/** Docker frames may split at any byte, including the header. */
export class DockerStdout extends Transform {
  pending = Buffer.alloc(0)
  _transform(chunk, _encoding, done) {
    try {
      this.pending = Buffer.concat([this.pending, chunk])
      while (this.pending.length >= 8) {
        const size = this.pending.readUInt32BE(4)
        if (size > 1 << 20 || ![1, 2].includes(this.pending[0]) || this.pending.subarray(1, 4).some(Boolean)) {
          throw new Error('invalid Docker stream frame')
        }
        if (this.pending.length < size + 8) break
        if (this.pending[0] === 2 && size) throw new Error('browser transport failed')
        this.push(this.pending.subarray(8, size + 8))
        this.pending = this.pending.subarray(size + 8)
      }
      done()
    } catch (error) {
      done(error)
    }
  }
  _flush(done) {
    done(this.pending.length ? new Error('truncated Docker stream frame') : null)
  }
}

export async function browserTransport(connect, container, mode) {
  const { stream } = await openExecStream(connect, container, {
    cmd: ['python3', '/opt/slot-browser/client.py', mode],
    user: '1000:1000',
  })
  const output = new DockerStdout()
  stream.on('error', (error) => output.destroy(error))
  output.on('error', () => stream.destroy())
  output.on('close', () => stream.destroy())
  stream.pipe(output)
  return {
    input: stream,
    output,
    close: () => {
      output.destroy()
      stream.destroy()
    },
  }
}

export async function browserRpc(connect, container, message) {
  const transport = await browserTransport(connect, container, 'rpc')
  return new Promise((resolve, reject) => {
    let result = Buffer.alloc(0)
    const finish = (error, value) => {
      clearTimeout(timer)
      transport.close()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new BrowserError('browser_timeout', '浏览器控制通道超时', 504)), 15_000)
    transport.output.on('error', () => finish(new BrowserError('browser_transport', '浏览器控制通道不可用', 502)))
    transport.output.on('data', (chunk) => {
      result = Buffer.concat([result, chunk])
      if (result.length > 32768) finish(new BrowserError('browser_transport', '浏览器响应过大', 502))
    })
    transport.output.on('end', () => {
      let value
      try {
        value = JSON.parse(result.toString('utf8'))
      } catch {
        return finish(new BrowserError('browser_transport', '浏览器未返回有效状态', 502))
      }
      if (!value.ok) return finish(new BrowserError('browser_command', '浏览器操作失败', 502))
      finish(null, value)
    })
    transport.input.write(`${JSON.stringify(message)}\n`)
  })
}
