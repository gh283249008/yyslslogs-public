'use strict';
// Codec composition adapter; domain parsers do not depend on tool/package paths.
const primitives=require('./rc4-state-offline.cjs');
const {normalize}=require('./normalize-rpc-blocks.cjs');
const {decode}=require('@msgpack/msgpack');
module.exports={OrderedCipher:require('../modules/acquisition/ordered-cipher.cjs').createOrderedCipher(primitives),BlockStream:require('../modules/parsing/block-stream.cjs').createBlockStream(normalize),...require('../modules/parsing/events.cjs').createEventDecoder(decode)};
