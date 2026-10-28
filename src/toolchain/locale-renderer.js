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
    const kind = ir.facts.find((candidate) => candidate.fact_id === fact.fact_id).kind
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
  const rows = facts.map((fact) => (
    `<article data-fact-id="${escapeHtml(fact.fact_id)}" data-uid="${escapeHtml(fact.uid_anchor ?? '')}" data-revision="${escapeHtml(ir.graph_revision)}" data-evidence-anchor="${escapeHtml(fact.anchor)}">`
    + `<h2>${escapeHtml(fact.label)}</h2><p>${escapeHtml(fact.subject)}</p></article>`
  )).join('')
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body data-schema="re.project-translation@0.1.0" data-revision="${escapeHtml(ir.graph_revision)}" data-semantic-fact-digest="${escapeHtml(ir.semantic_fact_digest)}"><main><h1>${escapeHtml(title)}</h1>${rows}</main></body></html>\n`
}

function renderSvg(ir, facts, locale) {
  const height = Math.max(100, 58 * facts.length + 70)
  const title = locale === 'zh-CN' ? 'RE 项目审阅翻译' : 'RE Project Review Translation'
  const rows = facts.map((fact, index) => (
    `<g data-fact-id="${escapeXml(fact.fact_id)}" data-uid="${escapeXml(fact.uid_anchor ?? '')}" data-revision="${escapeXml(ir.graph_revision)}" data-evidence-anchor="${escapeXml(fact.anchor)}"><text x="24" y="${48 + index * 58}">${escapeXml(fact.label)}: ${escapeXml(fact.subject)}</text></g>`
  )).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(title)}" width="1280" height="${height}" viewBox="0 0 1280 ${height}" data-schema="re.project-translation@0.1.0" data-revision="${escapeXml(ir.graph_revision)}" data-semantic-fact-digest="${escapeXml(ir.semantic_fact_digest)}"><title>${escapeXml(title)}</title>${rows}</svg>\n`
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
