bxson
======
[![Build Status](https://app.travis-ci.com/andrasq/node-bxson.svg?branch=master)](https://app.travis-ci.com/github/andrasq/node-bxson)
[![Coverage Status](https://coveralls.io/repos/github/andrasq/node-bxson/badge.svg?branch=master)](https://coveralls.io/github/andrasq/node-bxson?branch=master)

`bxjson` is a binary serialization format similar in scope and intent to JSON.
It supports only numbers, strings, arrays and hashes (and a few atomic types),
but not RegExp, Date or other non-trivial types.

`bxjson` serializes arrays and objects using a variable-length encoding:  the end of the data can
only be determined by traversing the contained elements.

To run the tests check out the repo.

    const bxson = require('bxson');
    bxson.encode({ a: 1, b: 2.5, c: true, d: [] });
    // => <Buffer f4 c1 61 01 c1 62 4f 40 04 00 00 00 00 00 00 c1 63 43 c1 64 e0>


## Api

### encode( item )

Return a Buffer with the `item` serialized to a sequence of bytes.  Serialization is similar to
JSON, with some minor differences:

- unlike JSON, `undefined` values are encoded to `undefined` and not skipped
- unlike JSON, functions, bigints, Symbols are encoded to `undefined` and not skipped
- unliked JSON, missing elements in sparse arrays are encoded as `undefined` not `null`
- unlike JSON, Buffers encode to their binary contents and not to `{"type":"Buffer","data":[...]}`


- like JSON, properties of arrays are not encoded, only their contents
- like JSON, objects with a `toJSON()` method are first converted with their toJSON method before
  serialization (but not `Buffer`)
- like JSON, items that are converted with `toJSON` are decoded to their converted form
- like JSON, because `Date` has a toJSON method, it is encoded to an ISO datetime string
  and is deencoded to a string

### decode( bytes )

Recover the item that corresponds to the `bytes`.


## Todo

- time optimal utf8 encode/decode tradeoff length
- time unified vs split encodeLength vs encodeNumber
- time unified vs split uint/negint types
- try to use pushbuf in qbson too (instead of calculating size)

## Changelog

0.0.5 - fix integer encoding
0.0.4 - pushbuf tests
0.0.3 - published repo
