'use strict'

function createClock(start = 1_700_000_000_000) {
  let current = start

  return {
    now() {
      return current
    },
    advance(milliseconds) {
      current += milliseconds
      return current
    }
  }
}

module.exports = {
  createClock
}
