import { describe, expect, it } from 'vitest'

import { parseOmpBridgeRequest } from './omp-bridge.ts'

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

  it('rejects malformed protocol input before dispatch', () => {
    expect(() => parseOmpBridgeRequest('{"method":"input.create"}')).toThrow()
  })
})
