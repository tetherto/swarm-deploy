'use strict'

const fs = require('#fs')

function createStorage({ failWriteFor = () => false, failSyncFor = () => false } = {}) {
  const promises = fs.promises
  const storage = {}

  for (const name of [
    'mkdir',
    'lstat',
    'readdir',
    'readFile',
    'writeFile',
    'rename',
    'unlink',
    'rm'
  ]) {
    storage[name] = promises[name].bind(promises)
  }

  storage.open = async function open(filePath, flags, mode) {
    const handle = await promises.open(filePath, flags, mode)

    return {
      fd: handle.fd,
      close: handle.close.bind(handle),
      read: handle.read.bind(handle),
      stat: handle.stat.bind(handle),
      truncate: handle.truncate.bind(handle),
      write: async (...args) => {
        if (failWriteFor(filePath)) throw new Error(`Injected write failure for ${filePath}`)
        return handle.write(...args)
      },
      sync: async () => {
        if (failSyncFor(filePath)) throw new Error(`Injected sync failure for ${filePath}`)
        return handle.sync()
      }
    }
  }

  return storage
}

module.exports = {
  createStorage
}
