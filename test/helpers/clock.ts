import type { Clock } from '../../dist/types.js'

export interface TestClock extends Clock {
  advance(milliseconds: number): number
}

export function createClock(start = 1_700_000_000_000): TestClock {
  let current = start

  return {
    now() {
      return current
    },
    advance(milliseconds: number) {
      current += milliseconds
      return current
    }
  }
}
