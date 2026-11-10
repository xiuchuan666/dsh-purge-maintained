import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverTests, validateMetadata } from './check-lib.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { ALL_PATCHES } = await import(new URL('../lib/core.js', import.meta.url).href)
const result = validateMetadata(root, ALL_PATCHES)
const tests = discoverTests(root)
console.log(`[metadata] PASS version=${result.version} patches=${result.patchCount} tests=${tests.length}`)
