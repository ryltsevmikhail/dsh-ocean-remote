import { mkdtemp, realpath, stat, writeFile, rm, symlink, mkdir, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexWorkspaceBridge, CodexWorkspaceState, subprocessTerminalSpawner, type RemoteTerminalProcess, type RemoteTerminalSpawner } from '../src/codex-workspace-bridge.js'
import { VerifiedOpenError, openVerifiedFile } from '../src/workspace-bridge.js'

const signal = new AbortController().signal
const states: CodexWorkspaceState[] = []
function state(): CodexWorkspaceState { const value = new CodexWorkspaceState(); states.push(value); return value }
afterEach(async () => { await Promise.all(states.splice(0).map(value => value.dispose())) })

/** Pull frames as the Host publishes them, so ordering is observable. */
class FakeOutput implements AsyncIterable<string> {
  private values: string[] = []
  private waiters: Array<(value: IteratorResult<string>) => void> = []
  private ends: Array<() => void> = []
  private ended = false
  push(value: string): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.values.push(value)
  }
  onEnd(listener: () => void): void {
    if (this.ended) listener()
    else this.ends.push(listener)
  }
  end(): void {
    this.ended = true
    while (this.waiters.length) this.waiters.shift()!({ done: true, value: undefined as never })
    for (const listener of this.ends) listener()
    this.ends = []
  }
  next(): Promise<IteratorResult<string>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.ended) return Promise.resolve({ done: true, value: undefined as never })
    return new Promise(resolve => this.waiters.push(resolve))
  }
  [Symbol.asyncIterator](): AsyncIterator<string> { return this }
}

function fakeSpawner() {
  const writes: string[] = []
  const outputs: FakeOutput[] = []
  const spawn: RemoteTerminalSpawner = async (): Promise<RemoteTerminalProcess> => {
    const output = new FakeOutput()
    outputs.push(output)
    // A real process reports its exit when the output stream closes.
    const completed = new Promise<{ exitCode: number | null }>(resolve => { output.onEnd(() => resolve({ exitCode: 0 })) })
    return {
      output,
      write: (data: string) => { writes.push(data) },
      resize: () => undefined,
      terminate: () => { output.end() },
      completed,
    }
  }
  return {
    spawn,
    writes,
    emit: (data: string) => outputs.at(-1)?.push(data),
    latest: () => outputs.at(-1),
  }
}

async function frame(stream: AsyncIterable<unknown> | undefined): Promise<Record<string, unknown>> {
  if (stream === undefined) throw new Error('stream was not opened')
  const next = await stream[Symbol.asyncIterator]().next()
  return next.value as Record<string, unknown>
}

describe('CodeX workspace and terminal bridge', () => {
  it('maps file calls to each thread cwd and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
    const other = await mkdtemp(join(tmpdir(), 'dsh-codex-other-'))
    await writeFile(join(root, 'hello.txt'), 'hello')
    await writeFile(join(other, 'secret.txt'), 'secret')
    const resolvedRoot = await realpath(root)
    const bridge = new CodexWorkspaceBridge(async thread => thread === 'one' ? root : other, () => true)
    await expect(bridge.call('workspaceFiles/list', { args: { workspaceFileScopeId: 'codex:one', path: '.' } }, signal)).resolves.toMatchObject({ ok: true, value: { entries: [{ name: 'hello.txt' }] } })
    await expect(bridge.call('workspaceFiles/read', { args: { workspaceFileScopeId: 'codex:one', path: 'hello.txt', range: { offset: 0, limit: 5 } } }, signal)).resolves.toMatchObject({ ok: true, value: { text: 'hello' } })
    await expect(bridge.call('workspaceFiles/stat', { args: { workspaceFileScopeId: 'codex:one', path: 'hello.txt' } }, signal)).resolves.toMatchObject({ ok: true, value: { absolutePath: join(resolvedRoot, 'hello.txt'), version: expect.any(String), bytes: 5 } })
    await expect(bridge.call('workspaceFiles/readBytes', { args: { workspaceFileScopeId: 'codex:one', path: 'hello.txt', range: { offset: 1, length: 3 } } }, signal)).resolves.toMatchObject({ ok: true, value: { absolutePath: join(resolvedRoot, 'hello.txt'), version: expect.any(String), bytes: 5, offset: 1, data: 'ZWxs', eof: false } })
    await expect(bridge.call('workspaceFiles/readBytes', { args: { workspaceFileScopeId: 'codex:one', path: '../secret.txt' } }, signal)).rejects.toMatchObject({ code: 'CODEX_WORKSPACE_PATH_DENIED' })
    // Sparse multi-GiB files must be rejected before an unbounded read/allocation.
    await writeFile(join(root, 'oversized.bin'), '')
    await truncate(join(root, 'oversized.bin'), 8 * 1024 * 1024 * 1024)
    for (const endpoint of ['workspaceFiles/read', 'workspaceFiles/readBytes']) {
      await expect(bridge.call(endpoint, { args: { workspaceFileScopeId: 'codex:one', path: 'oversized.bin' } }, signal)).rejects.toMatchObject({ code: 'CODEX_WORKSPACE_TOO_LARGE' })
    }
    await bridge.closeAll(); await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true })
  })

  it('denies escapes through absolute paths, symlinks and sibling prefixes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-boundary-'))
    const root = join(base, 'ws')
    const sibling = join(base, 'ws-evil')
    await mkdir(root); await mkdir(sibling)
    await writeFile(join(root, 'inside.txt'), 'inside')
    // A legitimate file whose name starts with dots must stay readable.
    await writeFile(join(root, '..notes.txt'), 'notes')
    await writeFile(join(sibling, 'secret.txt'), 'secret')
    // A link inside the workspace must not become a window to the outside.
    await symlink(join(sibling, 'secret.txt'), join(root, 'link-out.txt'))
    await symlink(sibling, join(root, 'link-dir'))
    const bridge = new CodexWorkspaceBridge(async () => root, () => true)
    try {
      await expect(bridge.call('workspaceFiles/read', { args: { workspaceFileScopeId: 'codex:one', path: 'inside.txt' } }, signal))
        .resolves.toMatchObject({ ok: true })
      // Positive controls: a dot-prefixed name and an absolute path inside the root
      // are both legitimate, so a regression that forbids them is caught here.
      await expect(bridge.call('workspaceFiles/read', { args: { workspaceFileScopeId: 'codex:one', path: '..notes.txt' } }, signal))
        .resolves.toMatchObject({ ok: true, value: { text: 'notes' } })
      await expect(bridge.call('workspaceFiles/read', { args: { workspaceFileScopeId: 'codex:one', path: join(await realpath(root), 'inside.txt') } }, signal))
        .resolves.toMatchObject({ ok: true })
      const denial = async (path: string) => {
        const error = await bridge.call('workspaceFiles/read', { args: { workspaceFileScopeId: 'codex:one', path } }, signal)
          .then(() => undefined, (reason: unknown) => reason as { code?: string; message?: string })
        expect(error?.code).toBe('CODEX_WORKSPACE_PATH_DENIED')
        return error?.message ?? ''
      }
      // The absolute sibling is refused by the lexical containment check...
      expect(await denial(join(sibling, 'secret.txt'))).toContain('outside the CodeX workspace')
      // ...as is a plain `..` escape.
      expect(await denial('../ws-evil/secret.txt')).toContain('outside the CodeX workspace')
      // Symlinks are refused by the canonical check, which reports a different reason.
      for (const path of ['link-out.txt', 'link-dir/secret.txt']) {
        expect(await denial(path)).toContain('unavailable')
      }
      // A directory endpoint must not accept a regular file, and vice versa.
      await expect(bridge.call('workspaceFiles/list', { args: { workspaceFileScopeId: 'codex:one', path: 'inside.txt' } }, signal))
        .rejects.toMatchObject({ code: 'CODEX_WORKSPACE_PATH_DENIED' })
      // Reading a directory is refused as well, with its own stable code.
      await expect(bridge.call('workspaceFiles/read', { args: { workspaceFileScopeId: 'codex:one', path: '.' } }, signal))
        .rejects.toMatchObject({ code: 'CODEX_WORKSPACE_INVALID_PATH' })
    } finally {
      await bridge.closeAll()
      await rm(base, { recursive: true, force: true })
    }
  })

  it('refuses a file that turns into a symlink after the canonical check', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-toctou-'))
    const root = join(base, 'ws')
    await mkdir(root)
    const outside = join(base, 'secret.txt')
    await writeFile(outside, 'secret')
    const inside = join(root, 'inside.txt')
    await writeFile(inside, 'inside')
    try {
      const info = await stat(inside)
      // Same inode: the verified open succeeds and returns the expected content.
      const ok = await openVerifiedFile(inside, { dev: info.dev, ino: info.ino })
      const buf = Buffer.alloc(6)
      const read = await ok.read(buf, 0, 6, 0)
      await ok.close()
      expect(buf.subarray(0, read.bytesRead).toString()).toBe('inside')
      // A different inode (the file was swapped) is refused instead of read.
      await expect(openVerifiedFile(inside, { dev: info.dev, ino: info.ino + 1 }))
        .rejects.toMatchObject({ kind: 'changed' })
      // A symlink at the checked path is refused by O_NOFOLLOW.
      await rm(inside)
      await symlink(outside, inside)
      await expect(openVerifiedFile(inside, { dev: info.dev, ino: info.ino }))
        .rejects.toMatchObject({ kind: 'symlink' })
      await expect(openVerifiedFile(inside, { dev: info.dev, ino: info.ino })).rejects.toBeInstanceOf(VerifiedOpenError)
      // Other open failures keep their own meaning instead of posing as a symlink.
      const missing = await openVerifiedFile(join(root, 'absent.txt'), { dev: info.dev, ino: info.ino })
        .then(() => undefined, (reason: unknown) => reason as { code?: string })
      expect(missing).not.toBeInstanceOf(VerifiedOpenError)
      expect(missing?.code).toBe('ENOENT')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('returns stable errors for invalid or cwd-less threads', async () => {
    const bridge = new CodexWorkspaceBridge(async thread => thread === 'missing' ? undefined : '/does/not/exist', () => true)
    await expect(bridge.call('workspaceFiles/list', { args: { workspaceFileScopeId: 'codex:missing', path: '.' } }, signal)).rejects.toMatchObject({ code: 'CODEX_WORKSPACE_UNAVAILABLE' })
    await expect(bridge.call('workspaceFiles/list', { args: { workspaceFileScopeId: 'codex:', path: '.' } }, signal)).rejects.toMatchObject({ code: 'CODEX_SESSION_INVALID' })
    for (const endpoint of ['terminal/create', 'terminal/list', 'terminal/follow', 'terminal/retain']) {
      const payload = { args: { agentId: 'codex:one', workspaceFileScopeId: 'codex:other', id: 't1', request: { id: 't1' } } }
      const result = endpoint === 'terminal/follow' || endpoint === 'terminal/retain'
        ? bridge.open(endpoint, payload, signal) : bridge.call(endpoint, payload, signal)
      await expect(result).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    }
    await bridge.closeAll()
  })

  it('answers the official terminal environment, shells and info shapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
    const resolved = await realpath(root)
    const bridge = new CodexWorkspaceBridge(async () => root, () => true, state(), fakeSpawner().spawn)
    const environment = await bridge.call('terminal/environment', { args: { agentId: 'codex:one' } }, signal)
    expect(environment).toMatchObject({ ok: true, value: { cwd: resolved, maxInputBytes: expect.any(Number), maxCols: expect.any(Number), maxRows: expect.any(Number), scrollback: expect.any(Number) } })
    const shells = await bridge.call('terminal/shells', { args: { agentId: 'codex:one' } }, signal)
    expect(shells?.ok && shells.value).toEqual(expect.arrayContaining([{ path: expect.any(String), args: expect.any(Array), name: expect.any(String) }]))
    const created = await bridge.call('terminal/create', { args: { agentId: 'codex:one', request: { id: 't1', cols: 80, rows: 24 } } }, signal)
    expect(created).toMatchObject({
      ok: true,
      value: {
        id: 't1', title: expect.any(String), cwd: resolved, cols: 80, rows: 24, state: 'running', exitCode: null,
        shell: { path: expect.any(String), args: expect.any(Array), name: expect.any(String) },
      },
    })
    expect(created?.ok ? (created.value as Record<string, unknown>).controllerId : undefined).toBeUndefined()
    await bridge.closeAll(); await rm(root, { recursive: true, force: true })
  })

  it('keeps terminal contexts isolated per CodeX thread and returns void mutations', async () => {
    const one = await mkdtemp(join(tmpdir(), 'dsh-codex-one-'))
    const two = await mkdtemp(join(tmpdir(), 'dsh-codex-two-'))
    const provider = fakeSpawner()
    const bridge = new CodexWorkspaceBridge(async thread => thread === 'one' ? one : two, () => true, state(), provider.spawn)
    await bridge.call('terminal/create', { args: { agentId: 'codex:one', request: { id: 't1', cols: 80, rows: 24 } } }, signal)
    await expect(bridge.call('terminal/list', { args: { sessionId: 'codex:two' } }, signal)).resolves.toMatchObject({ ok: true, value: [] })
    await expect(bridge.call('terminal/write', { args: { agentId: 'codex:two', id: 't1', attachmentId: 'a1', data: 'x' } }, signal)).rejects.toMatchObject({ code: 'CODEX_TERMINAL_NOT_FOUND' })
    // Only a live attachment may mutate input or dimensions.
    const stream = await bridge.open('terminal/follow', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1' } }, signal)
    await frame(stream)
    // Mutations resolve to void, and the stored title still changes.
    await expect(bridge.call('terminal/rename', { args: { agentId: 'codex:one', id: 't1', title: 'renamed' } }, signal)).resolves.toEqual({ ok: true })
    await expect(bridge.call('terminal/resize', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1', cols: 100, rows: 30 } }, signal)).resolves.toEqual({ ok: true })
    await expect(bridge.call('terminal/write', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1', data: 'ls\n' } }, signal)).resolves.toEqual({ ok: true })
    expect(provider.writes).toEqual(['ls\n'])
    await expect(bridge.call('terminal/list', { args: { sessionId: 'codex:one' } }, signal)).resolves.toMatchObject({ ok: true, value: [{ id: 't1', title: 'renamed', cols: 100, rows: 30 }] })
    await expect(bridge.call('terminal/close', { args: { agentId: 'codex:one', id: 't1' } }, signal)).resolves.toEqual({ ok: true })
    await expect(bridge.call('terminal/list', { args: { sessionId: 'codex:one' } }, signal)).resolves.toMatchObject({ ok: true, value: [] })
    await bridge.closeAll(); await rm(one, { recursive: true, force: true }); await rm(two, { recursive: true, force: true })
  })

  it('acknowledges retention, then replays a snapshot and ordered output to the new controller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
    const provider = fakeSpawner()
    const bridge = new CodexWorkspaceBridge(async () => root, () => true, state(), provider.spawn)
    await bridge.call('terminal/create', { args: { agentId: 'codex:one', request: { id: 't1', cols: 80, rows: 24 } } }, signal)

    const retention = await bridge.open('terminal/retain', { args: { sessionId: 'codex:one', id: 't1' } }, signal)
    await expect(frame(retention)).resolves.toEqual({ type: 'retained' })

    const first = await bridge.open('terminal/follow', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1' } }, signal)
    const snapshot = await frame(first)
    expect(snapshot).toMatchObject({ type: 'snapshot', sequence: 0, screen: '', info: { id: 't1', controllerId: 'a1', state: 'running' } })

    provider.emit('one')
    await expect(frame(first)).resolves.toEqual({ type: 'output', sequence: 1, data: 'one' })
    provider.emit('two')
    await expect(frame(first)).resolves.toEqual({ type: 'output', sequence: 2, data: 'two' })

    // A second attachment takes input ownership and recovers from the journal.
    const second = await bridge.open('terminal/follow', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a2' } }, signal)
    await expect(frame(second)).resolves.toMatchObject({ type: 'snapshot', sequence: 2, screen: expect.stringContaining('onetwo'), info: { controllerId: 'a2' } })
    await expect(frame(first)).resolves.toMatchObject({ type: 'state', info: { controllerId: 'a2' } })

    await bridge.closeAll(); await rm(root, { recursive: true, force: true })
  })

  it('reports the exit state once the process ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
    const provider = fakeSpawner()
    const bridge = new CodexWorkspaceBridge(async () => root, () => true, state(), provider.spawn)
    await bridge.call('terminal/create', { args: { agentId: 'codex:one', request: { id: 't1', cols: 80, rows: 24 } } }, signal)
    const stream = await bridge.open('terminal/follow', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1' } }, signal)
    await frame(stream)
    provider.latest()?.end()
    await expect(frame(stream)).resolves.toMatchObject({ type: 'state', info: { state: 'exited', exitCode: 0 } })
    await bridge.closeAll(); await rm(root, { recursive: true, force: true })
  })

  it('drives a Host subprocess terminal through the PTY adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-pty-'))
    const spawns: Record<string, unknown>[] = []
    const writes: string[] = []
    const resizes: number[][] = []
    const output = new PassThrough()
    let settle: (value: { exitCode: number | null }) => void = () => undefined
    const done = new Promise<{ exitCode: number | null }>(resolve => { settle = resolve })
    const handle = {
      output,
      write: async (data: string) => { writes.push(data) },
      resize: async (cols: number, rows: number) => { resizes.push([cols, rows]) },
      terminate: async () => { output.end(); settle({ exitCode: 0 }) },
      done,
    }
    const bridge = new CodexWorkspaceBridge(async () => root, () => true, state(),
      subprocessTerminalSpawner({
        terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/bash' }),
        resolveExecutable: async file => { if (file !== '/bin/bash' && file !== 'bash') throw Object.assign(new Error(), { name: 'SubprocessExecutableNotFoundError' }); return '/bin/bash' },
        spawnTerminal: async spec => { spawns.push(spec); return handle },
      }))

    const allocation = new AbortController()
    await expect(bridge.call('terminal/create', { args: { agentId: 'codex:one', request: { id: 't1', cols: 90, rows: 30 } } }, allocation.signal))
      .resolves.toMatchObject({ ok: true, value: { id: 't1', cols: 90, rows: 30 } })
    expect(spawns).toEqual([{
      argv: ['/bin/bash', '-i'],
      cwd: await realpath(root),
      cols: 90,
      rows: 30,
      terminalType: 'xterm-256color',
      env: { DSH_SESSION_ID: 'codex:one' },
      shellActivity: true, graceMs: 1000, signal: expect.any(AbortSignal),
    }])
    allocation.abort()
    expect((spawns[0]!.signal as AbortSignal).aborted).toBe(false)

    const stream = await bridge.open('terminal/follow', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1' } }, signal)
    await expect(frame(stream)).resolves.toMatchObject({ type: 'snapshot', sequence: 0, info: { controllerId: 'a1' } })
    output.write('ready\n')
    await expect(frame(stream)).resolves.toEqual({ type: 'output', sequence: 1, data: 'ready\n' })

    await bridge.call('terminal/write', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1', data: 'ls\n' } }, signal)
    await bridge.call('terminal/resize', { args: { agentId: 'codex:one', id: 't1', attachmentId: 'a1', cols: 100, rows: 40 } }, signal)
    expect(writes).toEqual(['ls\n'])
    expect(resizes).toEqual([[100, 40]])
    await expect(frame(stream)).resolves.toMatchObject({ type: 'state', info: { cols: 100, rows: 40 } })
    await bridge.call('terminal/close', { args: { agentId: 'codex:one', id: 't1' } }, signal)
    await expect(frame(stream)).resolves.toMatchObject({ type: 'state', info: { state: 'exited' } })
    await bridge.closeAll(); await rm(root, { recursive: true, force: true })
  })
})
