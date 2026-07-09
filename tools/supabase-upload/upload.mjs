#!/usr/bin/env node
/**
 * Convert PNG → WebP (xóa PNG sau khi convert), rồi upload ảnh item lên Supabase.
 *
 * Cách dùng:
 *   cd tools/supabase-upload
 *   copy .env.example .env   (điền URL + service_role key)
 *   npm install
 *   npm run upload
 *
 * Tuỳ chọn:
 *   node upload.mjs --dry-run
 *   node upload.mjs --no-convert           (bỏ qua bước PNG → WebP)
 *   node upload.mjs --no-list-remote       (không so sánh bucket, chỉ dựa progress local)
 *   node upload.mjs --concurrency 3 --delay-ms 100
 *   node upload.mjs --limit 500            (test 500 file đầu)
 *   node upload.mjs --status               (xem tiến độ đã lưu)
 *   node upload.mjs --retry-failed         (chỉ upload lại file lỗi)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOL_DIR = __dirname
const REPO_ROOT = path.resolve(TOOL_DIR, '../..')
const PROGRESS_FILE = path.join(TOOL_DIR, 'upload-progress.json')
const FAILURES_FILE = path.join(TOOL_DIR, 'upload-failures.jsonl')

const MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    status: false,
    retryFailed: false,
    convertPng: true,
    listRemote: true,
    concurrency: 4,
    delayMs: 80,
    batchPauseEvery: 200,
    batchPauseMs: 1500,
    limit: 0,
    prefix: '',
    extensions: ['.webp'],
    sourceDir: REPO_ROOT,
    webpQuality: 85,
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--status') opts.status = true
    else if (arg === '--retry-failed') opts.retryFailed = true
    else if (arg === '--no-convert') opts.convertPng = false
    else if (arg === '--list-remote') opts.listRemote = true
    else if (arg === '--no-list-remote') opts.listRemote = false
    else if (arg === '--webp-quality') opts.webpQuality = Math.min(100, Math.max(1, Number(argv[++i]) || 85))
    else if (arg === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]) || 4)
    else if (arg === '--delay-ms') opts.delayMs = Math.max(0, Number(argv[++i]) || 80)
    else if (arg === '--batch-pause-every') opts.batchPauseEvery = Math.max(0, Number(argv[++i]) || 200)
    else if (arg === '--batch-pause-ms') opts.batchPauseMs = Math.max(0, Number(argv[++i]) || 1500)
    else if (arg === '--limit') opts.limit = Math.max(0, Number(argv[++i]) || 0)
    else if (arg === '--prefix') opts.prefix = String(argv[++i] || '').replace(/^\/+|\/+$/g, '')
    else if (arg === '--source') opts.sourceDir = path.resolve(argv[++i] || REPO_ROOT)
    else if (arg === '--ext') opts.extensions = String(argv[++i] || '.webp').split(',').map((e) => (e.startsWith('.') ? e : `.${e}`))
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 18).join('\n'))
      process.exit(0)
    }
  }

  return opts
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return { uploaded: {}, stats: { ok: 0, fail: 0, skipped: 0, bytes: 0 }, startedAt: null, updatedAt: null }
  }
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
  } catch {
    return { uploaded: {}, stats: { ok: 0, fail: 0, skipped: 0, bytes: 0 }, startedAt: null, updatedAt: null }
  }
}

function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString()
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2))
}

function appendFailure(entry) {
  fs.appendFileSync(FAILURES_FILE, `${JSON.stringify(entry)}\n`)
}

function shouldSkipDir(name) {
  return name === '.git' || name === 'node_modules' || name === 'tools'
}

function collectImageFiles(dir, extensions, out = []) {
  if (!fs.existsSync(dir)) return out
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue
      collectImageFiles(full, extensions, out)
      continue
    }
    const ext = path.extname(ent.name).toLowerCase()
    if (!extensions.includes(ext)) continue
    out.push(full)
  }
  return out
}

function collectPngFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue
      collectPngFiles(full, out)
      continue
    }
    if (path.extname(ent.name).toLowerCase() === '.png') out.push(full)
  }
  return out
}

async function convertPngToWebp(sourceDir, opts) {
  const pngFiles = collectPngFiles(sourceDir)
  if (pngFiles.length === 0) {
    console.log('Không có file PNG cần convert.')
    return { converted: 0, deleted: 0, skipped: 0, failed: 0 }
  }

  console.log(`\n=== Bước 1: Convert PNG → WebP (${pngFiles.length} file) ===`)
  const stats = { converted: 0, deleted: 0, skipped: 0, failed: 0 }

  for (const pngPath of pngFiles) {
    const webpPath = pngPath.replace(/\.png$/i, '.webp')
    const rel = path.relative(sourceDir, pngPath).split(path.sep).join('/')

    if (opts.dryRun) {
      console.log(`  [DRY] ${rel} → ${path.basename(webpPath)} (xóa PNG)`)
      stats.converted++
      continue
    }

    try {
      await sharp(pngPath)
        .webp({ quality: opts.webpQuality })
        .toFile(webpPath)

      fs.unlinkSync(pngPath)
      stats.converted++
      stats.deleted++
      console.log(`  ✓ ${rel}`)
    } catch (err) {
      stats.failed++
      console.error(`  ✗ ${rel}: ${err?.message || err}`)
    }
  }

  console.log(
    `Convert xong: ${stats.converted} OK | ${stats.failed} lỗi | ${stats.deleted} PNG đã xóa`
  )
  return stats
}

function toStoragePath(absFile, sourceDir, prefix) {
  const rel = path.relative(sourceDir, absFile).split(path.sep).join('/')
  return prefix ? `${prefix}/${rel}` : rel
}

function publicUrl(supabaseUrl, bucket, storagePath) {
  const base = supabaseUrl.replace(/\/$/, '')
  const encoded = storagePath.split('/').map(encodeURIComponent).join('/')
  return `${base}/storage/v1/object/public/${bucket}/${encoded}`
}

async function listRemotePaths(supabase, bucket, prefix = '') {
  const existing = new Set()
  let offset = 0
  const limit = 1000

  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix || undefined, {
      limit,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    })
    if (error) throw error
    if (!data || data.length === 0) break

    for (const item of data) {
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name
      if (item.id === null) {
        const nested = await listRemotePaths(supabase, bucket, itemPath)
        for (const p of nested) existing.add(p)
      } else {
        existing.add(itemPath)
      }
    }

    if (data.length < limit) break
    offset += limit
    process.stdout.write(`\rĐang liệt kê bucket... ${existing.size} file`)
  }
  process.stdout.write('\n')
  return existing
}

async function uploadOne(supabase, bucket, absFile, storagePath, upsert) {
  const ext = path.extname(absFile).toLowerCase()
  const contentType = MIME[ext] || 'application/octet-stream'
  const body = fs.readFileSync(absFile)
  const { error } = await supabase.storage.from(bucket).upload(storagePath, body, {
    upsert,
    contentType,
    cacheControl: '31536000',
  })
  if (error) throw error
  return body.length
}

async function runPool(items, concurrency, worker) {
  let index = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const i = index++
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

async function main() {
  loadEnvFile(path.join(TOOL_DIR, '.env'))
  const opts = parseArgs(process.argv)

  if (opts.status) {
    const p = loadProgress()
    const uploadedCount = Object.keys(p.uploaded || {}).length
    console.log('Tiến độ upload:')
    console.log(`  Đã upload: ${uploadedCount}`)
    console.log(`  OK: ${p.stats?.ok ?? 0} | Skip: ${p.stats?.skipped ?? 0} | Fail: ${p.stats?.fail ?? 0}`)
    console.log(`  Dung lượng: ${((p.stats?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`)
    console.log(`  Bắt đầu: ${p.startedAt || '—'}`)
    console.log(`  Cập nhật: ${p.updatedAt || '—'}`)
    if (fs.existsSync(FAILURES_FILE)) {
      const failLines = fs.readFileSync(FAILURES_FILE, 'utf8').trim().split('\n').filter(Boolean)
      console.log(`  File lỗi (jsonl): ${failLines.length}`)
    }
    return
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  const bucket = process.env.SUPABASE_BUCKET || 'item_mini'

  if (!opts.dryRun && (!supabaseUrl || !serviceKey)) {
    console.error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_KEY trong .env')
    console.error('Copy .env.example → .env và điền service_role key (không dùng anon key).')
    process.exit(1)
  }

  const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null
  const progress = loadProgress()
  if (!progress.startedAt) progress.startedAt = new Date().toISOString()
  progress.stats = { ok: 0, fail: 0, skipped: 0, bytes: 0 }

  if (opts.convertPng) {
    await convertPngToWebp(opts.sourceDir, opts)
  }

  console.log('\n=== Bước 2: Upload ảnh lên Supabase ===')
  let files = collectImageFiles(opts.sourceDir, opts.extensions)
  files.sort()

  if (opts.retryFailed && fs.existsSync(FAILURES_FILE)) {
    const failedPaths = new Set()
    for (const line of fs.readFileSync(FAILURES_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row.absFile) failedPaths.add(row.absFile)
      } catch { /* ignore */ }
    }
    files = files.filter((f) => failedPaths.has(f))
    console.log(`Chế độ retry: ${files.length} file lỗi`)
  }

  let remoteSet = null
  if (opts.listRemote && supabase) {
    console.log('Đang kiểm tra file trên Supabase bucket (có thể mất vài phút)...')
    remoteSet = await listRemotePaths(supabase, bucket, opts.prefix || undefined)
    console.log(`Đã có trên bucket: ${remoteSet.size} file`)
  }

  const queue = []
  for (const absFile of files) {
    const storagePath = toStoragePath(absFile, opts.sourceDir, opts.prefix)
    if (progress.uploaded[storagePath]) {
      progress.stats.skipped++
      continue
    }
    if (remoteSet && remoteSet.has(storagePath)) {
      progress.uploaded[storagePath] = { at: new Date().toISOString(), skippedRemote: true }
      progress.stats.skipped++
      continue
    }
    queue.push({ absFile, storagePath })
    if (opts.limit > 0 && queue.length >= opts.limit) break
  }

  const total = queue.length
  const localSkip = files.length - total
  console.log(`Nguồn: ${opts.sourceDir}`)
  console.log(`Bucket: ${bucket}${opts.prefix ? `/${opts.prefix}` : ''}`)
  console.log(`Tổng ảnh .webp local: ${files.length}`)
  console.log(`Cần upload: ${total} | Bỏ qua: ${localSkip} (đã có trên Supabase hoặc progress local)`)
  console.log(`Concurrency: ${opts.concurrency} | Delay: ${opts.delayMs}ms`)
  if (opts.dryRun) {
    console.log('\n[DRY RUN] 10 file đầu:')
    queue.slice(0, 10).forEach((q) => console.log(`  ${q.storagePath}`))
    return
  }

  if (total === 0) {
    console.log('Không còn file nào cần upload.')
    return
  }

  let done = 0
  let lastSave = Date.now()
  const started = Date.now()

  await runPool(queue, opts.concurrency, async (job) => {
    const { absFile, storagePath } = job
    try {
      const bytes = await uploadOne(supabase, bucket, absFile, storagePath, true)
      progress.uploaded[storagePath] = {
        at: new Date().toISOString(),
        bytes,
        url: publicUrl(supabaseUrl, bucket, storagePath),
      }
      progress.stats.ok++
      progress.stats.bytes += bytes
    } catch (err) {
      progress.stats.fail++
      appendFailure({
        at: new Date().toISOString(),
        absFile,
        storagePath,
        error: err?.message || String(err),
      })
    }

    done++
    if (done % opts.batchPauseEvery === 0 && opts.batchPauseMs > 0) {
      await sleep(opts.batchPauseMs)
    }
    if (opts.delayMs > 0) await sleep(opts.delayMs)

    if (done % 25 === 0 || Date.now() - lastSave > 5000) {
      saveProgress(progress)
      lastSave = Date.now()
    }

    const elapsed = (Date.now() - started) / 1000
    const rate = done / Math.max(elapsed, 1)
    const eta = (total - done) / Math.max(rate, 0.01)
    process.stdout.write(
      `\r[${done}/${total}] OK:${progress.stats.ok} Fail:${progress.stats.fail} | ${rate.toFixed(1)}/s | ETA:${Math.ceil(eta)}s   `
    )
  })

  saveProgress(progress)
  console.log('\n\nXong.')
  console.log(`Public URL mẫu: ${publicUrl(supabaseUrl, bucket, queue[0]?.storagePath || 'anchor.webp')}`)
  console.log('\nBase URL ảnh item trên Supabase:')
  console.log(`  ${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/`)
  if (progress.stats.fail > 0) {
    console.log(`\nCó ${progress.stats.fail} file lỗi → xem ${FAILURES_FILE}`)
    console.log('Chạy lại: node upload.mjs --retry-failed')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
