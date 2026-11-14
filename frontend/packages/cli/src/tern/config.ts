/**
 * Native presentation is only a terminal concern; Omnara's agent, SDK, and
 * interaction authority never move to Tern.
 */
export type TernPresentationMode = 'off' | 'composer' | 'live'

export function resolveTernPresentation(
  flags: { tern?: boolean; ternLive?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): TernPresentationMode {
  if (flags.tern === false || env.OMNARA_TERN_NATIVE === '0') return 'off'
  if (flags.ternLive === true || env.OMNARA_TERN_LIVE === '1') return 'live'
  return 'composer'
}
