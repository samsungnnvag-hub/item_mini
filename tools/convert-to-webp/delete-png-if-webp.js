import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')

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

let deleted = 0
let kept = 0
const missingWebp = []

const pngFiles = await walk(ROOT)
console.log(`Tìm thấy ${pngFiles.length} file .png`)

for (const pngPath of pngFiles) {
  const webpPath = pngPath.replace(/\.png$/i, '.webp')
  try {
    await fs.access(webpPath)
    await fs.unlink(pngPath)
    deleted++
    if (deleted % 50 === 0) {
      console.log(`  ... đã xóa ${deleted}`)
    }
  } catch {
    kept++
    missingWebp.push(path.basename(pngPath))
  }
}

console.log('\n=== Kết quả ===')
console.log(`Đã xóa .png (có .webp tương ứng): ${deleted}`)
console.log(`Giữ lại .png (chưa có .webp): ${kept}`)
if (missingWebp.length > 0) {
  console.log('\nPNG chưa có webp (giữ lại):')
  for (const name of missingWebp) console.log(`  - ${name}`)
}
