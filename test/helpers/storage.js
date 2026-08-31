'use strict'

const fs = require('#fs')

function createStorage({
  failWriteFor = () => false,
  failSyncFor = () => false,
  beforeOperation = async () => {},
  afterOperation = async () => {}
} = {}) {
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
    storage[name] = async function storageOperation(...args) {
      await beforeOperation(name, ...args)
      const result = await promises[name](...args)
      await afterOperation(name, ...args)
      return result
    }
  }

  storage.open = async function open(filePath, flags, mode) {
    await beforeOperation('open', filePath, flags, mode)
    const handle = await promises.open(filePath, flags, mode)
    await afterOperation('open', filePath, flags, mode)

    return {
      fd: handle.fd,
      close: async () => {
        await beforeOperation('close', filePath)
        const result = await handle.close()
        await afterOperation('close', filePath)
        return result
      },
      read: async (...args) => {
        await beforeOperation('read', filePath, ...args)
        const result = await handle.read(...args)
        await afterOperation('read', filePath, ...args)
        return result
      },
      stat: async (...args) => {
        await beforeOperation('stat', filePath, ...args)
        const result = await handle.stat(...args)
        await afterOperation('stat', filePath, ...args)
        return result
      },
      truncate: async (...args) => {
        await beforeOperation('truncate', filePath, ...args)
        const result = await handle.truncate(...args)
        await afterOperation('truncate', filePath, ...args)
        return result
      },
      write: async (...args) => {
        await beforeOperation('write', filePath, ...args)
        if (failWriteFor(filePath)) throw new Error(`Injected write failure for ${filePath}`)
        const result = await handle.write(...args)
        await afterOperation('write', filePath, ...args)
        return result
      },
      sync: async () => {
        await beforeOperation('sync', filePath)
        if (failSyncFor(filePath)) throw new Error(`Injected sync failure for ${filePath}`)
        const result = await handle.sync()
        await afterOperation('sync', filePath)
        return result
      }
    }
  }

  return storage
}

module.exports = {
  createStorage
}
