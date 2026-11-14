import { describe, expect, it } from 'vitest'

import { resolveTernPresentation } from './config.ts'

describe('native Tern presentation modes', () => {
  it('uses the RFC idle-only composer by default', () => {
    expect(resolveTernPresentation({}, {})).toBe('composer')
  })

  it('enables rich projection only by explicit flag or environment', () => {
    expect(resolveTernPresentation({ ternLive: true }, {})).toBe('live')
    expect(resolveTernPresentation({}, { OMNARA_TERN_LIVE: '1' })).toBe('live')
    expect(resolveTernPresentation({}, { OMNARA_TERN_LIVE: '0' })).toBe('composer')
  })

  it('allows native surfaces to be disabled even when live is requested', () => {
    expect(resolveTernPresentation({ tern: false, ternLive: true }, {})).toBe('off')
    expect(resolveTernPresentation({ ternLive: true }, { OMNARA_TERN_NATIVE: '0' })).toBe('off')
  })
})
