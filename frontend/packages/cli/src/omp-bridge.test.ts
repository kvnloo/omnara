import { describe, expect, it } from 'vitest'

import { buildOmpInputBody, parseOmpBridgeRequest } from './omp-bridge.ts'

describe('OMP bridge protocol', () => {
  it('accepts a typed request with JSON params', () => {
    expect(
      parseOmpBridgeRequest(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'input.create',
          params: {
            text: 'hello',
            idempotency_key: 'omp-1',
            delivery_mode: 'steering',
          },
        }),
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'input.create',
      params: {
        text: 'hello',
        idempotency_key: 'omp-1',
        delivery_mode: 'steering',
      },
    })
  })

  it('builds Omnara input with hidden OMP provenance and inline media', () => {
    expect(
      buildOmpInputBody({
        text: 'look at this',
        idempotency_key: 'omp-2',
        delivery_mode: 'queued',
        attachments: [{ media_type: 'image/png', data: 'cG5n', filename: 'shot.png' }],
      }),
    ).toEqual({
      content_blocks: [
        {
          type: 'text',
          text: 'This message came from an OMP terminal frontend connected through Omnara. Reply with normal assistant text unless explicitly asked to message an integration.',
          metadata: { omnara_hidden: 'true' },
        },
        { type: 'text', text: 'look at this' },
        { type: 'media', media_type: 'image/png', data: 'cG5n', filename: 'shot.png' },
      ],
      delivery_mode: 'queued',
    })
  })

  it('rejects malformed protocol input before dispatch', () => {
    expect(() => parseOmpBridgeRequest('{"method":"input.create"}')).toThrow()
  })
})
