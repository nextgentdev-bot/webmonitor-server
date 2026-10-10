import mongoose from 'mongoose';
import { config } from './config.js';

let connectionPromise;

export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(config.mongoUri)
      .then((connection) => {
        console.log(`MongoDB connected: ${mongoose.connection.name}`);
        return connection;
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }
  return connectionPromise;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
