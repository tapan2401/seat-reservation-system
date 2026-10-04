import { Router, Response, NextFunction } from 'express';
import { pool } from '../db/index.js';
import { AppRequest } from '../types.js';
import { requireAdmin, requireAuth } from '../middlewares/auth.js';
import { checkIdempotency } from '../middlewares/idempotency.js';
import { createShowSchema, reserveSeatSchema } from '../schemas.js';
import { logger } from '../utils/logger.js';
import { ReservationStatus, SeatStatus } from '../constants/enums.js';
import {
  reservationsConfirmedTotal,
  reservationsDeclinedTotal,
  updateSeatsAvailableGauge
} from '../utils/metrics.js';

export const showsRouter = Router();

// POST /shows/
showsRouter.post('/', requireAuth, requireAdmin, async (req: AppRequest, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const validated = createShowSchema.parse(req.body);

    await client.query('BEGIN');

    const showResult = await client.query(
      `INSERT INTO shows (name, price_paise) VALUES ($1, $2) RETURNING *`,
      [validated.name, validated.price_paise]
    );
    const show = showResult.rows[0];

    await client.query(
      `INSERT INTO show_seats (show_id, seat_number)
       SELECT $1, unnest($2::text[])`,
      [show.id, validated.seats]
    );

    await client.query('COMMIT');
    res.status(201).json({ id: show.id, name: show.name, total_seats: validated.seats.length });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// POST /shows/:id/reserve
showsRouter.post('/:id/reserve', requireAuth, checkIdempotency, async (req: AppRequest, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const validated = reserveSeatSchema.parse(req.body);
    const showId = req.params.id as string;
    const userId = req.user!.id;
    const reqId = req.id;
    const requestHash = (req as any).requestHash;

    const sortedSeats = [...validated.seats].sort();
    const requestedSeatCount = sortedSeats.length;

    await client.query('BEGIN');

    // advisory lock to prevent race condition between two transactions from same user for same show
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))`,
      [userId, showId]
    );

    // re-check idempotency to catch races that bypassed the middleware and prevent already booked error
    const idemCheck = await client.query(
      `SELECT response_status, response_body 
       FROM idempotency_records 
       WHERE key = $1`,
      [validated.idempotency_key]
    );
    if (idemCheck.rowCount && idemCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      res.setHeader('X-Idempotency-Cache', 'HIT');
      res.status(idemCheck.rows[0].response_status).json(idemCheck.rows[0].response_body);
      return;
    }


    const showInfo = await client.query(`SELECT per_user_limit, price_paise FROM shows WHERE id = $1`, [showId]);
    if (showInfo.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Not Found' }); return;
    }

    const limit = showInfo.rows[0].per_user_limit;
    const price = showInfo.rows[0].price_paise;

    const currentHolds = await client.query(
      `SELECT COUNT(*) as count FROM reservations WHERE show_id = $1 AND user_id = $2 AND status = $3`,
      [showId, userId, ReservationStatus.CONFIRMED]
    );
    const totalHeld = parseInt(currentHolds.rows[0].count, 10);

    if (totalHeld + requestedSeatCount > limit) {
      logger.info({ reqId, userId, showId }, 'User limit exceeded');
      reservationsDeclinedTotal.inc({ reason: 'USER_LIMIT_EXCEEDED' });
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Conflict', reason: 'USER_LIMIT_EXCEEDED' });
      return;
    }

    // get the seats and lock them
    const seatCheck = await client.query(
      `SELECT id, seat_number, status 
       FROM show_seats 
       WHERE show_id = $1 AND seat_number = ANY($2::text[])
       ORDER BY seat_number ASC
       FOR UPDATE`,
      [showId, sortedSeats]
    );

    // check if any seats don't exist
    if (seatCheck.rowCount !== requestedSeatCount) {
      const foundSeats = new Set(seatCheck.rows.map(row => row.seat_number));
      const missingSeats = sortedSeats.filter(seat => !foundSeats.has(seat));

      logger.warn({ reqId, missingSeats }, 'Requested seats do not exist in this show');
      await client.query('ROLLBACK');
      res.status(400).json({
        error: 'Bad Request',
        reason: 'SEATS_NOT_FOUND',
        message: `The following seats do not exist: ${missingSeats.join(', ')}`
      });
      return;
    }

    // check if any seats are already reserved
    const unavailableSeats = seatCheck.rows
      .filter(row => row.status !== SeatStatus.AVAILABLE)
      .map(row => row.seat_number);

    if (unavailableSeats.length > 0) {
      logger.info({ reqId, unavailableSeats }, 'Seats already taken');
      reservationsDeclinedTotal.inc({ reason: 'SEAT_ALREADY_TAKEN' });
      await client.query('ROLLBACK');
      res.status(409).json({
        error: 'Conflict',
        reason: 'SEAT_ALREADY_TAKEN',
        message: `The following seats are no longer available: ${unavailableSeats.join(', ')}`
      });
      return;
    }

    const totalAmount = price * requestedSeatCount;
    const resInsert = await client.query(
      `INSERT INTO reservations (show_id, user_id, amount_paise) 
       VALUES ($1, $2, $3) RETURNING id`,
      [showId, userId, totalAmount]
    );
    const reservationId = resInsert.rows[0].id;

    await client.query(
      `UPDATE show_seats SET status = $1, reservation_id = $2 
       WHERE show_id = $3 AND seat_number = ANY($4::text[])`,
      [SeatStatus.CONFIRMED, reservationId, showId, sortedSeats]
    );

    const responsePayload = {
      reservation_id: reservationId,
      show_id: showId,
      user_id: userId,
      seats: sortedSeats,
      amount_paise: totalAmount,
      status: ReservationStatus.CONFIRMED
    };

    // insert into idempotency_records
    await client.query(
      `INSERT INTO idempotency_records 
       (key, user_id, show_id, request_hash, response_status, response_body) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [validated.idempotency_key, userId, showId, requestHash, 201, responsePayload]
    );

    await client.query('COMMIT');

    reservationsConfirmedTotal.inc();
    updateSeatsAvailableGauge(showId).catch(console.error);

    res.status(201).json(responsePayload);

  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// GET /shows/:id
showsRouter.get('/:id', async (req: AppRequest, res: Response, next: NextFunction) => {
  try {
    const showId = req.params.id;
    const showResult = await pool.query(`SELECT id, name, price_paise FROM shows WHERE id = $1`, [showId]);

    if (showResult.rowCount === 0) {
      res.status(404).json({ error: 'Show not found' });
      return;
    }

    const statsResult = await pool.query(
      `SELECT status, count(*) as count 
       FROM show_seats 
       WHERE show_id = $1 
       GROUP BY status`,
      [showId]
    );

    let availableCount = 0;
    let confirmedCount = 0;

    statsResult.rows.forEach(row => {
      const count = parseInt(row.count, 10);
      if (row.status === SeatStatus.AVAILABLE) availableCount = count;
      if (row.status === SeatStatus.CONFIRMED) confirmedCount = count;
    });

    const totalSeats = availableCount + confirmedCount;

    res.status(200).json({
      show: showResult.rows[0],
      reconciliation: {
        available: availableCount,
        confirmed: confirmedCount,
        total_seats: totalSeats,
        is_valid: (availableCount + confirmedCount) === totalSeats
      }
    });

  } catch (error) {
    next(error);
  }
});