const LOCALES = new Set(['zh-CN', 'en-US'])
const SECTION_LABELS = {
  'zh-CN': {
    'agent-event': 'Agent 事件',
    'agent-transition': 'Agent 状态转换',
    'adapter-contract': '适配器契约',
    agent: 'Agent 生命周期',
    capability: '能力',
    edge: '执行顺序',
    error: '错误路径',
    'function-declaration': '业务函数',
    module: '模块地图',
    package: '包',
    project: '项目摘要',
    resource: '资源',
    'run-case': '运行验收用例',
    state: '状态',
    task: '任务策略',
    'task-contract': '任务执行契约',
    'type-declaration': '名义类型',
    'concurrency-event': '并发执行',
  },
  'en-US': {
    'agent-event': 'Agent events',
    'agent-transition': 'Agent transitions',
    'adapter-contract': 'Adapter contracts',
    agent: 'Agent lifecycle',
    capability: 'Capabilities',
    edge: 'Execution order',
    error: 'Error paths',
    'function-declaration': 'Business functions',
    module: 'Module map',
    package: 'Package',
    project: 'Project summary',
    resource: 'Resources',
    'run-case': 'Run acceptance cases',
    state: 'States',
    task: 'Task policy',
    'task-contract': 'Task execution contracts',
    'type-declaration': 'Nominal types',
    'concurrency-event': 'Concurrent execution',
  },
}

export function renderProjectLocale(ir, { locale = ir.locale, media = 'all' } = {}) {
  if (!LOCALES.has(locale)) fail('unsupported-project-translation-locale', { locale })
  if (!['all', 'text', 'html', 'svg'].includes(media)) {
    fail('unsupported-project-translation-media', { media })
  }
  const facts = ir.facts.map((fact) => renderFact(fact, locale))
  const rendered = {
    html: renderHtml(ir, facts, locale),
    svg: renderSvg(ir, facts, locale),
    text: renderText(ir, facts, locale),
  }
  return media === 'all'
    ? rendered
    : { [media]: rendered[media] }
}

function renderFact(fact, locale) {
  const label = SECTION_LABELS[locale][fact.kind]
  if (label === undefined) fail('missing-project-translation-template', { kind: fact.kind })
  const anchor = fact.evidence?.anchor ?? `path:${fact.path.join('/')}`
  const subject = fact.summary || fact.path.at(-1) || fact.kind
  return {
    anchor,
    fact_id: fact.fact_id,
    kind: fact.kind,
    label,
    subject,
    uid_anchor: fact.uid_anchor,
  }
}

function renderText(ir, facts, locale) {
  const lines = [
    locale === 'zh-CN' ? 'RE 项目审阅翻译 0.1' : 'RE Project Review Translation 0.1',
    locale === 'zh-CN' ? `图修订：${ir.graph_revision}` : `Graph revision: ${ir.graph_revision}`,
    locale === 'zh-CN'
      ? `事实摘要：${ir.semantic_fact_digest}`
      : `Semantic fact digest: ${ir.semantic_fact_digest}`,
  ]
  let lastKind = null
  for (const fact of facts) {
    const kind = fact.kind
    if (kind !== lastKind) {
      lines.push('', SECTION_LABELS[locale][kind])
      lastKind = kind
    }
    const anchor = fact.uid_anchor ?? fact.anchor
    lines.push(`- ${fact.subject} [${fact.fact_id}] {${anchor}}`)
  }
  if (ir.changed_since !== null) {
    lines.push('', locale === 'zh-CN'
      ? `变更基线：${ir.changed_since}`
      : `Changed-since baseline: ${ir.changed_since}`)
  }
  return `${lines.join('\n')}\n`
}

function renderHtml(ir, facts, locale) {
  const title = locale === 'zh-CN' ? 'RE 项目审阅翻译' : 'RE Project Review Translation'
  const groups = groupFacts(facts)
  const summary = renderSummary(groups, locale)
  const sections = groups.map(([kind, entries], index) => {
    const open = index < 3 ? ' open' : ''
    const rows = entries.map((fact) => (
      `<article class="fact" data-fact-id="${escapeHtml(fact.fact_id)}" data-uid="${escapeHtml(fact.uid_anchor ?? '')}" data-revision="${escapeHtml(ir.graph_revision)}" data-evidence-anchor="${escapeHtml(fact.anchor)}">`
      + `<div class="fact-heading"><span class="fact-label">${escapeHtml(fact.label)}</span><code>${escapeHtml(fact.fact_id)}</code></div>`
      + `<p>${escapeHtml(fact.subject)}</p>`
      + `<small>${escapeHtml(fact.uid_anchor ?? fact.anchor)}</small></article>`
    )).join('')
    return `<details class="fact-group" data-kind="${escapeHtml(kind)}"${open}><summary><span>${escapeHtml(SECTION_LABELS[locale][kind])}</span><strong>${entries.length}</strong></summary><div class="fact-list">${rows}</div></details>`
  }).join('')
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#667085;--line:#dbe2ea;--panel:#f7f9fc;--accent:#2457d6;--accent-soft:#eaf0ff}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:40px 28px 64px}header{border-bottom:1px solid var(--line);padding-bottom:24px;margin-bottom:24px}
h1{font-size:28px;line-height:1.2;margin:0 0 10px}header p{color:var(--muted);margin:0;overflow-wrap:anywhere}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 24px}
.summary-card{border:1px solid var(--line);background:var(--panel);padding:14px 16px;border-radius:8px}.summary-card strong{display:block;font-size:22px}.summary-card span{color:var(--muted);font-size:12px}
.fact-group{border:1px solid var(--line);border-radius:8px;margin:10px 0;overflow:hidden;background:#fff}.fact-group summary{cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 16px;background:var(--panel);font-weight:650}.fact-group summary strong{color:var(--accent);font-size:13px}
.fact-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;padding:12px}.fact{border:1px solid var(--line);border-radius:6px;padding:12px 14px;min-width:0}.fact-heading{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.fact-label{color:var(--accent);font-size:12px;font-weight:700}.fact code,.fact small{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.fact p{margin:8px 0;overflow-wrap:anywhere}
@media(max-width:640px){main{padding:28px 16px 48px}.fact-heading{display:block}.fact code{display:block;margin-top:4px}}
</style>
</head>
<body data-schema="re.project-translation@0.1.0" data-revision="${escapeHtml(ir.graph_revision)}" data-semantic-fact-digest="${escapeHtml(ir.semantic_fact_digest)}">
<main><header><h1>${escapeHtml(title)}</h1><p>${escapeHtml(locale === 'zh-CN' ? '同一语义事实的可读审阅投影；不是审计结论。' : 'A readable projection of the same semantic facts; not an audit authority.')}</p><p><code>${escapeHtml(ir.graph_revision)}</code></p></header>${summary}${sections}</main>
</body>
</html>
`
}

function renderSvg(ir, facts, locale) {
  const groups = groupFacts(facts)
  const rowHeight = 42
  const sectionHeight = 34
  const height = Math.max(140, 82 + groups.reduce((total, [, entries]) => (
    total + sectionHeight + entries.length * rowHeight
  ), 0))
  const title = locale === 'zh-CN' ? 'RE 项目审阅翻译' : 'RE Project Review Translation'
  let y = 64
  const rows = groups.map(([kind, entries]) => {
    const heading = `<g class="section"><rect x="24" y="${y - 24}" width="1232" height="${sectionHeight}" rx="6" fill="#eaf0ff"/><text x="42" y="${y - 2}" fill="#2457d6" font-family="system-ui,sans-serif" font-size="15" font-weight="700">${escapeXml(SECTION_LABELS[locale][kind])}</text><text x="1228" y="${y - 2}" text-anchor="end" fill="#2457d6" font-family="system-ui,sans-serif" font-size="13">${entries.length}</text></g>`
    y += sectionHeight
    const rendered = entries.map((fact) => {
      const row = `<g data-fact-id="${escapeXml(fact.fact_id)}" data-uid="${escapeXml(fact.uid_anchor ?? '')}" data-revision="${escapeXml(ir.graph_revision)}" data-evidence-anchor="${escapeXml(fact.anchor)}"><rect x="24" y="${y - 19}" width="1232" height="${rowHeight - 4}" rx="5" fill="#ffffff" stroke="#dbe2ea"/><text x="42" y="${y + 1}" fill="#172033" font-family="system-ui,sans-serif" font-size="14">${escapeXml(fact.subject)}</text><text x="1238" y="${y + 1}" text-anchor="end" fill="#667085" font-family="ui-monospace,monospace" font-size="11">${escapeXml(fact.fact_id)}</text><title>${escapeXml(fact.label)}: ${escapeXml(fact.subject)} (${escapeXml(fact.uid_anchor ?? fact.anchor)})</title></g>`
      y += rowHeight
      return row
    }).join('')
    return heading + rendered
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(title)}" width="1280" height="${height}" viewBox="0 0 1280 ${height}" data-schema="re.project-translation@0.1.0" data-revision="${escapeXml(ir.graph_revision)}" data-semantic-fact-digest="${escapeXml(ir.semantic_fact_digest)}"><title>${escapeXml(title)}</title><rect width="1280" height="${height}" fill="#ffffff"/><text x="24" y="30" fill="#172033" font-family="system-ui,sans-serif" font-size="20" font-weight="700">${escapeXml(title)}</text>${rows}</svg>\n`
}

function groupFacts(facts) {
  const groups = new Map()
  for (const fact of facts) {
    const entries = groups.get(fact.kind) ?? []
    entries.push(fact)
    groups.set(fact.kind, entries)
  }
  return [...groups.entries()]
}

function renderSummary(groups, locale) {
  const total = groups.reduce((count, [, entries]) => count + entries.length, 0)
  const sectionLabel = locale === 'zh-CN' ? '事实类别' : 'fact groups'
  const factLabel = locale === 'zh-CN' ? '语义事实' : 'semantic facts'
  const traceLabel = locale === 'zh-CN' ? '事实可回链' : 'fact-linked review'
  return `<section class="summary" aria-label="${escapeHtml(locale === 'zh-CN' ? '项目摘要' : 'Project summary')}"><div class="summary-card"><strong>${total}</strong><span>${factLabel}</span></div><div class="summary-card"><strong>${groups.length}</strong><span>${sectionLabel}</span></div><div class="summary-card"><strong>IR</strong><span>${traceLabel}</span></div></section>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]))
}

const escapeXml = escapeHtml

function fail(code, details = {}) {
  throw Object.assign(new TypeError(code), { diagnostic: { code, ...details } })
}
