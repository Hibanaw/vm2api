import { readLocalHost } from '../cluster/auto-placement.mjs'
import { zonedDayStartMs } from '../core/timezone.mjs'
import { SLA_ERROR_PRED, SLA_SUCCESS_PRED } from '../db/repos/usage-log-preds.mjs'
import { extraWindowSince, parseResetMs, WINDOW_5H_MS, WINDOW_7D_MS } from '../pool/quota-window.mjs'

const CACHE_MS = 30_000
const WIDTH = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const TZ = 'Asia/Singapore'
const CLOCK = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const OFFICIAL_MODEL =
  /^(?:claude-(?:opus|sonnet|haiku)-\d+(?:[.-]\d+)?|gpt-\d+(?:\.\d+)?(?:-(?:nano|mini|pro|codex))?|o[134](?:-(?:mini|pro))?|gemini-\d+(?:\.\d+)?-(?:flash(?:-lite)?|pro))(?:-\d{8})?$/

function number(value) {
  if (value == null || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : null
}

function format(value) {
  return value == null ? '—' : WIDTH.format(value)
}

function percent(value) {
  return value == null ? '—' : `${format(value)}%`
}

function slotStatus(slot) {
  if (!slot.has_token) return ['未绑定', 'neutral']
  if (slot.status === 'stopped') return ['已停止', 'neutral']
  if (slot.schedule_state === 'off') return ['暂停调度', 'neutral']
  if (slot.availability?.accept === true) return ['可用', 'ok']
  switch (slot.availability?.key) {
    case 'quota':
      return ['额度受限', 'warn']
    case 'cool':
      return ['冷却中', 'warn']
    case 'bad':
    case 'revoke':
      return ['凭证异常', 'error']
    case 'off':
      return ['暂停调度', 'neutral']
    default:
      return ['暂不可用', 'error']
  }
}

function quotaWindow(slot, key, span, now) {
  const codex = slot.codex_usage?.windows?.find((window) => window.id === key)
  const codexSample = number(codex?.used_percent)
  const sample = codexSample ?? number(slot[`utilization_${key}`])
  const used =
    slot.has_token && sample != null ? Math.min(100, codexSample == null && sample <= 1 ? sample * 100 : sample) : null
  const resetMs = parseResetMs(codex?.reset_at ?? slot[`reset_${key}`])
  const remainingMs = resetMs > now ? resetMs - now : null
  const policy = slot.quota_policy ?? slot.openai_quota_policy
  const limit = Math.min(1, number(policy?.[`limit_${key}`]) ?? 1) * 100
  const target = slot.has_token ? Math.max(0, 1 - (remainingMs ?? span) / span) * limit : null
  return { used, target, remainingMs }
}

function statsOf(db, slots, now) {
  const today = new Date(zonedDayStartMs(now, TZ)).toISOString()
  const weekStart = now - WINDOW_7D_MS
  const week = new Date(weekStart).toISOString()
  const filtered = "created_at >= ? AND COALESCE(vm_owner_user_id, '') = ''"
  const totals = db
    .prepare(`
    SELECT COUNT(*) AS today, AVG(duration_ms) AS duration
    FROM usage_logs WHERE ${filtered}
    `)
    .get(today)
  let outcomes = null
  if (slots.length) {
    const values = slots.map(() => '(CAST(? AS TEXT), CAST(? AS TEXT))').join(', ')
    const windows = slots.flatMap((slot) => {
      const reset = slot.codex_usage?.windows?.find((window) => window.id === '7d')?.reset_at ?? slot.reset_7d
      const start = extraWindowSince(reset, WINDOW_7D_MS, now) ?? weekStart
      return [slot.id, new Date(Math.max(start, weekStart)).toISOString()]
    })
    outcomes = db
      .prepare(`
      WITH windows(slot_id, since) AS (VALUES ${values})
      SELECT SUM(CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END) AS successes,
             SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors
      FROM usage_logs JOIN windows ON usage_logs.vm_id = windows.slot_id
      WHERE ${filtered} AND created_at >= windows.since
      `)
      .get(...windows, week)
  }
  const models = db
    .prepare(`
    SELECT model, COUNT(*) AS requests FROM usage_logs
    WHERE ${filtered} AND model IS NOT NULL
    GROUP BY model ORDER BY requests DESC, model LIMIT 32
    `)
    .all(week)
    .filter(({ model }) => OFFICIAL_MODEL.test(model))
    .slice(0, 6)
    .map(({ model, requests }) => ({ model, requests: Number(requests) }))
  return {
    today: Number(totals.today || 0),
    duration: number(totals.duration),
    successes: Number(outcomes?.successes || 0),
    errors: Number(outcomes?.errors || 0),
    models,
  }
}

function resetText(remainingMs) {
  if (remainingMs == null) return '未开窗'
  const minutes = Math.ceil(remainingMs / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes % 60} 分` : `${minutes} 分`
}

function meter(label, value, marker = null) {
  const fill = value == null ? '' : `<i style="width:${Math.min(100, value)}%"></i>`
  const tick = marker == null ? '' : `<b style="left:${marker}%" title="按时间均摊应使用 ${percent(marker)}"></b>`
  return `<div class="meter" role="img" aria-label="${label} ${percent(value)}">${fill}${tick}</div>`
}

function quotaRow(label, window) {
  return `<div class="quota">
    <div class="line"><span>${label}</span><strong>${percent(window.used)}</strong></div>
    ${meter(`${label} 已用`, window.used, window.target)}
    <small>${window.remainingMs != null ? `剩余 ${resetText(window.remainingMs)}` : window.used == null ? '额度未探测' : '未开窗'}</small>
  </div>`
}

function slotCard(slot, index, now, week) {
  const [status, tone] = slotStatus(slot)
  const used = number(slot.seats_used ?? slot.session_active)
  const max = number(slot.seats_max ?? slot.session_max)
  return `<article class="card slot">
    <header class="line"><h3>槽位 ${String(index + 1).padStart(2, '0')}</h3><span class="pill ${tone}">${status}</span></header>
    ${quotaRow('5H', quotaWindow(slot, '5h', WINDOW_5H_MS, now))}
    ${quotaRow('7D', week)}
    <footer class="line"><span>席位</span><strong>${format(used)} / ${max === 0 ? '不限' : format(max)}</strong></footer>
  </article>`
}

function hostRow(host, label) {
  const cores = number(host?.cpu_count)
  const load = number(host?.load1)
  const total = number(host?.mem_total)
  const used = number(host?.mem_used)
  const memory = total && used != null ? Math.min(100, (used / total) * 100) : null
  return `<li class="host"><div class="line"><strong>${label}</strong><small>${host ? '在线' : '暂无数据'}</small></div>
    <div class="line"><span>1 分钟负载</span><span>${format(load)} / ${format(cores)} 核</span></div>
    <div class="line"><span>内存</span><span>${memory == null ? '—' : `${format(used / 1024 ** 3)} / ${format(total / 1024 ** 3)} GiB · ${percent(memory)}`}</span></div>
    ${meter('内存使用率', memory)}</li>`
}

function html(body, refresh = 60) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="${refresh}">
  <title>服务状态 · vm2api</title>
  <link rel="stylesheet" href="/check.css">
</head>
<body><main>${body}</main></body>
</html>`
}

function render(slots, nodes, localHost, stats, now) {
  const weeks = slots.map((slot) => quotaWindow(slot, '7d', WINDOW_7D_MS, now))
  const balances = weeks.flatMap(({ used }) => (used == null ? [] : [100 - used])).sort((left, right) => left - right)
  const middle = Math.floor(balances.length / 2)
  const median = balances.length ? (balances[middle] + balances[Math.floor((balances.length - 1) / 2)]) / 2 : null
  const available = slots.filter((slot) => slotStatus(slot)[1] === 'ok').length
  const requests = stats ? stats.successes + stats.errors : 0
  const models = stats?.models || []
  return html(`
    <header class="hero">
      <p class="service">vm2api</p>
      <h1>服务状态</h1>
      <div class="line hero-meta"><span class="pill ${available ? 'ok' : 'neutral'}">${available} / ${slots.length} 槽位可用</span><small>${CLOCK.format(now)} 更新 · UTC+8</small></div>
    </header>
    <section class="metrics" aria-label="运行总览">
      <article class="card metric"><h2>7 天窗口余量</h2><strong>${percent(median)}</strong><small>${balances.length} 个有读数的槽位 · 中位数</small></article>
      <article class="card metric"><h2>7 天窗口成败</h2><strong>${percent(requests ? (stats.successes / requests) * 100 : null)}</strong><small>${format(stats?.successes)} 成功 / ${format(stats?.errors)} 失败</small></article>
      <article class="card metric"><h2>今日请求</h2><strong>${format(stats?.today)}</strong><small>UTC+8 今日</small></article>
      <article class="card metric"><h2>平均响应时间</h2><strong>${stats?.duration != null ? `${format(stats.duration / 1000)}<span> 秒</span>` : '—'}</strong><small>今日已记录请求</small></article>
    </section>
    <section class="section">
      <div class="section-head"><h2>槽位状态</h2><small>实色为已用额度，细线为时间均摊目标</small></div>
      <div class="slots">${slots.map((slot, index) => slotCard(slot, index, now, weeks[index])).join('') || '<p class="empty">暂无公开槽位</p>'}</div>
    </section>
    <div class="lower section">
      <section class="card detail"><div class="section-head"><h2>模型排行</h2><small>近 7 天 · 请求数</small></div>
        ${models.length ? `<ol class="models">${models.map(({ model, requests }) => `<li><div class="line"><strong>${model}</strong><span>${format(requests)}</span></div>${meter('相对请求量', (requests / models[0].requests) * 100)}</li>`).join('')}</ol>` : '<p class="empty">暂无排行数据</p>'}</section>
      <section class="card detail"><div class="section-head"><h2>集群负载</h2><small>节点实时快照</small></div>
        <ul class="hosts">${hostRow(localHost, '本机')}${nodes.map((node, index) => hostRow(node.health?.stale ? null : node.health?.host, `节点 ${index + 1}`)).join('')}</ul></section>
    </div>
  `)
}

export function createPublicStatusPage({ getSlots, getNodes, getDb }) {
  let cached
  return (req, res) => {
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' })
      return res.end()
    }
    const now = Date.now()
    if (!cached || now >= cached.expires) {
      try {
        const nodes = getNodes()
        const slots = getSlots(nodes)
        let stats = null
        try {
          stats = statsOf(getDb(), slots, now)
        } catch (error) {
          console.warn('[public-status] statistics unavailable', error.message)
        }
        cached = { body: render(slots, nodes, readLocalHost(), stats, now), status: 200, expires: now + CACHE_MS }
      } catch (error) {
        console.warn('[public-status] snapshot unavailable', error.message)
        cached = {
          body: html('<header class="hero"><h1>服务状态暂不可用</h1></header>', 15),
          status: 503,
          expires: now + 5000,
        }
      }
    }
    res.writeHead(cached.status, headers)
    return res.end(req.method === 'HEAD' ? undefined : cached.body)
  }
}
