'use strict';

var assert = require('assert');
var bjson = require('./bjson');
var encode = bjson.encode, decode = bjson.decode;

var fromBuf = parseInt(process.versions.node) >= 7 ? Buffer.from : Buffer;

var T_UINT8 = 0x44;
var T_UINT16 = 0x44 + 1;
var T_UINT64 = 0x44 + 3;
var T_NEGINT64 = 0x48 + 3;
var T_FLOAT32 = 0x4E;
var T_NONESUCH = 0x55;

// canonical test data
var data = {
    null: null,
    undef: undefined,

    i0: 0,
    i1: 1,
    im: 1e6,
    ii: Infinity,
    in0: -0,
    in1: -1,
    inm: -1e6,
    ini: -Infinity,

    f2: 1.25,
    nan: NaN,

    str: 'Hello, w\orld',
    array: [1, 2.5, 'three'],
    object: { a:1, b:2.5, c:'three' },
};

describe('bjson', function() {
    describe('encode', function() {
        it('returns a buffer', function() {
            var buf = encode(1);
            assert.ok(Buffer.isBuffer(buf));
            assert.ok(buf.length > 0);
        })
    })

    describe('decode', function() {
        it('decodes a buffer', function() {
            assert.strictEqual(decode(fromBuf([0x44, 4, 3, 2, 1])), 4);
        })
        it('decodes an immediate integer', function() {
            assert.equal(decode([0]), 0);
            assert.equal(decode([9]), 9);
            assert.equal(decode([0x3f]), -1);
            assert.equal(decode([0x20]), -32);
        })
        it('decodes an array', function() {
            assert.strictEqual(decode([T_UINT8, 4, 3, 2, 1]), 4);
            assert.strictEqual(decode([T_UINT16, 4, 3, 2, 1]), 4 * 256 + 3);
        })
        it('decodes floats', function() {
            var buf = fromBuf([0, 0, 0, 0, 0]);
            buf.writeFloatBE(1.25, 1);
            buf[0] = T_FLOAT32;
            assert.equal(decode(buf), 1.25);
        })
        it('decodes huge integers', function() {
            assert.equal(decode([T_UINT64, 0, 0, 0, 0, 0, 0, 2, 1]), 513);
            assert.equal(decode([T_NEGINT64, 0, 0, 0, 0, 0, 0, 2, 1]), -513);
        })
        describe('errors', function() {
            it('invalid type', function() {
                assert.throws(function(){ decode([T_NONESUCH, 1, 2, 3, 4]) }, /not supported/);
            })
        })
    })

    describe('encode and decode', function() {
        it('fixed length types', function() {
            var tests = [
                null, undefined, true, false, 0, 1, -1, 31, -31,
            ]
            for (var i=0; i<tests.length; i++) {
                assert.strictEqual(decode(encode(tests[i])), tests[i], 'test ' + i);
            }
        })
        it('numbers', function() {
            var tests = [
                0, 1, 1.25, 123, 1234, 12345, 1e6, 1e10, 1.5e100, Infinity,
                -0, -1, -1.25, -123, -1234, -12345, -1e6, -1e10, -1.5e100, -Infinity,
            ];
            for (var i=0; i<tests.length; i++) {
                assert.strictEqual(decode(encode(tests[i])), tests[i], 'test ' + i + ': ' + tests[i]);
                assert.strictEqual(decode(encode(new Number(tests[i]))), tests[i], 'test ' + i + ': ' + tests[i]);
            }
            assert.ok(isNaN(decode(encode(NaN))));
        })
        it('strings', function() {
            assert.strictEqual(decode(encode('ABC')), 'ABC');
            assert.strictEqual(decode(encode('ABC\xff')), 'ABC\xff');
            var s = new Array(1000).join('x');
            assert.equal(decode(encode(s)), s);
            var s = new Array(100000).join('x');
            assert.equal(decode(encode(s)), s);
        })
        it('utf8 single-charcode chars', function() {
            var buf = fromBuf([0, 0, 0, 0]);
            for (var i=0; i<0xd800; i+=7) {
                var s = String.fromCharCode(i);
                assert.equal(decode(encode(s)), s, 'charcode ' + i.toString(16));
            }
            // skip surrogate pair charcodes (leading d800-dbff, trailing dc00-dfff)
            // pushbuf has tests on them
            for (var i=0xe000; i<1e6 + 0x10000; i+= 7) {
                assert.equal(decode(encode(s)), s, 'charcode ' + i.toString(16));
            }
            // FIXME: long utf8 strings
        })
        it('bytes', function() {
            assert.deepEqual(decode(encode(fromBuf('ABC'))), fromBuf('ABC'));
        })
        it('arrays', function() {
            assert.deepEqual(decode(encode([1,2,3])), [1,2,3]);
            assert.deepEqual(decode(encode([1,2,[3],{d:4}])), [1,2,[3],{d:4}]);
        })
        it('objects', function() {
            assert.deepEqual(decode(encode({a:1, b:{c:2}})), {a:1, b:{c:2}});
            var o = /foo/;
            o.a = 1;
            o.b = 2.5;
            o.c = 'cee'
            assert.deepEqual(decode(encode(o)), {a:1, b:2.5, c:'cee'});
        })
        it('Dates as strings', function() {
            assert.equal(decode(encode(new Date(0))), '1970-01-01T00:00:00.000Z');
        })
        it('oddball types', function() {
            assert.strictEqual(decode(encode(function(){})), undefined);
            assert.strictEqual(decode(encode(global.Symbol && global.Symbol('x'))), undefined);
            assert.strictEqual(decode(encode(new Number(1234))), 1234);
            assert.strictEqual(decode(encode(new Boolean(true))), true);
            assert.strictEqual(decode(encode(new String("abc"))), "abc");
            var err = new Error('test error');
            err.toJSON = function() { return { message: this.message, stack: this.stack } }
            assert.deepEqual(decode(encode(err)), { message: err.message, stack: err.stack });
        })
    })
})
