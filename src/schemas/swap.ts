import { z } from 'zod';
import { isValidAddress } from '../utils/addresses';
import { TradeType } from '../types/common';
import { ValidationError } from '../errors';

const stellarAddress = z.string().min(1, { message: 'must not be empty' }).refine(
  (val) => isValidAddress(val),
  (val) => ( { message: `is not a valid Stellar address: ${val}` }),
);
