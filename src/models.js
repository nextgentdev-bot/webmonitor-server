import mongoose from 'mongoose';

// One entry per pausable check (see check-options.js). paused=false means the check runs as normal.
const pausedCheck = () => ({ paused: { type: Boolean, default: false }, reason: { type: String, trim: true, default: '' }, pausedAt: { type: Date, default: null } });

const websiteSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true },
  active: { type: Boolean, default: true },
  pauseReason: { type: String, trim: true, default: '' },
  pausedAt: { type: Date, default: null },
  // Pause only some checks (homepage, loading time, news, contact) while the website itself stays active.
  pausedChecks: { homepage: pausedCheck(), loadTime: pausedCheck(), news: pausedCheck(), contact: pausedCheck() },
  domainHosting: {
    status: { type: String, enum: ['not-checked', 'pending', 'processing', 'completed', 'failed', 'cancelled'], default: 'not-checked' },
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'DomainRun', default: null },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: '' },
    checkedAt: { type: Date, default: null },
    error: { type: String, default: '' },
    result: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  traffic: {
    status: { type: String, enum: ['not-checked', 'pending', 'processing', 'completed', 'failed', 'cancelled'], default: 'not-checked' },
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'TrafficRun', default: null },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: '' },
    checkedAt: { type: Date, default: null },
    analyticsPropertyId: { type: String, trim: true, default: '' },
    searchConsoleSiteUrl: { type: String, trim: true, default: '' },
    startDate: { type: String, default: '' },
    endDate: { type: String, default: '' },
    analytics: { type: mongoose.Schema.Types.Mixed, default: null },
    analyticsError: { type: String, default: '' },
    searchConsole: { type: mongoose.Schema.Types.Mixed, default: null },
    searchConsoleError: { type: String, default: '' }
  },
  sortOrder: { type: Number, index: true },
  lastCheck: { type: mongoose.Schema.Types.ObjectId, ref: 'Check', default: null },
  // The check whose result is already written to the Google Sheet. A website is waiting to be synced while this differs from lastCheck.
  sheetSyncedCheck: { type: mongoose.Schema.Types.ObjectId, ref: 'Check', default: null }
}, { timestamps: true });

const checkSchema = new mongoose.Schema({
  run: { type: mongoose.Schema.Types.ObjectId, ref: 'Run', required: true, index: true },
  website: { type: mongoose.Schema.Types.ObjectId, ref: 'Website', required: true, index: true },
  status: { type: String, enum: ['pending', 'processing', 'healthy', 'warning', 'critical', 'cancelled'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  progressPercent: { type: Number, default: 0 },
  mobileProgressPercent: { type: Number, default: 0 },
  progressStage: { type: String, default: 'Queued' },
  scheduledAt: { type: Date, default: Date.now },
  // 0 = normal queue. A larger number is claimed first; the newest priority batch has the largest number.
  priority: { type: Number, default: 0 },
  lockedAt: Date,
  lockedBy: String,
  startedAt: Date,
  finishedAt: Date,
  homepage: { statusCode: Number, loadTimeMs: Number, sslValid: Boolean, blank: Boolean, suspended: Boolean, verificationRequired: Boolean, finalUrl: String, error: String },
  desktop: { contact: Object, news: Object },
  mobile: { contact: Object, news: Object },
  issues: [String],
  // Checks that were paused when this result was saved.
  pausedChecks: [String],
  screenshots: [String],
  rawResult: mongoose.Schema.Types.Mixed,
  errorSummary: String
}, { timestamps: true });

checkSchema.index({ run: 1, status: 1 });

const runSchema = new mongoose.Schema({
  // 'all' = every active website, 'selected' = marked websites or a single website.
  scope: { type: String, enum: ['all', 'selected'], default: 'all' },
  status: { type: String, enum: ['running', 'completed', 'failed', 'cancelled'], default: 'running', index: true },
  total: { type: Number, default: 0 }, completed: { type: Number, default: 0 }, healthy: { type: Number, default: 0 }, warning: { type: Number, default: 0 }, critical: { type: Number, default: 0 },
  notificationSent: { type: Boolean, default: false }, startedAt: { type: Date, default: Date.now }, finishedAt: Date
}, { timestamps: true });

const settingSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: String }, { timestamps: true });

const domainRunSchema = new mongoose.Schema({
  status: { type: String, enum: ['running', 'completed', 'cancelled'], default: 'running', index: true },
  scope: { type: String, enum: ['all', 'selected'], default: 'all' },
  total: { type: Number, default: 0 },
  completed: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date
}, { timestamps: true });

const trafficRunSchema = new mongoose.Schema({
  status: { type: String, enum: ['running', 'completed', 'cancelled'], default: 'running', index: true },
  total: { type: Number, default: 0 },
  completed: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date
}, { timestamps: true });

export const Website = mongoose.model('Website', websiteSchema);
export const Check = mongoose.model('Check', checkSchema);
export const Run = mongoose.model('Run', runSchema);
export const Setting = mongoose.model('Setting', settingSchema);
export const DomainRun = mongoose.model('DomainRun', domainRunSchema);
export const TrafficRun = mongoose.model('TrafficRun', trafficRunSchema);