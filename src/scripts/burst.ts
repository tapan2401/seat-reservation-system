import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SHOW_NAME = `Friday Night Live - ${Date.now()}`;

const ROWS = parseInt(process.env.BURST_TOTAL_ROWS || '5', 10);
const COLS = parseInt(process.env.BURST_SEATS_PER_ROW || '10', 10);
const HOT_SEAT_USERS = parseInt(process.env.BURST_HOT_SEAT_USERS || '50', 10);
const QUOTA_REQUESTS = parseInt(process.env.BURST_QUOTA_USER_REQUESTS || '10', 10);
const RANDOM_USERS = parseInt(process.env.BURST_RANDOM_USERS || '100', 10);
const BATCH_SIZE = 200;

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// helper to split array into chunks to prevent Node OOM
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunked: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunked.push(array.slice(i, i + size));
  }
  return chunked;
}

async function runBurst() {
  log('Starting Concurrency Burst Test');

  // Generate Seat Layout (A1...A10, B1...B10)
  const allSeats: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const rowChar = String.fromCharCode(65 + r);
    for (let c = 1; c <= COLS; c++) {
      allSeats.push(`${rowChar}${c}`);
    }
  }

  if (allSeats.length < 20) {
    throw new Error("Please configure at least 20 seats for tests to run properly.");
  }

  // Create the Show
  const showRes = await fetch(`${BASE_URL}/shows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer admin_1' },
    body: JSON.stringify({ name: SHOW_NAME, price_paise: 25000, seats: allSeats }),
  });

  if (!showRes.ok) throw new Error(`Failed to create show: ${await showRes.text()}`);
  const show = await showRes.json();
  log(`Created show ID: ${show.id} with ${allSeats.length} seats (${ROWS} rows x ${COLS} cols)`);

  const requests: any[] = [];

  // CASE 1: The Hot Seat Contention
  const hotSeat = allSeats[0];
  for (let i = 0; i < HOT_SEAT_USERS; i++) {
    requests.push({
      token: `user_hot_seat_${i}`,
      payload: { seats: [hotSeat], idempotency_key: crypto.randomUUID() },
      label: 'Hot Seat Race',
    });
  }

  // CASE 2: Quota Bypass Attempt
  const quotaToken = 'greedy_user';
  for (let i = 0; i < QUOTA_REQUESTS; i++) {
    requests.push({
      token: quotaToken,
      payload: { seats: [allSeats[i + 1]], idempotency_key: crypto.randomUUID() },
      label: 'Quota Bypass',
    });
  }

  // CASE 3: Idempotency
  const replayToken = 'flaky_user';
  const replayKey = crypto.randomUUID();
  for (let i = 0; i < 5; i++) {
    requests.push({
      token: replayToken,
      payload: { seats: [allSeats[15]], idempotency_key: replayKey },
      label: 'Idempotency Cache',
    });
  }

  // CASE 4: Idempotency Payload
  const swapToken = 'hacker_user';
  const swapKey = crypto.randomUUID();
  requests.push({
    token: swapToken,
    payload: { seats: [allSeats[16]], idempotency_key: swapKey },
    label: 'Idempotency Swap (Req A)',
  });
  requests.push({
    token: swapToken,
    payload: { seats: [allSeats[17]], idempotency_key: swapKey },
    label: 'Idempotency Swap (Req B)',
  });

  // CASE 5: All or Nothing Multi-Seat Rollback
  requests.push({
    token: 'group_user',
    payload: { seats: [allSeats[18], hotSeat], idempotency_key: crypto.randomUUID() },
    label: 'Multi-Seat Rollback',
  });

  // CASE 6: Non-Existent Seats
  requests.push({
    token: 'confused_user',
    payload: { seats: ['Z99', 'Z100'], idempotency_key: crypto.randomUUID() },
    label: 'Non-Existent Seat',
  });

  // CASE 7: Random General Load
  for (let i = 0; i < RANDOM_USERS; i++) {
    const randomSeatCount = Math.floor(Math.random() * 3) + 1;
    const chosenSeats = new Set<string>();
    while (chosenSeats.size < randomSeatCount) {
      const randIndex = Math.floor(Math.random() * (allSeats.length - 20)) + 20;
      chosenSeats.add(allSeats[randIndex]);
    }

    requests.push({
      token: `random_user_${i}`,
      payload: { seats: Array.from(chosenSeats).sort(), idempotency_key: crypto.randomUUID() },
      label: 'Random Load',
    });
  }

  requests.sort(() => Math.random() - 0.5);

  log(`Firing ${requests.length} concurrent requests in batches of ${BATCH_SIZE}...`);

  const startTime = Date.now();
  const results: any[] = [];
  const batches = chunkArray(requests, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchResults = await Promise.allSettled(
      batch.map((req) =>
        fetch(`${BASE_URL}/shows/${show.id}/reserve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.token}` },
          body: JSON.stringify(req.payload),
        }).then(async (res) => {
          const isCached = res.headers.get('X-Idempotency-Cache') === 'HIT';
          return {
            status: res.status,
            label: req.label,
            isCached,
            body: await res.json(),
          }
        })
      )
    );
    results.push(...batchResults);
    process.stdout.write(`\rProcessed batch ${i + 1}/${batches.length}...`);
  }
  
  console.log();
  const duration = Date.now() - startTime;
  log(`Burst finished in ${duration}ms (${Math.round(requests.length / (duration / 1000))} req/sec)`);

  const stats = {
    '201 (New Reservation)': 0,
    '201 (Cached Replay)': 0,
    '400 (Bad Request / Missing Seat)': 0,
    '409 (Seat Taken)': 0,
    '409 (Limit Exceeded)': 0,
    '409 (Idempotency Mismatch)': 0,
    '5xx (Server Error)': 0,
    'Other': 0,
  };

  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      const res = result.value;
      if (res.status === 201 && res.isCached) stats['201 (Cached Replay)']++;
      else if (res.status === 201) stats['201 (New Reservation)']++;
      else if (res.status === 400) stats['400 (Bad Request / Missing Seat)']++;
      else if (res.status === 409 && res.body?.reason === 'SEAT_ALREADY_TAKEN') stats['409 (Seat Taken)']++;
      else if (res.status === 409 && res.body?.reason === 'USER_LIMIT_EXCEEDED') stats['409 (Limit Exceeded)']++;
      else if (res.status === 409 && res.body?.reason === 'IDEMPOTENCY_MISMATCH') stats['409 (Idempotency Mismatch)']++;
      else if (res.status >= 500) stats['5xx (Server Error)']++;
      else stats['Other']++;
    } else {
      stats['Other']++;
    }
  });

  console.table(stats);

  const stateRes = await fetch(`${BASE_URL}/shows/${show.id}`);
  const state = await stateRes.json();

  log('Final Reconciliation State:');
  console.table(state.reconciliation);

  if (state.reconciliation.is_valid && stats['5xx (Server Error)'] === 0) {
    log('TEST PASSED: Invariant holds, zero 500 errors.');
  } else {
    log('TEST FAILED: Data corruption or server errors detected.');
  }
}

runBurst().catch(console.error);