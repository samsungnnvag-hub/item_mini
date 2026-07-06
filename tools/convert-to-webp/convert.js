import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DELETE_PNG = process.argv.includes('--delete-png')
const QUALITY = 85

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'tools' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else if (entry.isFile() && /\.png$/i.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

let converted = 0
let skipped = 0
let failed = 0

const pngFiles = await walk(ROOT)
console.log(`Tìm thấy ${pngFiles.length} file .png trong ${ROOT}`)

for (const pngPath of pngFiles) {
  const webpPath = pngPath.replace(/\.png$/i, '.webp')
  try {
    const webpStat = await fs.stat(webpPath).catch(() => null)
    const pngStat = await fs.stat(pngPath)
    if (webpStat && webpStat.mtimeMs >= pngStat.mtimeMs) {
      skipped++
      continue
    }

    await sharp(pngPath)
      .webp({ quality: QUALITY, effort: 4 })
      .toFile(webpPath)

    converted++
    if (converted % 50 === 0) {
      console.log(`  ... đã convert ${converted}/${pngFiles.length}`)
    }

    if (DELETE_PNG) {
      await fs.unlink(pngPath)
    }
  } catch (err) {
    failed++
    console.error(`Lỗi: ${path.basename(pngPath)} — ${err.message}`)
  }
}

console.log('\n=== Kết quả ===')
console.log(`Convert mới: ${converted}`)
console.log(`Bỏ qua (webp đã mới hơn): ${skipped}`)
console.log(`Lỗi: ${failed}`)
if (!DELETE_PNG) {
  console.log('\nGợi ý: sau khi upload Supabase xong, chạy npm run convert:delete-png để xóa .png')
}
