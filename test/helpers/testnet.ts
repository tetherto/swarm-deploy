/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import type { Assert } from 'brittle'
import createTestnet, { type Testnet } from 'hyperdht/testnet'

export async function createLocalTestnet(t: Assert, size = 3): Promise<Testnet> {
  return createTestnet(size, t)
}

export function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started >= timeout) {
        return reject(new Error('Timed out waiting for testnet state'))
      }
      setTimeout(check, 10)
    }
    check()
  })
}
