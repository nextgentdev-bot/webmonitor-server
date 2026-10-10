import express from 'express';
import cors from 'cors';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';
import XLSX from 'xlsx';
import { connectDatabase } from './db.js';
import { config } from './config.js';
import { Check, Run, Setting, Website } from './models.js';
import { cancelRun, enqueueRun, runDetails } from './queue.js';
import { nameFromUrl, normalizeUrl, parseBulkText, toCsv } from './utils.js';
import { startScheduler } from './scheduler.js';

const app = express(); const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors({ origin: config.clientOrigin })); app.use(express.json({ limit: '2mb' })); app.use('/screenshots', express.static(config.screenshotDir));
function googleSheetCsvUrl(input) {
	const value = String(input || '').trim();
	const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
	if (!match) throw new Error('Paste a valid Google Sheets URL.');
	const gid = value.match(/[?#&]gid=(\d+)/)?.[1] || '0';
	return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
}
async function rowsFromGoogleSheet(input) {
	const response = await fetch(googleSheetCsvUrl(input), { redirect: 'follow' });
	if (!response.ok) throw new Error('Google Sheet could not be read. Set the sheet to Anyone with the link: Viewer.');
	const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
	const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
	return data.map((row) => ({ name: row['Website Name'] || row['website name'] || row.Name || row.name || '', url: row['Website URL'] || row['website url'] || row.URL || row.url || Object.values(row)[1] || Object.values(row)[0] || '' }));
}
const auth = (req, res, next) => { const token = req.headers.authorization?.replace('Bearer ', ''); try { req.user = jwt.verify(token, config.jwtSecret); next(); } catch { res.status(401).json({ error: 'Authentication required.' }); } };
async function failEmptyRunningRuns() {
	const runningRuns = await Run.find({ status: 'running' }).select('_id').lean();
	for (const run of runningRuns) {
		if (!await Check.exists({ run: run._id })) await Run.findOneAndUpdate({ _id: run._id, status: 'running' }, { $set: { status: 'failed', finishedAt: new Date() } });
	}
}
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.post('/api/auth/login', (req, res) => { if (req.body.username !== config.adminUser || req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid credentials.' }); res.json({ token: jwt.sign({ username: config.adminUser }, config.jwtSecret, { expiresIn: '12h' }) }); });
app.use('/api', auth);
app.get('/api/dashboard', async (req, res, next) => {
	try {
		await failEmptyRunningRuns();
		const search = String(req.query.search || '').trim();
		const query = search ? { $or: [{ name: new RegExp(search, 'i') }, { url: new RegExp(search, 'i') }] } : {};
		const [websites, total, active, latestRun, activeRun] = await Promise.all([
			Website.find(query).sort({ createdAt: -1 }).limit(config.maxWebsites).populate('lastCheck').lean(),
			Website.countDocuments(query),
			Website.countDocuments({ ...query, active: true }),
			Run.findOne().sort({ startedAt: -1 }).lean(),
			Run.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean()
		]);
		const progressRun = activeRun || latestRun;
		const runChecks = progressRun ? await Check.find({ run: progressRun._id }).select('website status startedAt progressPercent progressStage').lean() : [];
		const completedChecks = runChecks.filter((check) => ['healthy', 'warning', 'critical'].includes(check.status));
		const completed = completedChecks.length;
		const processing = runChecks.filter((check) => check.status === 'processing').length;
		const cancelled = runChecks.filter((check) => check.status === 'cancelled').length;
		const progressTotal = progressRun?.total || runChecks.length;
		const progressUnits = runChecks.reduce((sum, check) => sum + (['healthy', 'warning', 'critical'].includes(check.status) ? 100 : ['processing', 'cancelled'].includes(check.status) ? check.progressPercent || 0 : 0), 0);
		const runProgress = progressRun ? {
			runId: String(progressRun._id),
			status: progressRun.status,
			total: progressTotal,
			completed,
			processing,
			pending: Math.max(0, progressTotal - completed - processing - cancelled),
			cancelled,
			percent: progressRun.status === 'completed' ? 100 : progressTotal ? Math.floor(progressUnits / progressTotal) : 0
		} : null;
		const checksByWebsite = new Map(runChecks.map((check) => [String(check.website), { status: check.status, startedAt: check.startedAt, progressPercent: check.progressPercent || 0, progressStage: check.progressStage || 'Queued' }]));
		const dashboardWebsites = websites.map((website) => ({
			...website,
			...(progressRun && checksByWebsite.has(String(website._id)) ? { currentCheck: checksByWebsite.get(String(website._id)) } : {})
		}));
		res.json({ websites: dashboardWebsites, stats: { total, active, latestRun, runProgress } });
	} catch (error) { next(error); }
});
app.post('/api/websites', async (req, res, next) => { try { if (await Website.countDocuments() >= config.maxWebsites) return res.status(400).json({ error: `Maximum ${config.maxWebsites} websites are allowed.` }); const url = normalizeUrl(req.body.url); const website = await Website.create({ name: String(req.body.name || '').trim() || nameFromUrl(url), url, active: req.body.active !== false }); res.status(201).json(website); } catch (error) { next(error); } });
app.patch('/api/websites/:id', async (req, res, next) => { try { const update = {}; if (req.body.url) update.url = normalizeUrl(req.body.url); if (req.body.name !== undefined) update.name = String(req.body.name).trim(); if (req.body.active !== undefined) update.active = Boolean(req.body.active); const website = await Website.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }); if (!website) return res.status(404).json({ error: 'Website not found.' }); res.json(website); } catch (error) { next(error); } });
app.delete('/api/websites/:id', async (req, res, next) => { try { await Website.findByIdAndDelete(req.params.id); await Check.deleteMany({ website: req.params.id }); res.json({ ok: true }); } catch (error) { next(error); } });
app.post('/api/websites/bulk-action', async (req, res, next) => { try { const ids = req.body.ids || []; const action = req.body.action; if (action === 'activate' || action === 'pause') await Website.updateMany({ _id: { $in: ids } }, { $set: { active: action === 'activate' } }); else if (action === 'delete') await Website.deleteMany({ _id: { $in: ids } }); else if (action === 'check') return res.json(await enqueueRun({ type: 'manual', websiteIds: ids })); else return res.status(400).json({ error: 'Unknown action.' }); res.json({ ok: true }); } catch (error) { next(error); } });
app.post('/api/import/preview', upload.single('file'), async (req, res, next) => { try { let rows = parseBulkText(req.body.urls || ''); if (req.file) { const workbook = XLSX.read(req.file.buffer, { type: 'buffer' }); const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' }); rows = rows.concat(data.map((row) => ({ name: row['Website Name'] || row.name || '', url: row['Website URL'] || row.url || Object.values(row)[0] }))); } const existing = new Set((await Website.find().select('url -_id').lean()).map((row) => row.url)); const seen = new Set(); const preview = rows.map((row, index) => { try { const url = normalizeUrl(row.url); const valid = !existing.has(url) && !seen.has(url); seen.add(url); return { rowNumber: index + 1, name: row.name || nameFromUrl(url), url, valid, reason: valid ? '' : existing.has(url) ? 'Already added' : 'Duplicate in import' }; } catch (error) { return { rowNumber: index + 1, name: row.name, url: row.url, valid: false, reason: error.message }; } }); res.json({ rows: preview, validCount: preview.filter((row) => row.valid).length }); } catch (error) { next(error); } });
app.post('/api/import/google-sheet/preview', async (req, res, next) => { try { const rows = await rowsFromGoogleSheet(req.body.url); const existing = new Set((await Website.find().select('url -_id').lean()).map((row) => row.url)); const seen = new Set(); const preview = rows.map((row, index) => { try { const url = normalizeUrl(row.url); const valid = !existing.has(url) && !seen.has(url); seen.add(url); return { rowNumber: index + 2, name: row.name || nameFromUrl(url), url, valid, reason: valid ? '' : existing.has(url) ? 'Already added' : 'Duplicate in sheet' }; } catch (error) { return { rowNumber: index + 2, name: row.name, url: row.url, valid: false, reason: error.message }; } }); res.json({ rows: preview, validCount: preview.filter((row) => row.valid).length }); } catch (error) { next(error); } });
app.post('/api/import/commit', async (req, res, next) => { try { const rows = (req.body.rows || []).filter((row) => row.valid); if (await Website.countDocuments() + rows.length > config.maxWebsites) return res.status(400).json({ error: 'Website limit would be exceeded.' }); const inserted = await Website.insertMany(rows.map((row) => ({ name: row.name || nameFromUrl(row.url), url: normalizeUrl(row.url) })), { ordered: false }); res.json({ added: inserted.length }); } catch (error) { next(error); } });
app.post('/api/runs', async (req, res, next) => { try { res.status(201).json(await enqueueRun({ type: req.body.type || 'manual', websiteIds: req.body.websiteIds })); } catch (error) { next(error); } });
app.get('/api/runs', async (_req, res, next) => { try { res.json(await Run.find().sort({ startedAt: -1 }).limit(100).lean()); } catch (error) { next(error); } });
app.get('/api/runs/:id/progress', async (req, res, next) => {
	try {
		const run = await Run.findById(req.params.id).select('status total').lean();
		if (!run) return res.status(404).json({ error: 'Run not found.' });
		const checks = await Check.find({ run: req.params.id }).select('website status progressPercent progressStage').lean();
		const terminalStatuses = ['healthy', 'warning', 'critical'];
		const completed = checks.filter((check) => terminalStatuses.includes(check.status)).length;
		const processing = checks.filter((check) => check.status === 'processing').length;
		const cancelled = checks.filter((check) => check.status === 'cancelled').length;
		const total = run.total || checks.length;
		const progressUnits = checks.reduce((sum, check) => sum + (terminalStatuses.includes(check.status) ? 100 : ['processing', 'cancelled'].includes(check.status) ? check.progressPercent || 0 : 0), 0);
		res.json({
			runId: String(req.params.id),
			status: run.status,
			total,
			completed,
			processing,
			pending: Math.max(0, total - completed - processing - cancelled),
			cancelled,
			percent: run.status === 'completed' ? 100 : total ? Math.floor(progressUnits / total) : 0,
			checks: checks.map((check) => ({ websiteId: String(check.website), status: check.status, progressPercent: check.progressPercent || 0, progressStage: check.progressStage || 'Queued' }))
		});
	} catch (error) { next(error); }
});
app.post('/api/runs/:id/cancel', async (req, res, next) => {
	try {
		const run = await Run.findById(req.params.id).select('status').lean();
		if (!run) return res.status(404).json({ error: 'Run not found.' });
		if (run.status !== 'running') return res.status(409).json({ error: 'This run is not running.' });
		const cancelled = await cancelRun(req.params.id);
		res.json({ cancelled: Boolean(cancelled), status: cancelled ? cancelled.status : 'cancelled' });
	} catch (error) { next(error); }
});
app.get('/api/runs/:id', async (req, res, next) => { try { const details = await runDetails(req.params.id); if (!details) return res.status(404).json({ error: 'Run not found.' }); res.json(details); } catch (error) { next(error); } });
app.get('/api/runs/:id/export.csv', async (req, res, next) => { try { const details = await runDetails(req.params.id); if (!details) return res.status(404).end(); res.type('text/csv').attachment(`website-monitor-run-${req.params.id}.csv`).send(toCsv(details.checks.map((check) => ({ name: check.website.name, url: check.website.url, status: check.status, homepageStatusCode: check.homepage?.statusCode, loadTimeMs: check.homepage?.loadTimeMs, desktopContactStatus: check.desktop?.contact?.status, desktopNewsStatus: check.desktop?.news?.status, mobileContactStatus: check.mobile?.contact?.status, mobileNewsStatus: check.mobile?.news?.status, errorSummary: check.errorSummary })))); } catch (error) { next(error); } });
app.get('/api/settings', async (_req, res, next) => { try { const values = Object.fromEntries((await Setting.find().lean()).map((setting) => [setting.key, setting.value])); res.json({ dailyTime: values.dailyTime || config.defaultDailyTime, timezone: values.timezone || config.defaultTimezone, instantAlerts: values.instantAlerts ?? String(config.instantAlertsDefault) }); } catch (error) { next(error); } });
app.put('/api/settings', async (req, res, next) => { try { for (const [key, value] of Object.entries(req.body)) await Setting.findOneAndUpdate({ key }, { value: String(value) }, { upsert: true }); res.json(req.body); } catch (error) { next(error); } });
app.use((error, _req, res, _next) => { console.error(error); res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? 'This website already exists.' : error.message }); });
async function start() { await connectDatabase(); app.listen(config.port, () => { console.log(`API listening on http://localhost:${config.port}`); startScheduler(); }); }
start().catch((error) => { console.error(error); process.exit(1); });
