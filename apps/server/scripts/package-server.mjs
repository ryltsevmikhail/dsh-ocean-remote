import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// pnpm 9 deploy in this workspace includes root-plugin production dependencies.
// Package only the explicitly audited, dependency-free runtime modules instead.
if (!process.argv[2]) throw new Error('Usage: node scripts/package-server.mjs <new-output-directory>')
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(serverRoot, '../..')
const requestedOutput = resolve(process.argv[2])
// Canonicalize the existing parent so a symlink alias cannot bypass source guards.
const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput))
const serverRequire = createRequire(join(serverRoot, 'package.json'))
const manifest = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8'))
const protocolRoot = join(repository, 'packages/protocol')
const protocol = JSON.parse(await readFile(join(protocolRoot, 'package.json'), 'utf8'))
assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@dsh-remote/protocol', 'ws', 'zod'])
assert.deepEqual(protocol.dependencies, { zod: '^3.24.1' })
const modules = []
for (const [name, version] of [['ws', '8.21.3'], ['zod', '3.25.76']]) {
  const path = serverRequire.resolve(`${name}/package.json`)
  const pkg = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(pkg.version, version, `Review new runtime version of ${name}`)
  assert.equal(pkg.license, 'MIT')
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, `Audit new runtime dependencies of ${name}`)
  assert.equal(Object.keys(pkg.optionalDependencies ?? {}).length, 0, `Audit new optional dependencies of ${name}`)
  modules.push({ name, version, path: await realpath(dirname(path)) })
}
async function copyTree(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: async path => {
      if (basename(path) === 'node_modules') return false
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Refusing symlinks inside packaged source trees.')
      return true
    },
  })
}
const sourceTrees = [join(serverRoot, 'dist'), join(protocolRoot, 'dist'), ...modules.map(module => module.path)]
for (const source of sourceTrees) {
  await lstat(source)
  const inside = relative(await realpath(source), output)
  assert(inside.startsWith(`..${sep}`) || inside === '..', 'Output must be outside source trees')
}
await lstat(join(serverRoot, 'dist/LICENSE'))
await lstat(join(serverRoot, 'dist/THIRD_PARTY_NOTICES.txt'))
// New directory only: never replace an installed app, deployment or existing data.
await mkdir(output, { mode: 0o755 })
await copyTree(join(serverRoot, 'dist'), join(output, 'dist'))
await mkdir(join(output, 'node_modules/@dsh-remote/protocol'), { recursive: true })
await copyTree(join(protocolRoot, 'dist'), join(output, 'node_modules/@dsh-remote/protocol/dist'))
await writeFile(join(output, 'node_modules/@dsh-remote/protocol/package.json'), JSON.stringify({
  name: protocol.name, version: protocol.version, type: 'module', main: './dist/index.js',
  exports: { '.': { import: './dist/index.js' } }, dependencies: { zod: modules.find(module => module.name === 'zod').version }, license: 'MIT',
}, null, 2) + '\n')
await copyTree(join(repository, 'LICENSE'), join(output, 'node_modules/@dsh-remote/protocol/LICENSE'))
for (const module of modules) await copyTree(module.path, join(output, 'node_modules', module.name))
await copyTree(join(repository, 'LICENSE'), join(output, 'LICENSE'))
await writeFile(join(output, 'package.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, private: true, type: 'module', license: 'MIT',
  scripts: { start: 'node dist/main.js' },
  dependencies: { '@dsh-remote/protocol': protocol.version, ...Object.fromEntries(modules.map(module => [module.name, module.version])) },
}, null, 2) + '\n')
console.log('Packaged server with protocol, ws and zod only; no root-plugin or optional native dependencies.')
