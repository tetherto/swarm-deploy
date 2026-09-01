'use strict'

const { SwarmDeployError, ERRORS } = require('./errors')

function abortError() {
  return new SwarmDeployError(ERRORS.ABORTED, 'Operation aborted')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function onAbort(signal, callback) {
  if (!signal) return () => {}
  if (signal.aborted) {
    callback()
    return () => {}
  }
  signal.addEventListener('abort', callback, { once: true })
  return () => signal.removeEventListener('abort', callback)
}

function createAbortController() {
  if (typeof globalThis.AbortController === 'function') return new globalThis.AbortController()
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(event, callback) {
      if (event === 'abort') listeners.add(callback)
    },
    removeEventListener(event, callback) {
      if (event === 'abort') listeners.delete(callback)
    }
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const callback of listeners) callback()
      listeners.clear()
    }
  }
}

module.exports = { abortError, throwIfAborted, onAbort, createAbortController }
