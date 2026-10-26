#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Source: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
// Checked 2026-10-26. This covers current iPhone and iPad display classes, not every legacy size or platform.
export const SIZES = [
  ['iPhone Duo outer display', [[1398, 2034]]],
  ['iPhone Duo inner display', [[2007, 2853]]],
  ['iPhone Dynamic Island, large', [[1260, 2736], [1290, 2796], [1320, 2868]]],
  ['iPhone Face ID, large', [[1284, 2778], [1242, 2688]]],
  ['iPhone Dynamic Island, medium', [[1179, 2556], [1206, 2622]]],
  ['iPhone Face ID, medium', [[1170, 2532], [1125, 2436], [1080, 2340]]],
  ['iPhone Home Button, large', [[1242, 2208]]],
  ['iPhone Home Button, medium', [[750, 1334]]],
  ['iPad 13-inch', [[2064, 2752]]],
  ['iPad 12.9-inch', [[2048, 2732]]],
  ['iPad 11-inch', [[1488, 2266], [1668, 2420], [1668, 2388], [1640, 2360]]],
  ['iPad 10.5-inch', [[1668, 2224]]],
]

const IMAGE = /\.(png|jpe?g)$/i
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

export function sizeClass(width, height) {
  for (const [name, sizes] of SIZES) {
    if (sizes.some(([w, h]) => (w === width && h === height) || (w === height && h === width))) return name
  }
  return null
}

export function inspectBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) {
    if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) {
      throw new Error('invalid PNG header')
    }
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    const colorType = bytes[25]
    if (!width || !height || ![0, 2, 3, 4, 6].includes(colorType)) throw new Error('invalid PNG dimensions or color type')
    let alpha = colorType === 4 || colorType === 6
    let foundImageData = false
    let offset = 8
    for (let chunks = 0; chunks < 256 && offset + 12 <= bytes.length; chunks++) {
      const length = bytes.readUInt32BE(offset)
      if (length > bytes.length - offset - 12) throw new Error('truncated PNG chunk')
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'tRNS') alpha = true
      if (type === 'IDAT') { foundImageData = true; break }
      if (type === 'IEND') break
      offset += length + 12
    }
    if (!foundImageData) throw new Error('PNG image data not found')
    return { width, height, format: 'PNG', alpha }
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error('invalid JPEG marker')
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) throw new Error('truncated JPEG segment')
      if (SOF.has(marker)) {
        if (length < 7) throw new Error('invalid JPEG frame')
        const height = bytes.readUInt16BE(offset + 3)
        const width = bytes.readUInt16BE(offset + 5)
        if (!width || !height) throw new Error('invalid JPEG dimensions')
        return { width, height, format: 'JPEG', alpha: false }
      }
      offset += length
    }
    throw new Error('JPEG dimensions not found')
  }
  throw new Error('file is not PNG or JPEG')
}

async function filesFor(input) {
  const full = resolve(input)
  const info = await stat(full)
  if (info.isFile()) return [full]
  if (!info.isDirectory()) throw new Error(`${input}: not a file or directory`)
  const entries = await readdir(full, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && IMAGE.test(entry.name)).map((entry) => join(full, entry.name)).sort()
}

export async function checkPaths(inputs) {
  const sets = new Map()
  for (const input of inputs) {
    for (const file of await filesFor(input)) {
      const folder = dirname(file)
      const group = sets.get(folder) ?? []
      let image = null
      let error = null
      try { image = inspectBytes(await readFile(file)) } catch (cause) { error = cause.message }
      const device = image ? sizeClass(image.width, image.height) : null
      group.push({ file: basename(file), folder, image, device, error })
      sets.set(folder, group)
    }
  }
  return sets
}

export function report(sets) {
  const lines = []
  let failures = 0
  if (sets.size === 0) return { lines: ['No PNG or JPEG files found.'], failures: 1 }
  for (const [folder, files] of sets) {
    lines.push(`${folder} (${files.length} image${files.length === 1 ? '' : 's'})`)
    const counts = new Map()
    for (const item of files) if (item.device) counts.set(item.device, (counts.get(item.device) ?? 0) + 1)
    for (const item of files) {
      const { image, device, error } = item
      const reasons = []
      if (error) reasons.push(error)
      if (image && !device) reasons.push(`${image.width}x${image.height} is not a listed modern iPhone/iPad size`)
      if (image?.alpha) reasons.push('PNG alpha/transparency must be removed')
      if (device && counts.get(device) > 10) reasons.push(`${counts.get(device)} files for ${device}; maximum 10 per device size and localization`)
      if (reasons.length) failures++
      lines.push(`  ${reasons.length ? 'FAIL' : 'PASS'} ${item.file}${image ? ` — ${image.width}x${image.height} ${image.format}${device ? `, ${device}` : ''}` : ''}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`)
    }
  }
  lines.push(`${failures ? `${failures} file${failures === 1 ? '' : 's'} need attention` : 'All checked files passed the header, size and per-folder count checks'}. Review each locale and App Store Connect well before submitting.`)
  return { lines, failures }
}

async function main() {
  const inputs = process.argv.slice(2)
  if (inputs.includes('--help') || inputs.includes('-h')) {
    console.log('Usage: node cli.mjs <screenshots-directory> [another-locale-directory ...]')
    console.log('Checks PNG/JPEG headers, listed modern iPhone/iPad dimensions, PNG transparency and a 10-file limit per folder/device class.')
    return
  }
  try {
    const result = report(await checkPaths(inputs.length ? inputs : ['.']))
    console.log(result.lines.join('\n'))
    if (result.failures) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
