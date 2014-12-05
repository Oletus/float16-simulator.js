/**
 * Get sign, exponent and mantissa from a number.
 * Based on http://stackoverflow.com/questions/9383593/extracting-the-exponent-and-mantissa-of-a-javascript-number
 *
 * @param {number} x Number to convert.
 * @return {Object} with fields sign, exponent and mantissa.
 * Mantissa is returned in the range [1.0, 2.0[ for normal numbers
 * and [0.0, 1.0[ for subnormal numbers or zero.
 */
var getNumberParts = function(x) {
    var float = new Float64Array([x]);
    var bytes = new Uint8Array(float.buffer);

    var sign = bytes[7] >> 7;
    var exponent = ((bytes[7] & 0x7f) << 4 | bytes[6] >> 4) - 0x3ff;

    // Set the exponent to 0 (exponent bits to match bias)
    bytes[7] = 0x3f;
    bytes[6] |= 0xf0;

    return {
        sign: sign,
        exponent: exponent,
        mantissa: float[0]
    };
};

var exponentBias = function(exponentBits) {
    var possibleExponents = Math.pow(2, exponentBits);
    return possibleExponents / 2 - 1;
};

var maxNormalExponent = function(exponentBits) {
    var possibleExponents = Math.pow(2, exponentBits);
    var bias = exponentBias(exponentBits);
    var allExponentBitsOne = possibleExponents - 1;
    return (allExponentBitsOne - 1) - bias;
};

/**
 * Round the parameter as if it was stored to a floating point representation
 * that has the specified bit counts for mantissa and exponent. Works for
 * formats up to 8 exponent bits and 23 mantissa bits.
 *
 * @param {number} src Number to convert.
 * @param {number} mantissaBits How many bits to use for mantissa.
 * @param {number} exponentBits How many bits to use for exponent.
 * @param {boolean} clampToInf Set true to clamp to infinity (instead of the maximum or minimum value supported)
 * @param {boolean} flushSubnormal Set true to flush subnormal numbers to 0 (instead of keeping subnormal values)
 * @return {number} Converted number.
 */
var froundBits = function(src, mantissaBits, exponentBits, clampToInf, flushSubnormal) {
    if (mantissaBits > 23 || exponentBits > 8) {
        return NaN; // Too many bits to simulate!
    }
    if (isNaN(src)) {
        return NaN;
    }

    // Note that Math.pow is specified to return an implementation-dependent approximation,
    // but works well enough in practice to be used here for powers of two.
    var possibleMantissas = Math.pow(2, mantissaBits);
    var mantissaMax = 2.0 - 1.0 / possibleMantissas;
    var max = Math.pow(2, maxNormalExponent(exponentBits)) * mantissaMax; // value with all exponent bits 1 is special
    if (src > max) {
        if (clampToInf) {
            return Infinity;
        } else {
            return max;
        }
    }
    if (src < -max) {
        if (clampToInf) {
            return -Infinity;
        } else {
            return -max;
        }
    }

    var parts = getNumberParts(src);
    // TODO: Customizable rounding (this is now round-to-zero)
    var mantissaRounded = Math.floor(parts.mantissa * possibleMantissas) / possibleMantissas;
    if (parts.exponent + exponentBias(exponentBits) <= 0) {
        if (flushSubnormal) {
            return (parts.sign ? -0 : 0);
        } else {
            while (parts.exponent + exponentBias(exponentBits) <= 0) {
                parts.exponent += 1;
                mantissaRounded = Math.floor(mantissaRounded / 2 * possibleMantissas) / possibleMantissas;
                if (mantissaRounded === 0) {
                    return (parts.sign ? -0 : 0);
                }
            }
        }
    }
    return (parts.sign ? -1 : 1) * Math.pow(2, parts.exponent) * mantissaRounded;
};

/**
 * Check if the number would be subnormal in a floating point representation
 * that has the specified bit counts for mantissa and exponent. Works for
 * formats up to 8 exponent bits and 23 mantissa bits.
 *
 * @param {number} src Number to check.
 * @param {number} mantissaBits How many bits to use for mantissa.
 * @param {number} exponentBits How many bits to use for exponent.
 */
var isSubnormal = function(src, mantissaBits, exponentBits) {
    return (!isNaN(src) &&
            froundBits(src, mantissaBits, exponentBits, false, true) !=
            froundBits(src, mantissaBits, exponentBits, false, false));
};

/**
 * Round the parameter as if it was stored in a fixed-point format similar to minimum requirements of lowp in ESSL.
 * Clamps to maximum/minimum value given in absMax.
 * @param {number} src Number to convert.
 * @param {number} fractBits How many bits to use for the fractional part after the decimal point.
 * @param {number} absMax Maximum value to clamp to.
 * @return {number} Converted number.
 */
var froundFixedPoint = function(src, fractBits, absMax) {
    if (src > absMax) {
        return absMax;
    }
    if (src < -absMax) {
        return -absMax;
    }
    var mult = Math.pow(2, fractBits);
    return Math.floor(src * mult) / mult;
};

/**
 * Context for performing floating-point calculations at the specified precision.
 * @param {number} mantissaBits How many bits to use for mantissa.
 * @param {number} exponentBits How many bits to use for exponent.
 * @param {boolean} clampToInf Set true to clamp to infinity (instead of the maximum or minimum value supported).
 * @param {boolean} flushSubnormal Set true to flush subnormal numbers to 0 (instead of keeping subnormal values)
 */
var FloatContext = function(mantissaBits, exponentBits, clampToInf, flushSubnormal) {
    this.fr = function(x) {
        return froundBits(x, mantissaBits, exponentBits, clampToInf, flushSubnormal);
    };
    this.getSpecString = function() {
        return "Mantissa: " + mantissaBits + " bits, exponent: " + exponentBits + " bits, Clamp to infinity: " + clampToInf;
    };
    this.getShaderPrecisionFormat = function() {
        return {
            rangeMin: maxNormalExponent(exponentBits),
            rangeMax: maxNormalExponent(exponentBits),
            precision: mantissaBits
        }
    };
    this.isSubnormal = function(x) {
        return isSubnormal(x, mantissaBits, exponentBits);
    };
    this.toBitStrings = function(original) {
        var x = this.fr(original);
        var parts = getNumberParts(x);
        var exponentBitRepr = (parts.exponent + exponentBias(exponentBits)).toString(2);
        var mantissaBitRepr = (parts.mantissa * Math.pow(2, mantissaBits)).toString(2).substring(1);
        var isZero = parts.exponent === -1023;
        if (isZero) {
            exponentBitRepr = '';
            mantissaBitRepr = '';
        }
        while (exponentBitRepr.length < exponentBits) {
            exponentBitRepr = '0' + exponentBitRepr;
        }
        while (mantissaBitRepr.length < mantissaBits) {
            mantissaBitRepr = '0' + mantissaBitRepr;
        }
        return {
            sign: String(parts.sign),
            exponent: exponentBitRepr,
            mantissa: mantissaBitRepr,
            possibleMantissas: Math.pow(2, mantissaBits),
            exponentBias: exponentBias(exponentBits).toString(2),
            isZero: isZero
        };
    };
    this.nanBitString = function() {
        var bitString = '';
        while (bitString.length < exponentBits + mantissaBits + 1) {
            bitString += '1';
        }
        return bitString;
    };
};

/**
 * Context for performing floating-point calculations at the specified precision.
 * @param {number} fractBits How many bits to use for the fractional part after the decimal point.
 * @param {number} absMax Maximum value to clamp to.
 */
FloatContextFixedPoint = function(fractBits, absMax) {
    this.fr = function(x) {
        return froundFixedPoint(x, fractBits, absMax);
    };
    this.getSpecString = function() {
        return "Fractional part: " + fractBits + " bits, max value: " + absMax;
    };
    this.getShaderPrecisionFormat = function() {
        return {
            rangeMin: absMax,
            rangeMax: absMax,
            precision: 0
        }
    };
};

FloatContext.functions1 = ['abs', 'sign', 'floor', 'ceil', 'fract', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'sin', 'cos', 'tan', 'asin', 'acos'];
FloatContext.functions2 = ['add', 'subtract', 'multiply', 'divide', 'pow', 'mod'];

FloatContext.prototype = {
    add: function(x, y) {
        return this.fr(this.fr(x) + this.fr(y));
    },
    subtract: function(x, y) {
        return this.fr(this.fr(x) - this.fr(y));
    },
    multiply: function(x, y) {
        return this.fr(this.fr(x) * this.fr(y));
    },
    divide: function(x, y) {
        return this.fr(this.fr(x) / this.fr(y));
    },
    fract: function(x) {
        return this.fr(this.fr(x) - this.floor(x));
    },
    exp2: function(x) {
        return this.fr(Math.pow(2, this.fr(x)));
    },
    log2: function(x) {
        return this.fr(Math.log(this.fr(x)) / Math.LN2);
    },
    mod: function(x, y) {
        x = this.fr(x);
        y = this.fr(y);
        return this.fr(x - this.fr(y * this.floor(this.fr(x/y))));
    },
    sign: function(x) {
        if (isNaN(x)) {
            return NaN;
        } else if (x === 0) {
            return 0;
        } else {
            return x > 0 ? 1.0 : -1.0;
        }
    }
};

/**
 * Add a function to FloatContext.prototype using a function with that name in
 * Math, wrapping its arguments and result to this.fr().
 *
 * @param {string} fnName Name of the function in FloatContext.prototype.
 */
var emulateWithJSMathIfNeeded = function(fnName) {
    if (!FloatContext.prototype.hasOwnProperty(fnName) && Math.hasOwnProperty(fnName)) {
        FloatContext.prototype[fnName] = function(x) {
            for (var i = 0; i < arguments.length; ++i) {
                arguments[i] = this.fr(arguments[i]);
            }
            return this.fr(Math[fnName].apply(Math, arguments));
        }
    }
};

for (var i = 0; i < FloatContext.functions1.length; ++i) {
    emulateWithJSMathIfNeeded(FloatContext.functions1[i]);
};

for (var i = 0; i < FloatContext.functions2.length; ++i) {
    emulateWithJSMathIfNeeded(FloatContext.functions2[i]);
};

for (var fName in FloatContext.prototype) {
    if (FloatContext.prototype.hasOwnProperty(fName)) {
        FloatContextFixedPoint.prototype[fName] = FloatContext.prototype[fName];
    }
}
