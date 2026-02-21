
export enum Rounding {
  ROUND_DOWN,
  ROUND_HALF_UP,
  ROUND_UP,
}

export class Fraction {
  public readonly numerator: bigint;
  public readonly denominator: bigint;

  constructor(numerator: bigint | number | string, denominator: bigint | number | string = 1n) {
    this.numerator = BigInt(numerator);
    this.denominator = BigInt(denominator);
  }

  // performs floor division
  public get quotient(): bigint {
    return this.numerator / this.denominator;
  }

  // remainder after floor division
  public get remainder(): Fraction {
    return new Fraction(this.numerator % this.denominator, this.denominator);
  }

  public invert(): Fraction {
    return new Fraction(this.denominator, this.numerator);
  }

  public add(other: Fraction | bigint | number | string): Fraction {
    const otherParsed = other instanceof Fraction ? other : new Fraction(BigInt(other));
    if (this.denominator === otherParsed.denominator) {
      return new Fraction(this.numerator + otherParsed.numerator, this.denominator);
    }
    return new Fraction(
      this.numerator * otherParsed.denominator + otherParsed.numerator * this.denominator,
      this.denominator * otherParsed.denominator
    );
  }

  public sub(other: Fraction | bigint | number | string): Fraction {
    const otherParsed = other instanceof Fraction ? other : new Fraction(BigInt(other));
    if (this.denominator === otherParsed.denominator) {
      return new Fraction(this.numerator - otherParsed.numerator, this.denominator);
    }
    return new Fraction(
      this.numerator * otherParsed.denominator - otherParsed.numerator * this.denominator,
      this.denominator * otherParsed.denominator
    );
  }

  public multiply(other: Fraction | bigint | number | string): Fraction {
    const otherParsed = other instanceof Fraction ? other : new Fraction(BigInt(other));
    return new Fraction(
      this.numerator * otherParsed.numerator,
      this.denominator * otherParsed.denominator
    );
  }

  public divide(other: Fraction | bigint | number | string): Fraction {
    const otherParsed = other instanceof Fraction ? other : new Fraction(BigInt(other));
    return new Fraction(
      this.numerator * otherParsed.denominator,
      this.denominator * otherParsed.numerator
    );
  }

  public toSignificant(
    significantDigits: number,
    _format: { groupSeparator?: string } = { groupSeparator: '' },
    rounding: Rounding = Rounding.ROUND_HALF_UP
  ): string {
    if (significantDigits < 0) {
      throw new Error(`${significantDigits} is not a valid significant digits.`);
    }

    if (this.numerator === 0n) {
      return '0';
    }

    const isNegative = (this.numerator < 0n) !== (this.denominator < 0n);
    const numerator = this.numerator < 0n ? -this.numerator : this.numerator;
    const denominator = this.denominator < 0n ? -this.denominator : this.denominator;

    // Scale up to ensure enough precision for significant digits
    // We want to find a power p such that numerator * 10^p / denominator has significantDigits digits.
    
    // First, let's find the approximate order of magnitude.
    // We can do this by string length of numerator vs denominator as a heuristic,
    // but precision requires care.
    
    // Let's implement a loop to scale `numerator` until quotient has enough digits.
    // 1. If numerator < denominator, we need to multiply numerator by 10 until it's >= denominator.
    //    Keep track of how many 10s we multiplied (leading zeros).
    // 2. Once numerator >= denominator, we have integer digits.
    //    We need `significantDigits` total digits.
    //    Multiply numerator by 10^(significantDigits - existingDigits) if needed.
    
    let n = numerator;
    let d = denominator;
    let shift = 0; // Tracks decimal place shift (positive means moving decimal right, i.e. result < 1)
    
    // Case 1: Result < 1 (numerator < denominator)
    if (n < d) {
      // Multiply n by 10 until n >= d/10 (roughly) to find first significant digit
      // Actually simpler: multiply until n >= d.
      while (n < d) {
        n *= 10n;
        shift++;
      }
      // Now n >= d. The result is roughly 1.something... to 9.something...
      // We have 1 significant digit (the first non-zero digit).
      // We need `significantDigits - 1` more digits.
      // So multiply n by 10^(significantDigits - 1).
      
      const power = significantDigits - 1;
      if (power > 0) {
        n *= 10n ** BigInt(power);
      }
      
      // Perform division with rounding
      const quotient = this.divideWithRounding(n, d, rounding);
      let str = quotient.toString();
      
      // If rounding caused overflow (e.g. 99 -> 100), str.length might increase.
      // The `shift` was calculated based on finding the first non-zero digit.
      
      if (str.length > significantDigits) {
        // e.g. 99 (2 sig) -> 100.
        // It means we are effectively 0.10 instead of 0.099
        // The shift effectively decreases by 1.
        shift--;
        // Truncate the last digit to match significant digits
        str = str.slice(0, significantDigits);
      }
      
      // Format: "0." + (shift - 1 zeros) + str
      // If shift <= 0 (due to rounding overflow adjustment), it means >= 1.
      if (shift > 0) {
        const zeros = '0'.repeat(shift - 1);
        // Insert decimal point inside str if needed? No, str contains the significant digits as integer.
        // Wait, if shift=1 (0.1..), zeros=0. "0." + str.
        // But str might be "123" (3 sigs). -> "0.123". Correct.
        return (isNegative ? '-' : '') + '0.' + zeros + str;
      } else {
        // shift <= 0 means we crossed 1.0 boundary.
        // e.g. 0.99 -> 1.0 (2 sigs). shift was 1, became 0.
        // We have str="100" (sig=2 -> 3 digits? No).
        // If sig=2, 0.999 -> 1.0.
        // n=999. d=1000. shift=1.
        // n*10 = 9990. div=9 (sig=1).
        // Let's re-verify logic.
        
        // This logic is tricky. Let's rely on standard `toPrecision` behavior of Number if possible for formatting,
        // but we want arbitrary precision intermediate.
        
        // Let's use string manipulation based on `shift`.
        // The value is `str * 10^(-shift - (significantDigits - 1))`.
        // Because we multiplied n by 10^shift * 10^(sig-1).
        // Actually we multiplied n by 10^shift then 10^(sig-1).
        // So value = quotient / 10^(shift + sig - 1).
        
        const totalDecimalPlaces = shift + significantDigits - 1;
        // Place decimal point `totalDecimalPlaces` from the right.
        
        const len = str.length;
        const decimalPos = len - totalDecimalPlaces;
        
        if (decimalPos <= 0) {
           const zeros = '0'.repeat(-decimalPos);
           return (isNegative ? '-' : '') + '0.' + zeros + str;
        } else if (decimalPos >= len) {
           return (isNegative ? '-' : '') + str + '0'.repeat(decimalPos - len);
        } else {
           return (isNegative ? '-' : '') + str.slice(0, decimalPos) + '.' + str.slice(decimalPos);
        }
      }
    } else {
      // Case 2: Result >= 1
      // Find integer digits count
      let intDigits = 0;
      // Heuristic to find digits: while tempN >= d, divide by 10?
      // No, that's slow for big numbers.
      // Use string length approx.
      const nStr = n.toString();
      const dStr = d.toString();
      intDigits = nStr.length - dStr.length;
      
      // Refine intDigits
      // if n < d * 10^intDigits, then intDigits is correct?
      // Check boundaries.
      // e.g. 100/10 = 10 (2 digits). len(100)-len(10)=1. Incorrect.
      // e.g. 90/10 = 9 (1 digit). len(90)-len(10)=0. Correct.
      // So intDigits is approx `len(n) - len(d)`.
      // Let's verify by checking `d * 10^(k)`
      
      let scale = 10n ** BigInt(Math.max(0, intDigits));
      if (n < d * scale) {
        // overestimated
      } else if (n >= d * scale * 10n) {
        intDigits++;
      } else {
        intDigits++; // It is at least 1 since n >= d
      }
      
      // Wait, let's just use string length of quotient approximation?
      // Or just standard BigInt division if it's not too huge?
      // We assume reasonable numbers for SDK.
      
      // Let's stick to scaling n to get `significantDigits`.
      // We need quotient to have `significantDigits` digits.
      // Current digits ~ intDigits.
      
      // If intDigits < significantDigits:
      // We need to shift left (multiply n) by `significantDigits - intDigits`.
      if (intDigits < significantDigits) {
        const power = significantDigits - intDigits;
        n *= 10n ** BigInt(power);
        
        const quotient = this.divideWithRounding(n, d, rounding);
        let str = quotient.toString();
        
        // If rounding increased digits (99->100), adjust decimal place
        // value = quotient / 10^power
        let decimalPos = str.length - power;
        
        if (str.length > significantDigits) {
            str = str.slice(0, significantDigits);
            // Decimal position is relative to the start, so it stays valid
            // unless we truncated before the decimal point?
            // e.g. 99.9 -> 100. pos=2 (10.0).
            // str -> 10. pos=2. Result 10. Correct.
        }

        if (decimalPos >= str.length) {
            return (isNegative ? '-' : '') + str;
        }
        return (isNegative ? '-' : '') + str.slice(0, decimalPos) + '.' + str.slice(decimalPos);
      } else {
        // intDigits >= significantDigits
        // We need to shift right (divide quotient) or round at specific place.
        // We want only first `significantDigits` of the integer part, rest zeros.
        // e.g. 12345, 2 sig -> 12000.
        
        // Scale down n or d?
        // Better to calculate quotient then round?
        // If quotient is huge, we lose precision if we divide n before.
        
        // Strategy: Calculate full integer quotient, then round string?
        // Or scale d up?
        // n / (d * 10^(intDigits - significantDigits))
        
        const power = intDigits - significantDigits;
        const scale = 10n ** BigInt(power);
        const scaledD = d * scale;
        
        const quotient = this.divideWithRounding(n, scaledD, rounding);
        let str = quotient.toString();
        
        // Pad with zeros
        // value = quotient * 10^power
        return (isNegative ? '-' : '') + str + '0'.repeat(power);
      }
    }
  }

  public toFixed(
    decimalPlaces: number,
    _format: { groupSeparator?: string } = { groupSeparator: '' },
    rounding: Rounding = Rounding.ROUND_HALF_UP
  ): string {
    if (decimalPlaces < 0) {
       throw new Error(`${decimalPlaces} is not a valid decimal places.`);
    }

    const scale = 10n ** BigInt(decimalPlaces);
    const n_scaled = this.numerator * scale;
    const quotient = this.divideWithRounding(n_scaled, this.denominator, rounding);
    
    let str = quotient.toString();
    const isNegative = str.startsWith('-');
    if (isNegative) str = str.slice(1);
    
    // Pad if necessary
    while (str.length <= decimalPlaces) {
      str = '0' + str;
    }
    
    const decimalPos = str.length - decimalPlaces;
    const intPart = str.slice(0, decimalPos);
    const fracPart = str.slice(decimalPos);
    
    const result = decimalPlaces > 0 ? `${intPart}.${fracPart}` : intPart;
    return isNegative ? '-' + result : result;
  }

  private divideWithRounding(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    
    if (remainder === 0n) return quotient;
    
    const numAbs = numerator < 0n ? -numerator : numerator;
    const denAbs = denominator < 0n ? -denominator : denominator;
    const remAbs = remainder < 0n ? -remainder : remainder;
    
    let increment = 0n;
    
    switch (rounding) {
      case Rounding.ROUND_DOWN:
        break;
      case Rounding.ROUND_UP:
        if (remAbs > 0n) increment = 1n;
        break;
      case Rounding.ROUND_HALF_UP:
        if (remAbs * 2n >= denAbs) increment = 1n;
        break;
    }
    
    const isPositive = (numerator >= 0n) === (denominator >= 0n);
    if (isPositive) {
      return (numAbs / denAbs) + increment;
    } else {
      return -((numAbs / denAbs) + increment);
    }
  }
}

export class Percent extends Fraction {
  private static ONE_HUNDRED = new Fraction(100n);

  public toSignificant(
    significantDigits: number = 5,
    format?: { groupSeparator?: string },
    rounding?: Rounding
  ): string {
    return this.multiply(Percent.ONE_HUNDRED).toSignificant(significantDigits, format, rounding);
  }

  public toFixed(
    decimalPlaces: number = 2,
    format?: { groupSeparator?: string },
    rounding?: Rounding
  ): string {
    return this.multiply(Percent.ONE_HUNDRED).toFixed(decimalPlaces, format, rounding);
  }
}
