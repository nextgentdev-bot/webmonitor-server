import app from './index.js';
import { connectDatabase } from './db.js';

export default async function handler(request, response) {
  try {
    await connectDatabase();
    return app(request, response);
  } catch (error) {
    console.error('Vercel API initialization failed:', error);
    return response.status(500).json({ error: 'API initialization failed.' });
  }
}
