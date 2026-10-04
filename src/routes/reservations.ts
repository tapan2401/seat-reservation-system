import { Router, Response, NextFunction } from 'express';
import { pool } from '../db/index.js';
import { AppRequest } from '../types.js';
import { requireAuth } from '../middlewares/auth.js';
import { updateSeatsAvailableGauge } from '../utils/metrics.js';
import { ReservationStatus, SeatStatus } from '../constants/enums.js';

export const reservationsRouter = Router();

// POST /reservations/:id/cancel
reservationsRouter.post('/:id/cancel', requireAuth, async (req: AppRequest, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const reservationId = req.params.id;
    const userId = req.user!.id;

    await client.query('BEGIN');

    const resCheck = await client.query(
      `SELECT show_id FROM reservations 
       WHERE id = $1 AND user_id = $2 AND status = $3 
       FOR UPDATE`,
      [reservationId, userId, ReservationStatus.CONFIRMED]
    );

    if (resCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Not Found', message: 'Active reservation not found or unauthorized' });
      return;
    }

    const showId = resCheck.rows[0].show_id;

    await client.query(
      `UPDATE reservations SET status = $1 WHERE id = $2`,
      [ReservationStatus.CANCELLED, reservationId]
    );

    await client.query(
      `UPDATE show_seats SET status = $1, reservation_id = NULL 
       WHERE reservation_id = $2`,
      [SeatStatus.AVAILABLE, reservationId]
    );

    await client.query('COMMIT');

    updateSeatsAvailableGauge(showId).catch(console.error);

    res.status(200).json({ message: 'Reservation cancelled successfully' });

  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});