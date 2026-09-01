'use strict'

const createTestnet = require('hyperdht/testnet')

async function createLocalTestnet(t, size = 3) {
  return createTestnet(size, t)
}

function waitFor(predicate, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started >= timeout)
        return reject(new Error('Timed out waiting for testnet state'))
      setTimeout(check, 10)
    }
    check()
  })
}

module.exports = {
  createLocalTestnet,
  waitFor
}
