import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDB() {
  try {
    console.log('Connecting to database...');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = await fs.readFile(schemaPath, 'utf-8');

    console.log('Executing schema...');
    await pool.query(sql);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
  } finally {
    await pool.end();
  }
}

initDB();