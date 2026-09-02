'use strict'

const { SwarmDeployError, ERRORS } = require('../lib/errors.js')
const {
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed
} = require('../lib/identity.js')
const { topicFromServerPublicKey } = require('../lib/topic.js')
const { validateBasename, selectUploadPaths, buildFileManifest } = require('../lib/files.js')
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
  RESULT_CODE,
  PROTOCOL_VERSION,
  DIGEST_BYTES,
  TRANSFER_ID_BYTES,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS
} = require('../lib/protocol/constants.js')
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
} = require('../lib/protocol/codecs.js')
const { transferId, encodeTransferIdCanonical } = require('../lib/protocol/transfer-id.js')
const { parseAllowlist, AllowlistWatcher } = require('../lib/allowlist.js')
const { Server } = require('../lib/server.js')
const { Client } = require('../lib/client.js')

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
  RESULT_CODE,
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
