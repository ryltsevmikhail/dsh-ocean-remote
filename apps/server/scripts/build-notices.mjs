import { createRequire } from 'node:module'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectLicense = await readFile(join(serverRoot, '../../LICENSE'), 'utf8')
const serverRequire = createRequire(join(serverRoot, 'package.json'))
// Audited installed LICENSE files. Updating these versions requires a new review.
const audited = new Map(Object.entries({
  ws: '8.21.3', zod: '3.25.76', react: '18.3.1', 'react-dom': '18.3.1',
  scheduler: '0.23.2', 'loose-envify': '1.4.0', 'js-tokens': '4.0.0',
}))
const visited = new Set()
const records = []
async function visit(name, parentRequire, optional = false) {
  let manifestPath
  try { manifestPath = parentRequire.resolve(`${name}/package.json`) }
  catch (error) {
    if (optional && error.code === 'MODULE_NOT_FOUND') return
    throw error
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const id = `${manifest.name}@${manifest.version}`
  if (visited.has(id)) return
  visited.add(id)
  if (audited.get(manifest.name) !== manifest.version || manifest.license !== 'MIT') {
    throw new Error(`Review LICENSE/NOTICE before shipping ${id}.`)
  }
  const directory = dirname(manifestPath)
  const legalNames = (await readdir(directory)).filter(file => /^(LICENSE|NOTICE|COPYING)(\.(md|txt))?$/i.test(file)).sort()
  if (!legalNames.some(file => /^LICENSE/i.test(file))) throw new Error(`Missing LICENSE for ${id}.`)
  const sections = []
  for (const file of legalNames) sections.push(`${file}\n${await readFile(join(directory, file), 'utf8')}`)
  records.push({ id, text: sections.join('\n\n') })
  const childRequire = createRequire(manifestPath)
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) await visit(dependency, childRequire)
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) await visit(dependency, childRequire, true)
  for (const [dependency, metadata] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    if (metadata.optional) await visit(dependency, childRequire, true)
  }
}
for (const name of ['ws', 'zod', 'react', 'react-dom']) await visit(name, serverRequire)
records.sort((a, b) => a.id.localeCompare(b.id, 'en'))
const text = [
  'DSH Ocean Remote — project and third-party license notices',
  'Includes server runtime dependencies and the conservative UI dependency closure. Some helpers may be eliminated by the production bundler.',
  `PROJECT LICENSE (also covers the internal protocol package)\n\n${projectLicense}`,
  ...records.map(record => `${'='.repeat(72)}\n${record.id}\n\n${record.text}`),
].join('\n\n') + '\n'
await mkdir(join(serverRoot, 'dist/public'), { recursive: true })
await writeFile(join(serverRoot, 'dist/LICENSE'), projectLicense)
await writeFile(join(serverRoot, 'dist/THIRD_PARTY_NOTICES.txt'), text)
await writeFile(join(serverRoot, 'dist/public/THIRD_PARTY_NOTICES.txt'), text)
console.log(`Included full licenses for ${records.length} audited third-party packages.`)
