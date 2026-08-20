import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, FolderPlus, Folder, FileText, FileSpreadsheet, Presentation, FileType2, RefreshCw, ExternalLink, MapPin, Trash2, CircleAlert, X, Keyboard, PanelRightClose, PanelRightOpen, CheckCircle2, LoaderCircle, Code2, Copy, CircleHelp, Radio, ChevronDown } from 'lucide-react'

const types = [
  { key: 'all', label: '全部' }, { key: 'office', label: '办公文档' }, { key: 'wps', label: 'WPS' },
  { key: 'code', label: '代码文件' }, { key: 'text', label: '文本文件' }
]
const typeMeta = {
  word: { label: 'W', color: '#1769d1', Icon: FileText }, excel: { label: 'X', color: '#16854b', Icon: FileSpreadsheet },
  ppt: { label: 'P', color: '#d9572b', Icon: Presentation }, txt: { label: 'T', color: '#667085', Icon: FileType2 }, md: { label: 'M↓', color: '#262b33', Icon: FileText },
  code: { label: '<>', color: '#6e56cf', Icon: Code2 }
}
const wpsExtensions = new Set(['.wps', '.wpt', '.et', '.ett', '.dps', '.dpt'])
const emptyState = { roots: [], fileCount: 0, chunkCount: 0, indexedAt: null, indexing: false, autoIndexing: false, watcherCount: 0, shortcutRegistered: false, errorCount: 0 }
const sourceOptions = [{ key: 'all', label: '文件名与内容' }, { key: 'name', label: '仅文件名' }, { key: 'content', label: '仅文件内容' }]
const dateOptions = [{ key: 'all', label: '不限时间' }, { key: 'today', label: '最近一天' }, { key: 'week', label: '最近一周' }, { key: 'month', label: '最近一月' }]
const sortOptions = [{ key: 'relevance', label: '相关度排序' }, { key: 'modified', label: '最近修改' }, { key: 'name', label: '文件名排序' }, { key: 'size', label: '文件大小' }]

function highlight(text = '', queryOrTerms = '') {
  const terms = Array.isArray(queryOrTerms) ? queryOrTerms : queryOrTerms.trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return text
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const matcher = new RegExp(`(${escaped.join('|')})`, 'ig')
  const normalized = new Set(terms.map(term => term.toLocaleLowerCase()))
  return text.split(matcher).map((part, i) => normalized.has(part.toLocaleLowerCase()) ? <mark key={i}>{part}</mark> : part)
}
function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value); return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d)
}
function shortPath(value) { return value.length > 58 ? `…${value.slice(-57)}` : value }
function formatSize(bytes = 0) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }

function FileIcon({ type, ext = '', large = false }) {
  const meta = typeMeta[type] || typeMeta.txt; const Icon = meta.Icon
  const extensionLabel = ext.replace('.', '').toUpperCase()
  const label = wpsExtensions.has(ext) ? 'WPS' : type === 'code' && extensionLabel ? extensionLabel.slice(0, 4) : meta.label
  return <div className={`file-icon ${large ? 'large' : ''}`} style={{ '--file-color': meta.color }}><Icon size={large ? 27 : 21} strokeWidth={1.8}/><span>{label}</span></div>
}

function Sidebar({ state, progress, onAdd, onRemove, onRebuild }) {
  const indexing = state.indexing || progress.phase === 'scanning' || progress.phase === 'indexing'
  return <aside className="sidebar">
    <div className="sidebar-head"><h2>搜索范围</h2><button className="icon-button" onClick={onAdd} disabled={indexing} title="添加文件夹"><FolderPlus size={19}/></button></div>
    <div className="roots">
      {state.roots.map(item => <div className="root-row" key={item.root} title={item.root}>
        <Folder size={19}/><div className="root-copy"><strong>{item.root.split(/[\\/]/).filter(Boolean).at(-1)}</strong><span>{shortPath(item.root)}</span><small>已索引 {item.count.toLocaleString()} 个文件</small></div>
        <span className="status-dot"/><button className="remove-root" onClick={() => onRemove(item.root)} title="移除"><Trash2 size={15}/></button>
      </div>)}
      {!state.roots.length && <div className="root-empty"><FolderPlus size={28}/><p>尚未添加搜索目录</p><span>文件只在本机解析和索引</span></div>}
    </div>
    <button className="add-folder" onClick={onAdd} disabled={indexing}><FolderPlus size={18}/><span>{indexing ? '正在建立索引' : '添加文件夹'}</span></button>
    <div className="index-box">
      <div className="index-title"><strong>索引状态</strong><span className={indexing || state.autoIndexing ? 'working' : ''}><i/>{indexing ? (progress.phase === 'scanning' ? '扫描中' : '索引中') : state.autoIndexing ? '增量更新中' : state.watcherCount ? '实时监听' : '就绪'}</span></div>
      {indexing && <div className={`progress ${progress.total ? '' : 'indeterminate'}`}><div style={{ width: progress.total ? `${progress.done / progress.total * 100}%` : '34%' }}/></div>}
      <dl><div><dt>已索引文件</dt><dd>{state.fileCount.toLocaleString()} 个</dd></div><div><dt>可搜索片段</dt><dd>{state.chunkCount.toLocaleString()} 个</dd></div><div><dt>上次更新</dt><dd>{state.indexedAt ? formatDate(state.indexedAt) : '尚未索引'}</dd></div></dl>
      {state.errorCount > 0 && <div className="error-count"><CircleAlert size={14}/>{state.errorCount} 个文件未能解析</div>}
      <div className="shortcut-tip"><Radio size={13}/>{state.shortcutRegistered ? 'Ctrl + Alt + Space 快速唤起' : '全局快捷键暂不可用'}</div>
      <button className="rebuild" onClick={onRebuild} disabled={indexing || !state.roots.length}><RefreshCw size={16} className={indexing ? 'spin' : ''}/>{indexing ? (progress.total ? `${progress.done} / ${progress.total}` : '正在扫描') : '重新索引'}</button>
    </div>
  </aside>
}

function ResultRow({ result, selected, onSelect, onOpen, onContextMenu }) {
  return <button className={`result-row ${selected ? 'selected' : ''}`} onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onContextMenu}>
    <FileIcon type={result.type} ext={result.ext}/><div className="result-body"><div className="result-top"><strong>{highlight(result.name, result.highlightTerms || result.query)}</strong><time>{formatDate(result.modified)}</time></div><div className="path">{result.path}</div><div className={`snippet ${result.type === 'code' ? 'code-content' : ''}`}>{highlight(result.snippet, result.highlightTerms || result.query)}</div><div className="location">{result.nameMatched && <span className="match-source">文件名</span>}{result.contentMatched && <><MapPin size={13}/><span>{result.location?.label}</span></>}<span className="file-size">{formatSize(result.size)}</span></div></div>
  </button>
}

function DetailPane({ result, onClose, onOpen, onReveal, onCopy, opening }) {
  if (!result) return <aside className="detail empty-detail"><div><PanelRightOpen size={34}/><p>选择一条结果查看命中位置</p><span>双击结果可直接打开文件</span></div></aside>
  return <aside className="detail">
    <div className="detail-header"><FileIcon type={result.type} ext={result.ext} large/><div><h2>{highlight(result.name, result.highlightTerms || result.query)}</h2><p title={result.path}>{result.path}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭详情"><X size={18}/></button></div>
    <div className="detail-meta"><MapPin size={16}/><span>{result.contentMatched ? '命中位置' : '匹配来源'}</span><strong>{result.location?.label || '文件内'}</strong></div>
    <div className="preview-label">内容预览</div>
    <div className={`preview ${result.type === 'code' ? 'code-content' : ''} ${!result.content ? 'empty-preview' : ''}`}>{result.content ? result.content.split('\n').map((line, i) => <p key={i}>{highlight(line, result.highlightTerms || result.query)}</p>) : <div><FileText size={28}/><strong>文件名匹配</strong><span>该文件没有可预览的文本内容，可直接打开或在文件夹中查看。</span></div>}</div>
    <div className="detail-actions">
      <button className="primary" onClick={() => onOpen(false)} disabled={Boolean(opening)}>{opening === 'open' ? <LoaderCircle size={17} className="spin"/> : <ExternalLink size={17}/>}<span>{opening === 'open' ? '正在打开' : '打开文件'}</span></button>
      <button className="secondary" onClick={() => onOpen(true)} disabled={Boolean(opening)}>{opening === 'locate' ? <LoaderCircle size={17} className="spin"/> : <MapPin size={17}/>}<span>{opening === 'locate' ? '正在定位' : '定位打开'}</span></button>
      <div className="detail-links"><button onClick={() => onCopy(result.path)} disabled={Boolean(opening)}><Copy size={14}/>复制路径</button><button onClick={() => onReveal(result.path)} disabled={Boolean(opening)}><Folder size={14}/>在文件夹中显示</button></div>
    </div>
  </aside>
}

function IndexProgressDialog({ progress, onBackground }) {
  const scanning = progress.phase === 'scanning'
  const percent = progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) : null
  const currentName = progress.current?.split(/[\\/]/).filter(Boolean).at(-1) || ''
  return <div className="modal-backdrop" role="presentation">
    <section className="index-dialog" role="dialog" aria-modal="true" aria-labelledby="index-dialog-title">
      <div className="index-dialog-icon"><LoaderCircle size={24} className="spin"/></div>
      <div className="index-dialog-copy"><h2 id="index-dialog-title">{scanning ? '正在扫描文件夹' : '正在建立内容索引'}</h2><p>{scanning ? '正在查找办公文档、WPS、代码和文本文件…' : `已处理 ${progress.done} / ${progress.total} 个文件`}</p></div>
      <div className={`dialog-progress ${percent === null ? 'indeterminate' : ''}`}><div style={{ width: percent === null ? '34%' : `${percent}%` }}/></div>
      <div className="dialog-progress-meta"><span title={progress.current}>{currentName || '准备中…'}</span><strong>{percent === null ? '扫描中' : `${percent}%`}</strong></div>
      <div className="dialog-tip">索引仅保存在本机，不会上传文件内容。</div>
      <button className="background-button" onClick={onBackground}>转到后台</button>
    </section>
  </div>
}

function Toast({ toast, onClose }) {
  if (!toast) return null
  const Icon = toast.type === 'success' ? CheckCircle2 : CircleAlert
  return <div className={`toast ${toast.type}`} role="status"><Icon size={18}/><span>{toast.message}</span><button onClick={onClose} aria-label="关闭提示"><X size={15}/></button></div>
}

function SyntaxHelp() {
  return <details className="syntax-help"><summary><CircleHelp size={14}/>搜索语法<ChevronDown size={13}/></summary><div className="syntax-card"><strong>组合搜索示例</strong><code>"设备检修" -作废</code><code>name:报告 ext:docx</code><code>content:报警 type:office</code><p>双引号表示精确短语，减号排除关键词；支持 name、content、ext、type。</p></div></details>
}

export default function App() {
  const [appState, setAppState] = useState(emptyState); const [query, setQuery] = useState(''); const [type, setType] = useState('all')
  const [source, setSource] = useState('all'); const [dateRange, setDateRange] = useState('all'); const [sort, setSort] = useState('relevance')
  const [searchData, setSearchData] = useState({ results: [], elapsed: 0, total: 0 }); const [selectedId, setSelectedId] = useState(null)
  const [progress, setProgress] = useState({ phase: 'idle', done: 0, total: 0, current: '' }); const [searched, setSearched] = useState(false); const [searching, setSearching] = useState(false); const [detailOpen, setDetailOpen] = useState(true)
  const [opening, setOpening] = useState(null); const [toast, setToast] = useState(null); const [showIndexDialog, setShowIndexDialog] = useState(false)
  const inputRef = useRef(null); const progressHiddenRef = useRef(false); const searchRequestRef = useRef(0)
  const resultMap = useMemo(() => new Map(searchData.results.map(result => [result.id, result])), [searchData.results])
  const selected = resultMap.get(selectedId) || null
  const refreshState = useCallback(async () => setAppState(await window.wenji.getState()), [])
  const notify = useCallback((message, type = 'success') => setToast({ message, type, id: Date.now() }), [])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 3600); return () => clearTimeout(id) }, [toast])
  useEffect(() => { refreshState(); return window.wenji.onIndexProgress(async value => {
    setProgress(value)
    const active = value.phase === 'scanning' || value.phase === 'indexing'
    setAppState(current => ({ ...current, indexing: active }))
    if (value.phase === 'scanning') { progressHiddenRef.current = false; setShowIndexDialog(true) }
    else if (value.phase === 'indexing' && !progressHiddenRef.current) setShowIndexDialog(true)
    else if (value.phase === 'done') { setShowIndexDialog(false); const next = await window.wenji.getState(); setAppState(next); notify(`索引完成，共 ${next.fileCount} 个文件`) }
  }) }, [refreshState, notify])
  const clearSearch = useCallback(() => { searchRequestRef.current++; setQuery(''); setSearchData({ results: [], elapsed: 0, total: 0 }); setSelectedId(null); setSearched(false); setSearching(false); inputRef.current?.focus() }, [])
  useEffect(() => { const key = e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inputRef.current?.focus() }
    else if (e.key === 'Escape' && document.activeElement === inputRef.current && query) { e.preventDefault(); clearSearch() }
  }; addEventListener('keydown', key); return () => removeEventListener('keydown', key) }, [clearSearch, query])
  const runSearch = useCallback(async () => {
    const normalized = query.trim(); const requestId = ++searchRequestRef.current
    if (!normalized) { setSearchData({ results: [], elapsed: 0, total: 0 }); setSelectedId(null); setSearched(false); setSearching(false); return }
    setSearching(true)
    try {
      const data = await window.wenji.search(normalized, { type, source, dateRange, sort })
      if (requestId !== searchRequestRef.current) return
      setSearchData(data); setSelectedId(data.results[0]?.id || null); setSearched(true)
    } finally { if (requestId === searchRequestRef.current) setSearching(false) }
  }, [query, type, source, dateRange, sort])
  useEffect(() => { if (!query.trim()) return; const id = setTimeout(runSearch, 260); return () => clearTimeout(id) }, [query, type, runSearch])
  useEffect(() => window.wenji.onIndexChanged(value => {
    setAppState(value.state); notify(`自动索引已更新：${value.changed} 个变动，${value.removed} 个移除`)
    if (query.trim()) setTimeout(runSearch, 0)
  }), [notify, query, runSearch])
  useEffect(() => window.wenji.onIndexError(value => notify(value.message || '自动索引更新失败', 'error')), [notify])
  useEffect(() => window.wenji.onFocusSearch(() => { inputRef.current?.focus(); inputRef.current?.select() }), [])
  useEffect(() => window.wenji.onActionNotice(value => notify(value.message || '操作完成')), [notify])
  const addFolder = async () => { try { setAppState(await window.wenji.addFolder()) } catch (error) { notify(error.message || '添加文件夹失败', 'error') } }
  const removeFolder = async folder => { try { setAppState(await window.wenji.removeFolder(folder)) } catch (error) { notify(error.message || '移除文件夹失败', 'error') } }
  const rebuild = async () => { try { setAppState(await window.wenji.rebuild()) } catch (error) { notify(error.message || '重新索引失败', 'error') } }
  const openResult = useCallback(async (result, locate = false) => {
    if (!result || opening) return
    setOpening(locate ? 'locate' : 'open')
    try {
      const response = await window.wenji.openFile(result, locate)
      if (!response?.ok) notify(response?.message || '无法打开文件', 'error')
      else if (response.located === false) notify(response.message || '已普通打开，未能定位', 'error')
      else notify(locate ? '已打开并定位到命中位置' : '已交给系统打开')
    } catch (error) { notify(error.message || '无法打开文件', 'error') }
    finally { setOpening(null) }
  }, [opening, notify])
  const revealResult = useCallback(async filePath => {
    if (opening) return
    setOpening('reveal')
    try { const response = await window.wenji.revealFile(filePath); response?.ok ? notify('已在文件夹中显示') : notify(response?.message || '无法打开所在位置', 'error') }
    catch (error) { notify(error.message || '无法打开所在位置', 'error') }
    finally { setOpening(null) }
  }, [opening, notify])
  const copyPath = useCallback(async filePath => {
    try { const response = await window.wenji.copyPath(filePath); response?.ok ? notify('已复制文件路径') : notify(response?.message || '复制失败', 'error') }
    catch (error) { notify(error.message || '复制失败', 'error') }
  }, [notify])
  return <div className="app-shell">
    <header className="titlebar"><div className="brand"><div className="brand-mark"><Search size={18}/></div><strong>文迹</strong><span>本地文件搜索</span></div><div className="privacy"><span className="status-dot"/>索引仅保存在本机</div></header>
    <Sidebar state={appState} progress={progress} onAdd={addFolder} onRemove={removeFolder} onRebuild={rebuild}/>
    <main className={`workspace ${detailOpen ? '' : 'detail-closed'}`}>
      <section className="search-zone"><form onSubmit={e => { e.preventDefault(); runSearch() }}><div className="search-input"><Search size={22}/><input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder={'搜索文件名或内容，例如 name:报告 -作废'} aria-label="搜索文件名或文件内容"/><span><Keyboard size={14}/> Ctrl K</span>{query && <button type="button" onClick={clearSearch} aria-label="清空搜索"><X size={17}/></button>}</div><button className="search-button" disabled={searching || !query.trim()}>{searching ? <RefreshCw size={19} className="spin"/> : <Search size={19}/>} 搜索</button></form>
        <div className="filter-row"><div className="filters">{types.map(t => <button key={t.key} className={type === t.key ? 'active' : ''} onClick={() => setType(t.key)}>{t.label}</button>)}</div><div className="advanced-filters"><label><span>范围</span><select aria-label="匹配范围" value={source} onChange={event => setSource(event.target.value)}>{sourceOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label><label><span>时间</span><select aria-label="修改时间" value={dateRange} onChange={event => setDateRange(event.target.value)}>{dateOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label><label><span>排序</span><select aria-label="结果排序" value={sort} onChange={event => setSort(event.target.value)}>{sortOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label><SyntaxHelp/></div></div>
      </section>
      <section className="results"><div className="results-head"><div>{searched ? <><strong>找到 {searchData.total} 个结果</strong><span>· {searchData.elapsed} 毫秒</span></> : <><strong>搜索结果</strong><span>文件名与内容 · 支持 Office、WPS、代码和文本文件</span></>}</div>{selected && <button className="toggle-detail" onClick={() => setDetailOpen(v => !v)} aria-label={detailOpen ? '收起详情' : '展开详情'}>{detailOpen ? <PanelRightClose size={17}/> : <PanelRightOpen size={17}/>}</button>}</div>
        <div className="result-list">
          {searchData.results.map(r => <ResultRow key={r.id} result={r} selected={r.id === selectedId} onSelect={() => { setSelectedId(r.id); setDetailOpen(true) }} onOpen={() => { setSelectedId(r.id); openResult(r, false) }} onContextMenu={event => { event.preventDefault(); setSelectedId(r.id); setDetailOpen(true); window.wenji.showContextMenu(r) }}/>) }
          {!searched && <div className="welcome"><div className="welcome-icon"><Search size={32}/></div><h2>{appState.roots.length ? '搜索文件名和内容' : '先添加一个搜索文件夹'}</h2><p>{appState.roots.length ? '输入关键词即可自动检索，并显示命中的文件名或原文位置。' : '文迹会在本机建立索引，文件内容不会上传。'}</p>{!appState.roots.length && <button className="primary" onClick={addFolder}><FolderPlus size={17}/>添加文件夹</button>}</div>}
          {searched && !searchData.results.length && <div className="welcome"><div className="welcome-icon"><FileText size={31}/></div><h2>没有找到“{query}”</h2><p>尝试更短的关键词，或切换到“全部”文件类型。</p></div>}
        </div>
      </section>
      {detailOpen && <DetailPane result={selected} onClose={() => setDetailOpen(false)} onOpen={(locate) => openResult(selected, locate)} onReveal={revealResult} onCopy={copyPath} opening={opening}/>} 
    </main>
    {showIndexDialog && (progress.phase === 'scanning' || progress.phase === 'indexing') && <IndexProgressDialog progress={progress} onBackground={() => { progressHiddenRef.current = true; setShowIndexDialog(false) }}/>} 
    <Toast toast={toast} onClose={() => setToast(null)}/>
  </div>
}
