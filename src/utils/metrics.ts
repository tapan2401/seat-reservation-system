import client from '@prometheus-io/client';
import { pool } from '../db/index.js';
import { logger } from './logger.js';
import { SeatStatus } from '../constants/enums.js';

client.collectDefaultMetrics();

export const reservationsConfirmedTotal = new client.Counter({
  name: 'reservations_confirmed_total',
  help: 'Total number of successful reservations'
});

export const reservationsDeclinedTotal = new client.Counter({
  name: 'reservations_declined_total',
  help: 'Total number of declined reservations by reason',
  labelNames: ['reason']
});

export const seatsAvailableGauge = new client.Gauge({
  name: 'seats_available_current',
  help: 'Current number of available seats per show',
  labelNames: ['show_id']
});

export const updateSeatsAvailableGauge = async (showId: string) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM show_seats WHERE show_id = $1 AND status = $2`,
      [showId, SeatStatus.AVAILABLE]
    );
    const count = parseInt(result.rows[0].count, 10);
    seatsAvailableGauge.set({ show_id: showId }, count);
  } catch (error) {
    logger.error({ showId, error }, 'Failed to update seats available gauge');
  }
};