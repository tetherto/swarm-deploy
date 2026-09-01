'use strict'

const { SwarmDeployError, ERRORS } = require('./lib/errors')
const {
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed
} = require('./lib/identity')
const { topicFromServerPublicKey } = require('./lib/topic')
const { validateBasename, selectUploadPaths, buildFileManifest } = require('./lib/files')
const {
  OFFER,
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
  STATUS_CODE,
  PROTOCOL_VERSION,
  DIGEST_BYTES,
  TRANSFER_ID_BYTES,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS
} = require('./lib/protocol/constants')
const {
  encodeBounded,
  decodeBounded,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result,
  mergeBitmapPages
} = require('./lib/protocol/codecs')
const { transferId, encodeTransferIdCanonical } = require('./lib/protocol/transfer-id')
const { parseAllowlist, AllowlistWatcher } = require('./lib/allowlist')
const { Server } = require('./lib/server')
const { Client } = require('./lib/client')

module.exports = {
  SwarmDeployError,
  ERRORS,
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed,
  topicFromServerPublicKey,
  validateBasename,
  selectUploadPaths,
  buildFileManifest,
  OFFER,
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
  STATUS_CODE,
  PROTOCOL_VERSION,
  DIGEST_BYTES,
  TRANSFER_ID_BYTES,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS,
  encodeBounded,
  decodeBounded,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result,
  mergeBitmapPages,
  transferId,
  encodeTransferIdCanonical,
  parseAllowlist,
  AllowlistWatcher,
  Server,
  Client
}
