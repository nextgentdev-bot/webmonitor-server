import mongoose from 'mongoose';

const websiteSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, index: true },
  lastCheck: { type: mongoose.Schema.Types.ObjectId, ref: 'Check', default: null }
}, { timestamps: true });

const checkSchema = new mongoose.Schema({
  run: { type: mongoose.Schema.Types.ObjectId, ref: 'Run', required: true, index: true },
  website: { type: mongoose.Schema.Types.ObjectId, ref: 'Website', required: true, index: true },
  status: { type: String, enum: ['pending', 'processing', 'healthy', 'warning', 'critical', 'cancelled'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  progressPercent: { type: Number, default: 0 },
  progressStage: { type: String, default: 'Queued' },
  scheduledAt: { type: Date, default: Date.now },
  lockedAt: Date,
  lockedBy: String,
  startedAt: Date,
  finishedAt: Date,
  homepage: { statusCode: Number, loadTimeMs: Number, sslValid: Boolean, blank: Boolean, finalUrl: String, error: String },
  desktop: { contact: Object, news: Object },
  mobile: { contact: Object, news: Object },
  issues: [String],
  screenshots: [String],
  rawResult: mongoose.Schema.Types.Mixed,
  errorSummary: String
}, { timestamps: true });

checkSchema.index({ run: 1, status: 1 });

const runSchema = new mongoose.Schema({
  type: { type: String, enum: ['manual', 'daily'], default: 'manual' },
  status: { type: String, enum: ['running', 'completed', 'failed', 'cancelled'], default: 'running', index: true },
  total: { type: Number, default: 0 }, completed: { type: Number, default: 0 }, healthy: { type: Number, default: 0 }, warning: { type: Number, default: 0 }, critical: { type: Number, default: 0 },
  localRunDate: String, notificationSent: { type: Boolean, default: false }, startedAt: { type: Date, default: Date.now }, finishedAt: Date
}, { timestamps: true });

const settingSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: String }, { timestamps: true });

export const Website = mongoose.model('Website', websiteSchema);
export const Check = mongoose.model('Check', checkSchema);
export const Run = mongoose.model('Run', runSchema);
export const Setting = mongoose.model('Setting', settingSchema);
