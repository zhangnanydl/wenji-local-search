const { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, clipboard, globalShortcut, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const fsSync = require('fs')
const { spawn } = require('child_process')
const JSZip = require('jszip')
const XLSX = require('xlsx')
const iconv = require('iconv-lite')

const WORD_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot', '.rtf', '.wps', '.wpt'])
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm', '.xls', '.xlt', '.et', '.ett'])
const PPT_EXTENSIONS = new Set(['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm', '.ppt', '.pps', '.pot', '.dps', '.dpt'])
const CODE_EXTENSIONS = new Set([
  '.py', '.pyw', '.java', '.kt', '.kts', '.groovy', '.gradle', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.cs', '.go', '.rs', '.swift', '.dart', '.php', '.rb', '.lua', '.r',
  '.scala', '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1', '.sql', '.html', '.htm', '.css', '.scss', '.sass',
  '.less', '.xml', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env', '.asm', '.s', '.dockerfile'
])
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.log', '.text', '.rst', '.adoc', '.tex', '.csv', '.tsv', '.lrc'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif', '.tif', '.tiff', '.heic'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.wma', '.opus'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.mpeg', '.mpg', '.ts'])
const SPECIAL_TEXT_FILES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.env', '.npmrc', '.yarnrc', 'dockerfile', 'makefile', 'cmakelists.txt', 'license', 'readme'])
const WPS_EXTENSIONS = new Set(['.wps', '.wpt', '.et', '.ett', '.dps', '.dpt'])
const MEDIA_TYPES = new Set(['image', 'audio', 'video'])
const SUPPORTED = new Set([...WORD_EXTENSIONS, ...EXCEL_EXTENSIONS, ...PPT_EXTENSIONS, ...CODE_EXTENSIONS, ...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])
const TYPE_MAP = Object.fromEntries([
  ...[...WORD_EXTENSIONS].map(ext => [ext, 'word']), ...[...EXCEL_EXTENSIONS].map(ext => [ext, 'excel']), ...[...PPT_EXTENSIONS].map(ext => [ext, 'ppt']),
  ...[...CODE_EXTENSIONS].map(ext => [ext, 'code']), ...[...TEXT_EXTENSIONS].map(ext => [ext, ext === '.md' || ext === '.markdown' ? 'md' : 'txt']),
  ...[...IMAGE_EXTENSIONS].map(ext => [ext, 'image']), ...[...AUDIO_EXTENSIONS].map(ext => [ext, 'audio']), ...[...VIDEO_EXTENSIONS].map(ext => [ext, 'video'])
])
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv'])
const MAX_TEXT_BYTES = 32 * 1024 * 1024
const INDEX_VERSION = 5
let mainWindow
let tray
let isQuitting = false
let state = { roots: [], documents: [], files: [], indexedAt: null, indexing: false, autoIndexing: false, errors: [] }
let needsRebuild = false
let watchers = []
let incrementalTimer = null
const pendingChanges = new Set()
let shortcutRegistered = false

const customUserDataDir = process.env.WENJI_USER_DATA_DIR || process.env.XUNWEN_USER_DATA_DIR
if (customUserDataDir) {
  fsSync.mkdirSync(customUserDataDir, { recursive: true })
  app.setPath('userData', customUserDataDir)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else app.on('second-instance', showMainWindow)

const cachePath = () => path.join(app.getPath('userData'), 'wenji-index.json')
const settingsPath = () => path.join(app.getPath('userData'), 'wenji-settings.json')
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const xmlText = (xml, tagPattern) => [...xml.matchAll(tagPattern)].map(m => decodeXml(m[1])).join('')
const compact = (s) => s.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

async function loadState() {
  try { state.roots = JSON.parse(await fs.readFile(settingsPath(), 'utf8')).roots || [] } catch {}
  try {
    const cached = JSON.parse(await fs.readFile(cachePath(), 'utf8'))
    if (cached.version === INDEX_VERSION) {
      state.documents = cached.documents || []
      state.files = cached.files || []
      state.indexedAt = cached.indexedAt || null
    } else needsRebuild = true
  } catch { if (state.roots.length) needsRebuild = true }
}

async function migrateLegacyData() {
  if (customUserDataDir) return
  const current = app.getPath('userData')
  const legacyDirs = [path.join(app.getPath('appData'), 'xunwen-local-search'), path.join(app.getPath('appData'), '寻文')]
  const files = [['xunwen-settings.json', settingsPath()], ['xunwen-index.json', cachePath()]]
  await fs.mkdir(current, { recursive: true })
  for (const [legacyName, destination] of files) {
    if (fsSync.existsSync(destination)) continue
    for (const legacyDir of legacyDirs) {
      const source = path.join(legacyDir, legacyName)
      if (!fsSync.existsSync(source)) continue
      try { await fs.copyFile(source, destination); break } catch {}
    }
  }
}

async function persist() {
  await fs.mkdir(path.dirname(cachePath()), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify({ roots: state.roots }, null, 2))
  await fs.writeFile(cachePath(), JSON.stringify({ version: INDEX_VERSION, documents: state.documents, files: state.files, indexedAt: state.indexedAt }))
}

async function walk(dir, output = []) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return output }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase())) await walk(full, output)
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    if (SUPPORTED.has(ext) || SPECIAL_TEXT_FILES.has(entry.name.toLowerCase())) output.push(full)
  }
  return output
}

function isSupported(filePath) {
  const name = path.basename(filePath).toLowerCase(); const ext = path.extname(name).toLowerCase()
  return SUPPORTED.has(ext) || SPECIAL_TEXT_FILES.has(name)
}

function fileType(filePath) {
  const name = path.basename(filePath).toLowerCase(); const ext = path.extname(name).toLowerCase()
  if (SPECIAL_TEXT_FILES.has(name) && !TYPE_MAP[ext]) return 'code'
  return TYPE_MAP[ext] || 'txt'
}

function decodeTextBuffer(buffer) {
  if (buffer.length > MAX_TEXT_BYTES) throw new Error(`文本文件超过 ${MAX_TEXT_BYTES / 1024 / 1024}MB 限制`)
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8')
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer.subarray(2), 'utf16-le')
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return iconv.decode(buffer.subarray(2), 'utf16-be')
  const utf8 = buffer.toString('utf8'); const replacements = (utf8.match(/\ufffd/g) || []).length
  if (!replacements || replacements / Math.max(utf8.length, 1) < 0.002) return utf8
  return iconv.decode(buffer, 'gb18030')
}

function chunkLines(text, size = 24, overlap = 4) {
  const lines = text.split(/\r?\n/)
  const chunks = []
  for (let start = 0; start < lines.length; start += size - overlap) {
    const content = compact(lines.slice(start, start + size).join('\n'))
    if (content) chunks.push({ content, location: { kind: 'line', label: `第 ${start + 1} 行`, line: start + 1 } })
  }
  return chunks
}

async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) return []
  const pages = xml.split(/<w:lastRenderedPageBreak\b[^>]*\/>|<w:br\b[^>]*w:type=["']page["'][^>]*\/>/)
  return pages.map((page, index) => {
    const paras = [...page.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(m => xmlText(m[1], /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)).filter(Boolean)
    return { content: compact(paras.join('\n')), location: { kind: 'page', label: `第 ${index + 1} 页`, page: index + 1 } }
  }).filter(x => x.content)
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const output = []
  for (const name of slides) {
    const number = Number(name.match(/slide(\d+)/)[1])
    const xml = await zip.file(name).async('string')
    const runs = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => decodeXml(m[1]))
    const content = compact(runs.join('\n'))
    if (content) output.push({ content, location: { kind: 'slide', label: `第 ${number} 张幻灯片`, slide: number } })
  }
  return output
}

function extractWorkbook(book) {
  const chunks = []
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName]
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
    for (let r = range.s.r; r <= range.e.r; r += 30) {
      const lines = []
      for (let row = r; row <= Math.min(r + 29, range.e.r); row++) {
        const values = []
        for (let col = range.s.c; col <= range.e.c; col++) {
          const address = XLSX.utils.encode_cell({ r: row, c: col })
          const cell = sheet[address]
          if (cell?.v !== undefined) values.push(`${address}: ${cell.w ?? cell.v}`)
        }
        if (values.length) lines.push(values.join('  '))
      }
      const content = compact(lines.join('\n'))
      if (content) chunks.push({ content, location: { kind: 'sheet', label: `${sheetName} · 第 ${r + 1}-${Math.min(r + 30, range.e.r + 1)} 行`, sheet: sheetName, cell: `A${r + 1}` } })
    }
  }
  return chunks
}

function extractSheetBuffer(buffer) { return extractWorkbook(XLSX.read(buffer, { type: 'buffer', cellDates: true })) }

function runPowerShellCapture(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []; const stderr = []; let settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    child.stdout.on('data', data => stdout.push(data)); child.stderr.on('data', data => stderr.push(data))
    child.once('error', error => finish(error))
    child.once('close', code => code === 0 ? finish(null, Buffer.concat(stdout).toString('utf8').trim()) : finish(new Error(Buffer.concat(stderr).toString('utf8').trim() || `PowerShell 退出码 ${code}`)))
    const timer = setTimeout(() => { child.kill(); finish(new Error('WPS/Office 内容提取超时')) }, timeoutMs)
  })
}

function decodePowerShellBase64(output) {
  const encoded = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  if (!encoded) return ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

async function extractLegacyOffice(filePath, type) {
  const file = psQuote(filePath)
  if (type === 'word') {
    const output = await runPowerShellCapture(`$ErrorActionPreference='Stop';$app=$null;$doc=$null;try{foreach($id in @('kwps.application','Word.Application')){try{$app=New-Object -ComObject $id;break}catch{}};if($null -eq $app){throw 'WPS/Word 未安装'};$app.Visible=$false;$doc=$app.Documents.Open(${file});$text=[string]$doc.Content.Text;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))}finally{if($null -ne $doc){$doc.Close($false)};if($null -ne $app){$app.Quit()}}`)
    const content = compact(decodePowerShellBase64(output))
    return content ? [{ content, location: { kind: 'document', label: '文档内容' } }] : []
  }
  if (type === 'excel') {
    const output = await runPowerShellCapture(`$ErrorActionPreference='Stop';$app=$null;$book=$null;try{foreach($id in @('ket.application','Excel.Application')){try{$app=New-Object -ComObject $id;break}catch{}};if($null -eq $app){throw 'WPS表格/Excel 未安装'};$app.Visible=$false;$book=$app.Workbooks.Open(${file});$data=@();foreach($sheet in $book.Worksheets){$used=$sheet.UsedRange;$lines=@();for($r=1;$r -le $used.Rows.Count;$r++){$cells=@();for($c=1;$c -le $used.Columns.Count;$c++){$cell=$used.Cells.Item($r,$c);$value=[string]$cell.Text;if($value){$cells+=([string]$cell.Address($false,$false)+': '+$value)}};if($cells.Count){$lines+=($cells -join '  ')}};$data+=[pscustomobject]@{name=[string]$sheet.Name;text=($lines -join [Environment]::NewLine)}};$json=$data|ConvertTo-Json -Compress -Depth 3;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))}finally{if($null -ne $book){$book.Close($false)};if($null -ne $app){$app.Quit()}}`, 60000)
    const sheets = JSON.parse(decodePowerShellBase64(output) || '[]')
    return (Array.isArray(sheets) ? sheets : [sheets]).filter(sheet => sheet.text).map(sheet => ({ content: compact(sheet.text), location: { kind: 'sheet', label: `${sheet.name} · 工作表`, sheet: sheet.name, cell: 'A1' } }))
  }
  const output = await runPowerShellCapture(`$ErrorActionPreference='Stop';$app=$null;$deck=$null;try{foreach($id in @('kwpp.application','PowerPoint.Application')){try{$app=New-Object -ComObject $id;break}catch{}};if($null -eq $app){throw 'WPS演示/PowerPoint 未安装'};$app.Visible=$true;$deck=$app.Presentations.Open(${file});$data=@();foreach($slide in $deck.Slides){$texts=@();foreach($shape in $slide.Shapes){try{if($shape.HasTextFrame -and $shape.TextFrame.HasText){$texts+=[string]$shape.TextFrame.TextRange.Text}}catch{}};$data+=[pscustomobject]@{slide=[int]$slide.SlideIndex;text=($texts -join [Environment]::NewLine)}};$json=$data|ConvertTo-Json -Compress -Depth 3;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))}finally{if($null -ne $deck){$deck.Close()};if($null -ne $app){$app.Quit()}}`, 60000)
  const slides = JSON.parse(decodePowerShellBase64(output) || '[]')
  return (Array.isArray(slides) ? slides : [slides]).filter(slide => slide.text).map(slide => ({ content: compact(slide.text), location: { kind: 'slide', label: `第 ${slide.slide} 张幻灯片`, slide: slide.slide } }))
}

async function extractFile(filePath) {
  const ext = path.extname(filePath).toLowerCase(); const type = fileType(filePath)
  if (MEDIA_TYPES.has(type)) return []
  const buffer = await fs.readFile(filePath)
  if (type === 'code' || type === 'txt' || type === 'md') return chunkLines(decodeTextBuffer(buffer))
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const zip = await JSZip.loadAsync(buffer)
      if (zip.file('word/document.xml')) return extractDocx(buffer)
      if (zip.file('xl/workbook.xml')) return extractSheetBuffer(buffer)
      if (Object.keys(zip.files).some(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))) return extractPptx(buffer)
    } catch {}
  }
  if (type === 'excel') {
    try { return extractSheetBuffer(buffer) } catch {}
  }
  if (ext === '.rtf') {
    const text = decodeTextBuffer(buffer).replace(/\\'[0-9a-f]{2}/gi, ' ').replace(/\\[a-z]+-?\d* ?/gi, ' ').replace(/[{}]/g, '')
    if (compact(text)) return chunkLines(text)
  }
  return extractLegacyOffice(filePath, type)
}

async function buildFileIndex(filePath) {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || !isSupported(filePath)) return null
  const parts = await extractFile(filePath)
  const fileId = `${filePath}|${stat.mtimeMs}`
  const ext = path.extname(filePath).toLowerCase(); const type = fileType(filePath); const name = path.basename(filePath)
  const file = { id: fileId, path: filePath, name, ext, type, size: stat.size, modified: stat.mtime.toISOString(), chunks: parts.length }
  const documents = parts.map((part, index) => ({ id: `${fileId}|${index}`, fileId, path: filePath, name, ext, type, size: stat.size, modified: stat.mtime.toISOString(), content: part.content, location: part.location }))
  return { file, documents }
}

function sendProgress(data) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('index:progress', data) }

async function rebuildIndex() {
  if (state.indexing) return snapshot()
  state.indexing = true; state.errors = []
  const filePaths = []
  for (const root of state.roots) {
    sendProgress({ phase: 'scanning', done: 0, total: 0, current: root })
    await walk(root, filePaths)
  }
  const documents = []; const files = []
  let done = 0
  sendProgress({ phase: 'indexing', done, total: filePaths.length, current: '' })
  for (const filePath of filePaths) {
    try {
      const indexed = await buildFileIndex(filePath)
      if (indexed) { files.push(indexed.file); documents.push(...indexed.documents) }
    } catch (error) { state.errors.push({ path: filePath, message: error.message }) }
    done++
    if (done % 5 === 0 || done === filePaths.length) sendProgress({ phase: 'indexing', done, total: filePaths.length, current: filePath })
  }
  state.documents = documents; state.files = files; state.indexedAt = new Date().toISOString(); state.indexing = false
  await persist(); startWatchers(); sendProgress({ phase: 'done', done, total: filePaths.length })
  return snapshot()
}

function snapshot() {
  const rootStats = state.roots.map(root => ({ root, count: state.files.filter(f => f.path.toLowerCase().startsWith(root.toLowerCase() + path.sep)).length }))
  return { roots: rootStats, fileCount: state.files.length, chunkCount: state.documents.length, indexedAt: state.indexedAt, indexing: state.indexing, autoIndexing: state.autoIndexing, watcherCount: watchers.length, shortcutRegistered, trayReady: Boolean(tray), errorCount: state.errors.length }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data)
}

function removeIndexedPath(targetPath) {
  const normalized = path.resolve(targetPath).toLocaleLowerCase(); const prefix = `${normalized}${path.sep}`
  const removedIds = new Set(state.files.filter(file => {
    const current = path.resolve(file.path).toLocaleLowerCase()
    return current === normalized || current.startsWith(prefix)
  }).map(file => file.id))
  if (!removedIds.size) return 0
  state.files = state.files.filter(file => !removedIds.has(file.id))
  state.documents = state.documents.filter(document => !removedIds.has(document.fileId))
  return removedIds.size
}

async function applyIncrementalChanges() {
  if (!pendingChanges.size) return
  if (state.indexing || state.autoIndexing) { scheduleIncremental(); return }
  const targets = [...pendingChanges]; pendingChanges.clear(); state.autoIndexing = true
  let changed = 0; let removed = 0; let shouldNotify = false
  try {
    const candidates = new Set()
    for (const target of targets) {
      let stat
      try { stat = await fs.stat(target) } catch {}
      if (!stat) { removed += removeIndexedPath(target); continue }
      if (stat.isDirectory()) {
        const nested = await walk(target, [])
        nested.forEach(filePath => candidates.add(filePath))
      } else if (isSupported(target)) candidates.add(target)
      else removed += removeIndexedPath(target)
    }
    for (const filePath of candidates) {
      const previous = state.files.find(file => file.path.toLocaleLowerCase() === filePath.toLocaleLowerCase())
      try {
        const indexed = await buildFileIndex(filePath)
        if (!indexed || previous?.id === indexed.file.id) continue
        if (previous) removeIndexedPath(filePath)
        state.files.push(indexed.file); state.documents.push(...indexed.documents); changed++
        state.errors = state.errors.filter(error => error.path.toLocaleLowerCase() !== filePath.toLocaleLowerCase())
      } catch (error) {
        if (previous) removed += removeIndexedPath(filePath)
        state.errors = state.errors.filter(item => item.path.toLocaleLowerCase() !== filePath.toLocaleLowerCase())
        state.errors.push({ path: filePath, message: error.message })
      }
    }
    if (changed || removed) {
      state.indexedAt = new Date().toISOString(); await persist()
      shouldNotify = true
    }
  } finally {
    state.autoIndexing = false
    if (pendingChanges.size) scheduleIncremental()
  }
  if (shouldNotify) sendToRenderer('index:changed', { changed, removed, state: snapshot() })
}

function scheduleIncremental(targetPath) {
  if (targetPath) pendingChanges.add(targetPath)
  clearTimeout(incrementalTimer)
  incrementalTimer = setTimeout(() => applyIncrementalChanges().catch(error => sendToRenderer('index:error', { message: error.message })), 700)
}

function stopWatchers() {
  watchers.forEach(watcher => { try { watcher.close() } catch {} })
  watchers = []
}

function startWatchers() {
  stopWatchers()
  for (const root of state.roots) {
    if (!fsSync.existsSync(root)) continue
    try {
      const watcher = fsSync.watch(root, { recursive: process.platform === 'win32' }, (_event, filename) => {
        if (!filename || state.indexing) return
        const target = path.resolve(root, String(filename))
        const rootPath = path.resolve(root); const lower = target.toLocaleLowerCase(); const rootLower = rootPath.toLocaleLowerCase()
        if (lower === rootLower || lower.startsWith(`${rootLower}${path.sep}`)) scheduleIncremental(target)
      })
      watcher.on('error', error => sendToRenderer('index:error', { message: `自动索引监听失败：${error.message}` }))
      watchers.push(watcher)
    } catch (error) { sendToRenderer('index:error', { message: `无法监听 ${root}：${error.message}` }) }
  }
}

function makeSnippet(content, terms) {
  const source = content.replace(/\s+/g, ' ').trim(); const lower = source.toLocaleLowerCase()
  const hits = terms.map(term => ({ term, at: lower.indexOf(term) })).filter(hit => hit.at >= 0).sort((a, b) => a.at - b.at)
  if (!hits.length) return source.slice(0, 220)
  const { at, term } = hits[0]
  const start = Math.max(0, at - 85); const end = Math.min(source.length, at + term.length + 135)
  return `${start ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`
}

function parseSearchQuery(query) {
  const tokens = []; const matcher = /(-?)(?:(name|content|ext|type):)?(?:"([^"]+)"|(\S+))/gi
  let match
  while ((match = matcher.exec(query)) !== null) {
    const value = (match[3] || match[4] || '').trim().toLocaleLowerCase()
    if (value) tokens.push({ scope: match[2]?.toLocaleLowerCase() || 'any', value, exclude: match[1] === '-' })
  }
  return tokens
}

function matchesTypeFilter(document, type) {
  if (!type || type === 'all') return true
  if (type === 'office') return document.type === 'word' || document.type === 'excel' || document.type === 'ppt'
  if (type === 'wps') return WPS_EXTENSIONS.has(document.ext)
  if (type === 'text') return document.type === 'txt' || document.type === 'md'
  if (type === 'media') return MEDIA_TYPES.has(document.type)
  return document.type === type
}

function tokenMatches(token, document, name, content) {
  if (token.scope === 'name') return name.includes(token.value)
  if (token.scope === 'content') return content.includes(token.value)
  if (token.scope === 'ext') return document.ext.replace(/^\./, '') === token.value.replace(/^\./, '')
  if (token.scope === 'type') return matchesTypeFilter(document, token.value)
  return name.includes(token.value) || content.includes(token.value)
}

function matchesDateFilter(document, dateRange) {
  if (!dateRange || dateRange === 'all') return true
  const modified = new Date(document.modified).getTime(); const now = Date.now(); const day = 24 * 60 * 60 * 1000
  const ranges = { today: day, week: 7 * day, month: 30 * day }
  return modified >= now - (ranges[dateRange] || Number.MAX_SAFE_INTEGER)
}

function searchDocuments(query, filters = {}) {
  const started = performance.now(); const q = query.trim()
  if (!q) return { results: [], elapsed: 0, total: 0, syntax: { terms: [] } }
  const tokens = parseSearchQuery(q); const positive = tokens.filter(token => !token.exclude); const negative = tokens.filter(token => token.exclude)
  const highlightTerms = [...new Set(positive.filter(token => token.scope === 'any' || token.scope === 'name' || token.scope === 'content').map(token => token.value))]
  const matchesFilters = document => matchesTypeFilter(document, filters.type) && matchesDateFilter(document, filters.dateRange)
  const countHits = (text, term) => {
    let count = 0; let position = 0
    while ((position = text.indexOf(term, position)) >= 0) { count++; position += Math.max(term.length, 1) }
    return count
  }
  const ranked = state.documents.filter(matchesFilters).map(document => {
    const name = document.name.toLocaleLowerCase(); const content = document.content.toLocaleLowerCase()
    if (!positive.every(token => tokenMatches(token, document, name, content)) || negative.some(token => tokenMatches(token, document, name, content))) return null
    const nameTokens = positive.filter(token => token.scope === 'any' || token.scope === 'name')
    const contentTokens = positive.filter(token => token.scope === 'any' || token.scope === 'content')
    const nameMatchesAll = !contentTokens.some(token => token.scope === 'content') && nameTokens.every(token => name.includes(token.value))
    const nameMatched = nameTokens.some(token => name.includes(token.value)); const contentMatched = contentTokens.some(token => content.includes(token.value))
    if (filters.source === 'name' && !nameMatched) return null
    if (filters.source === 'content' && !contentMatched) return null
    let score = nameMatchesAll ? 100 : 0
    highlightTerms.forEach(term => { score += countHits(name, term) * 12 + countHits(content, term) })
    return {
      ...document,
      location: contentMatched ? document.location : { kind: 'filename', label: '文件名匹配' },
      nameMatched,
      contentMatched,
      nameMatchesAll,
      score,
      snippet: contentMatched ? makeSnippet(document.content, highlightTerms) : '关键词命中文件名，可在右侧查看文件信息。',
      query,
      highlightTerms
    }
  }).filter(Boolean)

  const results = []; const filenameFiles = new Set()
  for (const result of ranked) {
    if (result.nameMatchesAll) {
      if (filenameFiles.has(result.fileId)) continue
      filenameFiles.add(result.fileId)
    }
    results.push(result)
  }
  for (const file of state.files.filter(matchesFilters)) {
    const name = file.name.toLocaleLowerCase(); const content = ''
    if (filenameFiles.has(file.id) || !positive.every(token => tokenMatches(token, file, name, content)) || negative.some(token => tokenMatches(token, file, name, content))) continue
    const nameMatched = positive.some(token => (token.scope === 'any' || token.scope === 'name') && name.includes(token.value))
    if (filters.source === 'content' || (filters.source === 'name' && !nameMatched)) continue
    filenameFiles.add(file.id)
    results.push({
      ...file,
      id: `${file.id}|filename`,
      fileId: file.id,
      content: '',
      location: { kind: 'filename', label: '文件名匹配' },
      nameMatched,
      contentMatched: false,
      nameMatchesAll: true,
      score: 100 + highlightTerms.reduce((sum, term) => sum + countHits(name, term) * 12, 0),
      snippet: '关键词命中文件名，该文件暂无可预览的文本内容。',
      query,
      highlightTerms
    })
  }
  const sorters = {
    modified: (a, b) => b.modified.localeCompare(a.modified) || b.score - a.score,
    name: (a, b) => a.name.localeCompare(b.name, 'zh-CN') || b.score - a.score,
    size: (a, b) => (b.size || 0) - (a.size || 0) || b.score - a.score,
    relevance: (a, b) => b.score - a.score || b.modified.localeCompare(a.modified)
  }
  results.sort(sorters[filters.sort] || sorters.relevance)
  const total = results.length
  return { results: results.slice(0, 500), elapsed: Math.max(1, Math.round(performance.now() - started)), total, syntax: { terms: highlightTerms, tokens } }
}

function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'` }
function runPowerShell(script) {
  return new Promise(resolve => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let errorText = ''; let settled = false
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
    child.stderr.on('data', data => { if (errorText.length < 2000) errorText += data.toString() })
    child.once('error', error => finish({ ok: false, message: error.message }))
    child.once('close', code => finish(code === 0 ? { ok: true } : { ok: false, message: errorText.trim() || `PowerShell 退出码 ${code}` }))
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, message: '定位打开超时' }) }, 20000)
  })
}

async function openDefault(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return { ok: false, message: '文件不存在或已被移动' }
  const errorMessage = await shell.openPath(filePath)
  return errorMessage ? { ok: false, message: errorMessage } : { ok: true }
}

async function locateAndOpen(result) {
  const file = psQuote(result.path); const query = psQuote(result.highlightTerms?.[0] || result.query || ''); const preferWps = WPS_EXTENSIONS.has(result.ext)
  if (result.type === 'word') {
    const ids = preferWps ? "@('kwps.application','Word.Application')" : "@('Word.Application','kwps.application')"
    return runPowerShell(`try{$w=$null;foreach($id in ${ids}){try{$w=New-Object -ComObject $id;break}catch{}};if($null -eq $w){throw 'Office 未安装'};$w.Visible=$true;$d=$w.Documents.Open(${file});$r=$d.Content;$f=$r.Find;$f.Text=${query};if($f.Execute()){$r.Select()};$w.Activate()}catch{Start-Process ${file}}`)
  }
  if (result.type === 'excel') {
    const sheet = psQuote(result.location?.sheet || ''); const cell = psQuote(result.location?.cell || 'A1')
    const ids = preferWps ? "@('ket.application','Excel.Application')" : "@('Excel.Application','ket.application')"
    return runPowerShell(`try{$e=$null;foreach($id in ${ids}){try{$e=New-Object -ComObject $id;break}catch{}};if($null -eq $e){throw 'Office 未安装'};$e.Visible=$true;$b=$e.Workbooks.Open(${file});$s=$b.Worksheets.Item(${sheet});$s.Activate();$s.Range(${cell}).Select();$e.ActiveWindow.ScrollRow=$s.Range(${cell}).Row;$e.Activate()}catch{Start-Process ${file}}`)
  }
  if (result.type === 'ppt') {
    const slide = Number(result.location?.slide || 1)
    const ids = preferWps ? "@('kwpp.application','PowerPoint.Application')" : "@('PowerPoint.Application','kwpp.application')"
    return runPowerShell(`try{$p=$null;foreach($id in ${ids}){try{$p=New-Object -ComObject $id;break}catch{}};if($null -eq $p){throw 'Office 未安装'};$p.Visible=$true;$d=$p.Presentations.Open(${file});$p.ActiveWindow.View.GotoSlide(${slide});$p.Activate()}catch{Start-Process ${file}}`)
  }
  if ((result.type === 'txt' || result.type === 'md' || result.type === 'code') && result.location?.line) {
    const line = Number(result.location.line)
    return runPowerShell(`try{Start-Process notepad.exe -ArgumentList @('/g','${line},1',${file})}catch{Start-Process ${file}}`)
  }
  return openDefault(result.path)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus(); sendToRenderer('search:focus')
}

function createTray() {
  if (tray) return
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 })
  tray = new Tray(icon)
  tray.setToolTip('文迹 · 本地文件搜索')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开文迹', click: showMainWindow },
    { label: '聚焦搜索  Ctrl+Alt+Space', click: showMainWindow },
    { type: 'separator' },
    { label: '重新索引', click: () => rebuildIndex().catch(() => {}) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

function showResultContextMenu(event, result) {
  if (!result?.path) return
  const window = BrowserWindow.fromWebContents(event.sender)
  Menu.buildFromTemplate([
    { label: '打开文件', click: () => openDefault(result.path) },
    { label: '定位打开', click: () => locateAndOpen(result) },
    { type: 'separator' },
    { label: '复制文件路径', click: () => { clipboard.writeText(result.path); sendToRenderer('action:notice', { message: '已复制文件路径' }) } },
    { label: '复制文件名', click: () => { clipboard.writeText(result.name || path.basename(result.path)); sendToRenderer('action:notice', { message: '已复制文件名' }) } },
    { type: 'separator' },
    { label: '在文件夹中显示', click: () => shell.showItemInFolder(result.path) }
  ]).popup({ window })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1080, minHeight: 680, backgroundColor: '#f7f9fc',
    title: '文迹', autoHideMenuBar: true, icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else if (fsSync.existsSync(path.join(__dirname, '..', 'dist', 'index.html'))) mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  else mainWindow.loadURL('http://127.0.0.1:5173')
  mainWindow.on('close', event => { if (!isQuitting) { event.preventDefault(); mainWindow.hide() } })
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  await migrateLegacyData()
  await loadState()
  createWindow()
  createTray()
  shortcutRegistered = globalShortcut.register('CommandOrControl+Alt+Space', showMainWindow)
  startWatchers()
  ipcMain.handle('state:get', () => snapshot())
  ipcMain.handle('folder:add', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择要搜索的文件夹' })
    if (!result.canceled && result.filePaths[0] && !state.roots.includes(result.filePaths[0])) { state.roots.push(result.filePaths[0]); await persist(); await rebuildIndex() }
    return snapshot()
  })
  ipcMain.handle('folder:remove', async (_e, folder) => { state.roots = state.roots.filter(r => r !== folder); await persist(); return rebuildIndex() })
  ipcMain.handle('index:rebuild', rebuildIndex)
  ipcMain.handle('search', (_e, { query, filters }) => searchDocuments(query, filters))
  ipcMain.handle('file:open', async (_e, { result, locate }) => {
    try {
      if (!result?.path || !fsSync.existsSync(result.path)) return { ok: false, message: '文件不存在或已被移动，请重新索引' }
      if (!locate) return openDefault(result.path)
      const located = await locateAndOpen(result)
      if (located?.ok !== false) return { ok: true, located: true }
      const fallback = await openDefault(result.path)
      return fallback.ok ? { ok: true, located: false, message: '定位失败，已改为普通打开' } : fallback
    } catch (error) {
      const fallback = await openDefault(result?.path)
      return fallback.ok ? { ok: true, located: false, message: '定位失败，已改为普通打开' } : { ok: false, message: error.message || fallback.message }
    }
  })
  ipcMain.handle('file:reveal', (_e, filePath) => {
    if (!filePath || !fsSync.existsSync(filePath)) return { ok: false, message: '文件不存在或已被移动' }
    shell.showItemInFolder(filePath)
    return { ok: true }
  })
  ipcMain.handle('file:copy-path', (_e, filePath) => {
    if (!filePath) return { ok: false, message: '没有可复制的文件路径' }
    clipboard.writeText(filePath); return { ok: true }
  })
  ipcMain.on('result:context-menu', showResultContextMenu)
  if (needsRebuild && state.roots.length) setTimeout(() => rebuildIndex(), 800)
})

app.on('activate', showMainWindow)
app.on('before-quit', () => { isQuitting = true; clearTimeout(incrementalTimer); stopWatchers(); globalShortcut.unregisterAll() })
app.on('window-all-closed', () => {})
