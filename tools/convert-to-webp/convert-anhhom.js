import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const ANHHOM = path.resolve(
  'E:/MINICITY/txData/Qbox_2B74CE.base/resources/[TINH_NANG]/mini-case/assets/images/anhhom'
)

let converted = 0
let skipped = 0

const files = await fs.readdir(ANHHOM)
for (const name of files) {
  if (!/\.png$/i.test(name)) continue
  const pngPath = path.join(ANHHOM, name)
  const webpPath = pngPath.replace(/\.png$/i, '.webp')
  const pngStat = await fs.stat(pngPath)
  const webpStat = await fs.stat(webpPath).catch(() => null)
  if (webpStat && webpStat.mtimeMs >= pngStat.mtimeMs) {
    skipped++
    continue
  }
  await sharp(pngPath).webp({ quality: 85, effort: 4 }).toFile(webpPath)
  converted++
  console.log(`  ${name} -> ${path.basename(webpPath)}`)
}

console.log(`\nDone: ${converted} converted, ${skipped} skipped`)
