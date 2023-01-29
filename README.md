# bxjson

`bxjson` is a binary serialization format similar in scope and intent to JSON.
It supports only numbers, strings, arrays and hashes (and a few atomic types),
but not RegExp, Date or other non-trivial types.

`bxjson` serializes arrays and objects using a variable-length encoding:  the end of the data can
only be determined by traversing the contained elements.

## Todo

- time optimal utf8 encode/decode tradeoff length
- time unified vs split encodeLength vs encodeNumber
- time unified vs split uint/negint types
- try to use pushbuf in qbson too (instead of calculating size)
- try new typecodes that put type in 5 lsbitss and omits str16 et al,
  uses a 1-bit flag for "short" 1- or "long" 4-byte lengths 


