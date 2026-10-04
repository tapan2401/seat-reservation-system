import { z } from 'zod';

export const createShowSchema = z.object({
  name: z.string().min(1),
  price_paise: z.number().int().positive(),
  seats: z.array(z.string().min(1)).min(1)
});

export const reserveSeatSchema = z.object({
  seats: z.array(z.string().min(1)).min(1),
  idempotency_key: z.string().min(1)
});