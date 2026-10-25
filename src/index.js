import express from 'express';
import cors from 'cors';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';
import XLSX from 'xlsx';
import { connectDatabase } from './db.js';
import { config } from './config.js';
import { Check, Run, Setting, Website } from './models.js';
import { cancelRun, enqueueRun, maybeFinalizeRun, runDetails } from './queue.js';
import { countHealthyWebsites, defaultGoogleSheetTab, nameFromUrl, normalizeUrl, parseBulkText, parseGoogleSheetRows, summarizeWebsiteProgress, toCsv } from './utils.js';
import { startScheduler } from './scheduler.js';

const app = express(); const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors({ origin: config.clientOrigin })); app.use(express.json({ limit: '2mb' })); app.use('/screenshots', express.static(config.screenshotDir));
function googleSheetCsvUrl(input) {
	const value = String(input || '').trim();
	const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
	if (!match) throw new Error('Paste a valid Google Sheets URL.');
	const gid = value.match(/[?#&]gid=(\d+)/)?.[1] || null;
	return { spreadsheetId: match[1], gid };
}
async function rowsFromGoogleSheet(input) {
	const { spreadsheetId, gid } = googleSheetCsvUrl(input);
	const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
	exportUrl.searchParams.set('format', gid ? 'csv' : 'xlsx');
	if (gid) exportUrl.searchParams.set('gid', gid);
	exportUrl.searchParams.set('_cacheBust', String(Date.now()));
	const response = await fetch(exportUrl, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
	if (!response.ok || new URL(response.url).hostname === 'accounts.google.com') throw new Error('Google Sheet could not be read. Set General access to Anyone with the link: Viewer.');
	const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
	const sheetName = gid ? workbook.SheetNames[0] : defaultGoogleSheetTab(workbook.SheetNames);
	if (!sheetName) throw new Error('Google Sheet does not contain any tabs.');
	const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
	const rows = parseGoogleSheetRows(data);
	return { rows, gid, tab: gid ? `gid=${gid}` : sheetName };
}
const auth = (req, res, next) => { const token = req.headers.authorization?.replace('Bearer ', ''); try { req.user = jwt.verify(token, config.jwtSecret); next(); } catch { res.status(401).json({ error: 'Authentication required.' }); } };
async function failEmptyRunningRuns() {
	const runningRuns = await Run.find({ status: 'running' }).select('_id').lean();
	for (const run of runningRuns) {
		if (!await Check.exists({ run: run._id })) await Run.findOneAndUpdate({ _id: run._id, status: 'running' }, { $set: { status: 'failed', finishedAt: new Date() } });
	}
}
async function deleteWebsiteChecks(filter) {
	const runIds = await Check.distinct('run', filter);
	await Check.deleteMany(filter);
	await Promise.all(runIds.map((runId) => maybeFinalizeRun(runId)));
}
async function pauseWebsites(ids) {
	await Website.updateMany({ _id: { $in: ids } }, { $set: { active: false, lastCheck: null } });
	const checkFilter = { website: { $in: ids }, status: { $in: ['pending', 'processing'] } };
	const runIds = await Check.distinct('run', checkFilter);
	await Check.updateMany(checkFilter, { $set: { status: 'cancelled', progressStage: 'Paused', finishedAt: new Date(), lockedAt: null, lockedBy: null } });
	await Promise.all(runIds.map((runId) => maybeFinalizeRun(runId)));
}
async function ensureWebsiteOrder() {
	const unnumbered = await Website.find({ sortOrder: { $exists: false } }).sort({ createdAt: -1, _id: -1 }).select('_id').lean();
	if (!unnumbered.length) return;
	const lastOrdered = await Website.findOne({ sortOrder: { $type: 'number' } }).sort({ sortOrder: -1 }).select('sortOrder').lean();
	let nextOrder = (lastOrdered?.sortOrder ?? -1) + 1;
	await Website.bulkWrite(unnumbered.map(({ _id }) => ({
		updateOne: { filter: { _id, sortOrder: { $exists: false } }, update: { $set: { sortOrder: nextOrder++ } } }
	})));
}
async function nextWebsiteOrder() {
	await ensureWebsiteOrder();
	const lastOrdered = await Website.findOne({ sortOrder: { $type: 'number' } }).sort({ sortOrder: -1 }).select('sortOrder').lean();
	return (lastOrdered?.sortOrder ?? -1) + 1;
}
async function getWorkerStatus() {
	const heartbeats = await Setting.find({ key: /^workerHeartbeat:/ }).select('value').lean();
	const activeWorker = heartbeats
		.map(({ value }) => JSON.parse(value))
		.filter((heartbeat) => heartbeat.status === 'online' && Date.now() - Date.parse(heartbeat.updatedAt) < 20000)
		.sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt))[0];
	return activeWorker ? { status: 'online', workerId: activeWorker.workerId } : { status: 'offline' };
}
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/health/ready', async (_req, res, next) => { try { await connectDatabase(); res.json({ ok: true, database: 'connected', time: new Date().toISOString() }); } catch (error) { next(error); } });
app.get('/', (_req, res) => res.json({ service: 'web-monitor-api', status: 'online', health: '/api/health', readiness: '/api/health/ready' }));
app.post('/api/auth/login', (req, res) => { if (req.body.username !== config.adminUser || req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid credentials.' }); res.json({ token: jwt.sign({ username: config.adminUser }, config.jwtSecret, { expiresIn: '10h' }) }); });
app.use('/api', auth);
app.get('/api/dashboard', async (req, res, next) => {
	try {
		await failEmptyRunningRuns();
		await ensureWebsiteOrder();
		const search = String(req.query.search || '').trim();
		const query = search ? { $or: [{ name: new RegExp(search, 'i') }, { url: new RegExp(search, 'i') }] } : {};
		const [websites, total, active, latestRun, activeRun, progressWebsites, newestActiveWebsite, worker] = await Promise.all([
			Website.find(query).sort({ sortOrder: 1, _id: 1 }).limit(config.maxWebsites).populate('lastCheck').lean(),
			Website.countDocuments(query),
			Website.countDocuments({ ...query, active: true }),
			Run.findOne().sort({ startedAt: -1 }).lean(),
			Run.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean(),
			Website.find().select('active lastCheck').populate('lastCheck', 'status progressPercent').lean(),
			Website.findOne({ active: true }).sort({ createdAt: -1 }).select('createdAt').lean(),
			getWorkerStatus()
		]);
		const latestRunIsStale = Boolean(latestRun && newestActiveWebsite && newestActiveWebsite.createdAt > latestRun.startedAt);
		const healthy = countHealthyWebsites(progressWebsites);
		const progressRun = activeRun || latestRun;
		const runChecks = progressRun ? await Check.find({ run: progressRun._id }).select('website status startedAt progressPercent progressStage mobileProgressPercent').lean() : [];
		const runProgress = summarizeWebsiteProgress(
			progressWebsites.map((website) => ({ websiteId: String(website._id), lastCheck: website.lastCheck })),
			runChecks.map((check) => ({
				websiteId: String(check.website),
				status: check.status,
				progressPercent: check.progressPercent || 0,
				progressStage: check.progressStage || 'Queued',
				mobileProgressPercent: check.mobileProgressPercent || 0
			})),
			progressRun?.status
		);
		runProgress.runId = progressRun ? String(progressRun._id) : null;
		const checksByWebsite = new Map(runChecks.map((check) => [String(check.website), { status: check.status, startedAt: check.startedAt, progressPercent: check.progressPercent || 0, progressStage: check.progressStage || 'Queued', mobileProgressPercent: check.mobileProgressPercent || 0 }]));
		const dashboardWebsites = websites.map((website) => ({
			...website,
			...(website.active && progressRun && checksByWebsite.has(String(website._id)) ? { currentCheck: checksByWebsite.get(String(website._id)) } : {})
		}));
		res.json({ websites: dashboardWebsites, stats: { total, active, healthy, latestRun, latestRunIsStale, runProgress, worker } });
	} catch (error) { next(error); }
});
app.get('/api/worker/status', async (_req, res, next) => {
	try { res.json(await getWorkerStatus()); } catch (error) { next(error); }
});
app.post('/api/websites', async (req, res, next) => { try { if (await Website.countDocuments() >= config.maxWebsites) return res.status(400).json({ error: `Maximum ${config.maxWebsites} websites are allowed.` }); const url = normalizeUrl(req.body.url); const sortOrder = await nextWebsiteOrder(); const website = await Website.create({ name: String(req.body.name || '').trim() || nameFromUrl(url), url, sortOrder, active: req.body.active !== false }); res.status(201).json(website); } catch (error) { next(error); } });
app.delete('/api/websites', async (_req, res, next) => { try { await deleteWebsiteChecks({}); const result = await Website.deleteMany({}); res.json({ deleted: result.deletedCount }); } catch (error) { next(error); } });
app.patch('/api/websites/:id', async (req, res, next) => { try { const update = {}; if (req.body.url) update.url = normalizeUrl(req.body.url); if (req.body.name !== undefined) update.name = String(req.body.name).trim(); if (req.body.active === false) await pauseWebsites([req.params.id]); else if (req.body.active !== undefined) update.active = Boolean(req.body.active); const website = Object.keys(update).length ? await Website.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }) : await Website.findById(req.params.id); if (!website) return res.status(404).json({ error: 'Website not found.' }); res.json(website); } catch (error) { next(error); } });
app.delete('/api/websites/:id', async (req, res, next) => { try { await Website.findByIdAndDelete(req.params.id); await deleteWebsiteChecks({ website: req.params.id }); res.json({ ok: true }); } catch (error) { next(error); } });
app.post('/api/websites/bulk-action', async (req, res, next) => { try { const ids = req.body.ids || []; const action = req.body.action; if (action === 'pause') await pauseWebsites(ids); else if (action === 'activate') await Website.updateMany({ _id: { $in: ids } }, { $set: { active: true } }); else if (action === 'delete') { await deleteWebsiteChecks({ website: { $in: ids } }); const result = await Website.deleteMany({ _id: { $in: ids } }); return res.json({ deleted: result.deletedCount }); } else if (action === 'check') return res.json(await enqueueRun({ type: 'manual', websiteIds: ids })); else return res.status(400).json({ error: 'Unknown action.' }); res.json({ ok: true }); } catch (error) { next(error); } });
app.post('/api/import/preview', upload.single('file'), async (req, res, next) => { try { let rows = parseBulkText(req.body.urls || ''); if (req.file) { const workbook = XLSX.read(req.file.buffer, { type: 'buffer' }); const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' }); rows = rows.concat(data.map((row) => ({ name: row['Website Name'] || row.name || '', url: row['Website URL'] || row.url || Object.values(row)[0] }))); } const existing = new Set((await Website.find().select('url -_id').lean()).map((row) => row.url)); const seen = new Set(); const preview = rows.map((row, index) => { try { const url = normalizeUrl(row.url); const valid = !existing.has(url) && !seen.has(url); seen.add(url); return { rowNumber: index + 1, name: row.name || nameFromUrl(url), url, valid, reason: valid ? '' : existing.has(url) ? 'Already added' : 'Duplicate in import' }; } catch (error) { return { rowNumber: index + 1, name: row.name, url: row.url, valid: false, reason: error.message }; } }); res.json({ rows: preview, validCount: preview.filter((row) => row.valid).length }); } catch (error) { next(error); } });
app.post('/api/import/google-sheet/preview', async (req, res, next) => { try { const { rows, gid, tab } = await rowsFromGoogleSheet(req.body.url); const existing = new Set((await Website.find().select('url -_id').lean()).map((row) => row.url)); const seen = new Set(); const preview = rows.map((row, index) => { try { const url = normalizeUrl(row.url); const valid = !seen.has(url); seen.add(url); return { rowNumber: index + 2, name: row.name || nameFromUrl(url), url, valid, action: existing.has(url) ? 'update' : 'add', reason: valid ? '' : 'Duplicate in sheet' }; } catch (error) { return { rowNumber: index + 2, name: row.name, url: row.url, valid: false, action: 'invalid', reason: error.message }; } }); res.json({ rows: preview, validCount: preview.filter((row) => row.valid).length, sourceCount: rows.length, gid, tab }); } catch (error) { next(error); } });
app.post('/api/import/google-sheet/commit', async (req, res, next) => {
	try {
		await ensureWebsiteOrder();
		const rowsByUrl = new Map();
		for (const row of (req.body.rows || []).filter((item) => item.valid)) {
			const url = normalizeUrl(row.url);
			rowsByUrl.set(url, { url, name: String(row.name || '').trim() });
		}
		const rows = [...rowsByUrl.values()];
		const urls = rows.map((row) => row.url);
		const existingUrls = new Set(urls.length ? await Website.distinct('url', { url: { $in: urls } }) : []);
		const newCount = rows.length - existingUrls.size;
		if (await Website.countDocuments() + newCount > config.maxWebsites) return res.status(400).json({ error: 'Website limit would be exceeded.' });
		let nextOrder = await nextWebsiteOrder();
		const operations = rows.map((row) => {
			const insertFields = { url: row.url, active: true };
			if (!existingUrls.has(row.url)) insertFields.sortOrder = nextOrder++;
			const update = row.name
				? { $setOnInsert: insertFields, $set: { name: row.name } }
				: { $setOnInsert: { ...insertFields, name: nameFromUrl(row.url) } };
			return { updateOne: { filter: { url: row.url }, update, upsert: true } };
		});
		const result = operations.length ? await Website.bulkWrite(operations, { ordered: false }) : { matchedCount: 0, upsertedCount: 0 };
		res.json({ added: result.upsertedCount, updated: result.matchedCount });
	} catch (error) { next(error); }
});
app.post('/api/import/commit', async (req, res, next) => { try { const rows = (req.body.rows || []).filter((row) => row.valid); if (await Website.countDocuments() + rows.length > config.maxWebsites) return res.status(400).json({ error: 'Website limit would be exceeded.' }); const firstOrder = await nextWebsiteOrder(); const inserted = await Website.insertMany(rows.map((row, index) => ({ name: row.name || nameFromUrl(row.url), url: normalizeUrl(row.url), sortOrder: firstOrder + index })), { ordered: false }); res.json({ added: inserted.length }); } catch (error) { next(error); } });
app.post('/api/runs', async (req, res, next) => { try { res.status(201).json(await enqueueRun({ type: req.body.type || 'manual', websiteIds: req.body.websiteIds })); } catch (error) { next(error); } });
app.get('/api/runs', async (_req, res, next) => { try { res.json(await Run.find().sort({ startedAt: -1 }).limit(100).lean()); } catch (error) { next(error); } });
app.get('/api/runs/:id/progress', async (req, res, next) => {
	try {
		const [run, progressWebsites] = await Promise.all([
			Run.findById(req.params.id).select('status').lean(),
			Website.find().select('lastCheck').populate('lastCheck', 'status progressPercent mobileProgressPercent').lean()
		]);
		if (!run) return res.status(404).json({ error: 'Run not found.' });
		const checks = await Check.find({ run: req.params.id }).select('website status progressPercent progressStage mobileProgressPercent').lean();
		const progress = summarizeWebsiteProgress(
			progressWebsites.map((website) => ({ websiteId: String(website._id), lastCheck: website.lastCheck })),
			checks.map((check) => ({
				websiteId: String(check.website),
				status: check.status,
				progressPercent: check.progressPercent || 0,
				progressStage: check.progressStage || 'Queued',
				mobileProgressPercent: check.mobileProgressPercent || 0
			})),
			run.status
		);
		res.json({
			...progress,
			runId: String(req.params.id),
			checks: checks.map((check) => ({ websiteId: String(check.website), status: check.status, progressPercent: check.progressPercent || 0, progressStage: check.progressStage || 'Queued', mobileProgressPercent: check.mobileProgressPercent || 0 }))
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
export default app;

if (!process.env.VERCEL) start().catch((error) => { console.error(error); process.exit(1); });
