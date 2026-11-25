import { expiresAtToMs } from '@/lib/fable-status'
import type { WindowReadout } from '@/features/vm/vm-rack-model'

const WINDOW_SPAN_MS: Record<string, number> = {
  '5h': 5 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  fable: 7 * 24 * 3600_000,
}

export type WindowTiming = {
  /** 窗口已过去的百分比；未开窗的 5H/7D 为 0。 */
  elapsedPct: number | null
  /** 均摊到当前时刻的用量，使用进度条的官方额度百分比坐标。 */
  targetPct: number | null
  /** 实际用量 ÷ 当前目标用量；>1 说明用得比时间快 */
  pace: number | null
  /** 按当前节奏重置前就会用满时，还需多少毫秒 */
  fullInMs: number | null
  startMs: number | null
  resetMs: number | null
}

/** 窗口起点 = 重置时间 − 窗口长度。只用已有的 reset 与 pct，不另取数据。 */
export function windowTiming(w: WindowReadout, now: number): WindowTiming {
  const span =
    w.windowMinutes != null && w.windowMinutes > 0
      ? w.windowMinutes * 60_000
      : WINDOW_SPAN_MS[w.key]
  const resetMs = expiresAtToMs(w.reset) || null
  if (!span || !resetMs || resetMs <= now) {
    const unopenedPct = span && w.limitPct != null ? 0 : null
    return {
      elapsedPct: unopenedPct,
      targetPct: unopenedPct,
      pace: null,
      fullInMs: null,
      startMs: null,
      resetMs,
    }
  }
  const startMs = resetMs - span
  const elapsed = Math.min(span, Math.max(0, now - startMs))
  const elapsedPct = (elapsed / span) * 100
  const limit = w.limitPct ?? 100
  const targetPct = (elapsed / span) * limit
  const pct = w.pct
  const pace = pct != null && targetPct > 0 ? pct / targetPct : null
  let fullInMs: number | null = null
  if (pct != null && pct > 0 && pct < limit && elapsed > 0) {
    const need = ((limit - pct) / pct) * elapsed
    if (need < resetMs - now) fullInMs = need
  }
  return { elapsedPct, targetPct, pace, fullInMs, startMs, resetMs }
}

export function windowTargetLabel(targetPct: number | null) {
  return targetPct == null
    ? undefined
    : `按时间均摊应使用 ${Number(targetPct.toFixed(1))}%`
}
