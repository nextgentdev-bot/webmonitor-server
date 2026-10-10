import app from './index.js';
import { connectDatabase } from './db.js';

export default async function handler(request, response) {
  try {
    const pathname = new URL(request.url, 'https://vercel.invalid').pathname;
    if (pathname !== '/' && pathname !== '/api/health') await connectDatabase();
    return app(request, response);
  } catch (error) {
    console.error('Vercel API initialization failed:', error);
    return response.status(503).json({ error: 'Database unavailable. Check MONGODB_URI and MongoDB Atlas network access.' });
  }
}
