'use strict'

const fs = require('#fs')

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function blockManifestAfterFirstRead(t, filePath) {
  const started = deferred()
  const streamClosed = deferred()
  const state = {
    descriptor: null,
    descriptorCloseAttempted: false,
    lstatPaths: [],
    openPaths: [],
    readPaths: [],
    reads: 0,
    streamClosed: false
  }
  const originalLstat = fs.promises.lstat
  const originalOpen = fs.promises.open
  const originalCreateReadStream = fs.createReadStream

  fs.promises.lstat = async function patchedLstat(lstatPath, ...args) {
    state.lstatPaths.push(lstatPath)
    return originalLstat.call(this, lstatPath, ...args)
  }
  fs.promises.open = async function patchedOpen(openPath, ...args) {
    state.openPaths.push(openPath)
    const handle = await originalOpen.call(this, openPath, ...args)
    if (openPath !== filePath) return handle
    state.descriptor = handle
    return {
      fd: handle.fd,
      close: async () => {
        state.descriptorCloseAttempted = true
        return handle.close()
      }
    }
  }
  fs.createReadStream = function patchedCreateReadStream(streamPath, opts) {
    state.readPaths.push(streamPath)
    const stream = originalCreateReadStream.call(this, streamPath, opts)
    if (streamPath !== filePath) return stream
    stream.once('data', () => {
      state.reads++
      stream.pause()
      started.resolve()
    })
    stream.once('close', () => {
      state.streamClosed = true
      streamClosed.resolve()
    })
    return stream
  }
  t.teardown(() => {
    fs.promises.lstat = originalLstat
    fs.promises.open = originalOpen
    fs.createReadStream = originalCreateReadStream
  })

  return { started: started.promise, streamClosed: streamClosed.promise, state }
}

async function settlePromptly(promises, timeout = 1_000) {
  let timer
  try {
    return await Promise.race([
      Promise.allSettled(promises),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Operation did not settle promptly')), timeout)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  blockManifestAfterFirstRead,
  settlePromptly
}
