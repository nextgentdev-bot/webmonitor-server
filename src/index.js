import express from 'express';
import cors from 'cors';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { readGoogleSheetCsv, readGoogleSheetWorkbook, readUploadedSpreadsheet } from './spreadsheet-import.js';
import { connectDatabase } from './db.js';
import { config } from './config.js';
import { Check, DomainRun, Run, Setting, TrafficRun, TrafficWebsite, Website } from './models.js';
import { cancelRun, enqueueRun, maybeFinalizeRun, reconcileLastCheck, runDetails } from './queue.js';
import { cancelDomainRun, enqueueDomainRun, reconcileDomainRuns } from './domain-queue.js';
import { cancelTrafficRun, enqueueTrafficRun, migrateLegacyTrafficWebsites, reconcileTrafficRuns } from './traffic-queue.js';
import { analyticsDateRangeError, discoverGoogleTrafficProperties, inspectGoogleAnalyticsReports, inspectGoogleTraffic, isValidSearchConsoleSiteUrl, matchAnalyticsProperty, matchSearchConsoleSite, trafficDateRange, trafficReportRangeErrors } from './google-traffic.js';
import { buildCheckPauseUpdate } from './check-options.js';
import { countHealthyWebsites, countOpenPriorityChecks, latestCheckPerWebsite, nameFromUrl, normalizeUrl, parseBulkText, summarizeWebsiteProgress, toCsv } from './utils.js';
import { createGoogleAuthorizationUrl, createResultsSheet, disableGoogleSheetSync, exchangeGoogleAuthorizationCode, googleSheetsStatus, pendingSheetRowCount, syncPendingSheetRows } from './google-sheets.js';

const app = express(); const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors({ origin: config.clientOrigin })); app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1);

function googleOAuthCallbackUrl(req) {
	if (config.googleOAuthRedirectUri) return config.googleOAuthRedirectUri;
	const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
	const protocol = forwardedProto || req.protocol;
	const host = req.get('host');
	if (!host) throw new Error('Google OAuth callback host could not be determined.');
	return `${protocol}://${host}/api/google-sheets/oauth/callback`;
}
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
	if (gid) {
		const rows = await readGoogleSheetCsv(await response.text());
		return { rows, gid, tab: `gid=${gid}` };
	}
	const result = await readGoogleSheetWorkbook(Buffer.from(await response.arrayBuffer()));
	return { ...result, gid };
}
const auth = (req, res, next) => { const token = req.headers.authorization?.replace('Bearer ', ''); try { req.user = jwt.verify(token, config.jwtSecret); next(); } catch { res.status(401).json({ error: 'Authentication required.' }); } };
app.get('/api/google-sheets/oauth/callback', async (req, res) => {
	try {
		if (req.query.error) return res.redirect(`${config.clientOrigin.replace(/\/$/, '')}/?googleSheets=denied`);
		const state = jwt.verify(String(req.query.state || ''), config.jwtSecret);
		if (state.purpose !== 'google-sheets-oauth' || !state.username || !req.query.code) {
			throw new Error('Google authorization response could not be verified.');
		}
		await exchangeGoogleAuthorizationCode(String(req.query.code), googleOAuthCallbackUrl(req));
		res.redirect(`${config.clientOrigin.replace(/\/$/, '')}/?googleSheets=connected`);
	} catch (error) {
		console.error('Google Sheets account connection failed:', error.message);
		res.redirect(`${config.clientOrigin.replace(/\/$/, '')}/?googleSheets=error`);
	}
});
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
async function pauseWebsites(ids, reason) {
	// Keep lastCheck so the previous result is still there after the website is resumed.
	await Website.updateMany({ _id: { $in: ids } }, { $set: { active: false, pauseReason: String(reason || '').slice(0, 300), pausedAt: new Date() } });
	// Waiting/running checks are removed (not "cancelled") so a resumed website does not show a false "Cancelled" status.
	await deleteWebsiteChecks({ website: { $in: ids }, status: { $in: ['pending', 'processing'] } });
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
async function ensureTrafficWebsiteOrder() {
	const unnumbered = await TrafficWebsite.find({ sortOrder: { $exists: false } }).sort({ createdAt: -1, _id: -1 }).select('_id').lean();
	if (!unnumbered.length) return;
	const lastOrdered = await TrafficWebsite.findOne({ sortOrder: { $type: 'number' } }).sort({ sortOrder: -1 }).select('sortOrder').lean();
	let nextOrder = (lastOrdered?.sortOrder ?? -1) + 1;
	await TrafficWebsite.bulkWrite(unnumbered.map(({ _id }) => ({
		updateOne: { filter: { _id, sortOrder: { $exists: false } }, update: { $set: { sortOrder: nextOrder++ } } }
	})));
}
async function nextTrafficWebsiteOrder() {
	await ensureTrafficWebsiteOrder();
	const lastOrdered = await TrafficWebsite.findOne({ sortOrder: { $type: 'number' } }).sort({ sortOrder: -1 }).select('sortOrder').lean();
	return (lastOrdered?.sortOrder ?? -1) + 1;
}
function websiteModelForScope(scope) {
	if (scope === undefined || scope === null || scope === '' || scope === 'site') return Website;
	if (scope === 'traffic') return TrafficWebsite;
	return null;
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
app.get('/api/google-sheets/status', async (_req, res, next) => { try { res.json(await googleSheetsStatus()); } catch (error) { next(error); } });
app.get('/api/google-sheets/oauth/url', (req, res, next) => {
	try {
		const state = jwt.sign({ purpose: 'google-sheets-oauth', username: req.user.username, nonce: randomBytes(16).toString('hex') }, config.jwtSecret, { expiresIn: '10m' });
		res.json({ url: createGoogleAuthorizationUrl(state, googleOAuthCallbackUrl(req)) });
	} catch (error) { next(error); }
});
app.post('/api/google-sheets/create', async (req, res, next) => {
	try {
		await ensureWebsiteOrder();
		const websites = await Website.find().sort({ sortOrder: 1, _id: 1 }).limit(config.maxWebsites).populate('lastCheck').lean();
		if (!websites.length) return res.status(400).json({ error: 'Add at least one website before creating a results sheet.' });
		const created = await createResultsSheet(websites, req.body);
		// The whole sheet was just written from the latest results, so nothing is waiting to be synced.
		await Website.updateMany({ lastCheck: { $ne: null } }, [{ $set: { sheetSyncedCheck: '$lastCheck' } }]);
		res.status(201).json(created);
	} catch (error) { next(error); }
});
app.post('/api/google-sheets/sync-now', async (_req, res, next) => {
	try {
		const result = await syncPendingSheetRows({ force: true, maxBatches: 10 });
		res.json({ ...result, pending: await pendingSheetRowCount() });
	} catch (error) { next(error); }
});
app.delete('/api/google-sheets/sync', async (_req, res, next) => {
	try {
		await disableGoogleSheetSync();
		res.json({ ok: true });
	} catch (error) { next(error); }
});
app.get('/api/dashboard', async (req, res, next) => {
	try {
		await failEmptyRunningRuns();
		await ensureWebsiteOrder();
		const search = String(req.query.search || '').trim();
		const query = search ? { $or: [{ name: new RegExp(search, 'i') }, { url: new RegExp(search, 'i') }] } : {};
		const pausedCheckFilter = { active: true, $or: ['homepage', 'loadTime', 'news', 'contact'].map((key) => ({ [`pausedChecks.${key}.paused`]: true })) };
		const [websites, total, active, latestRun, activeRun, progressWebsites, newestActiveWebsite, worker, pausedCheckWebsites] = await Promise.all([
			Website.find(query).sort({ sortOrder: 1, _id: 1 }).limit(config.maxWebsites).populate('lastCheck').lean(),
			Website.countDocuments(query),
			Website.countDocuments({ ...query, active: true }),
			Run.findOne().sort({ startedAt: -1 }).lean(),
			Run.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean(),
			Website.find().select('active lastCheck').populate('lastCheck', 'status progressPercent').lean(),
			Website.findOne({ active: true }).sort({ createdAt: -1 }).select('createdAt').lean(),
			getWorkerStatus(),
			// Not affected by the search box, so the paused-check counts and lists stay complete.
			Website.find(pausedCheckFilter).sort({ sortOrder: 1, _id: 1 }).populate('lastCheck').lean()
		]);
		const latestRunIsStale = Boolean(latestRun && newestActiveWebsite && newestActiveWebsite.createdAt > latestRun.startedAt);
		const healthy = countHealthyWebsites(progressWebsites);
		const progressRun = activeRun || latestRun;
		const runChecks = progressRun ? latestCheckPerWebsite(await Check.find({ run: progressRun._id }).select('website status startedAt priority progressPercent progressStage mobileProgressPercent').lean()) : [];
		const runProgress = summarizeWebsiteProgress(
			progressWebsites.filter((website) => website.active).map((website) => ({ websiteId: String(website._id), lastCheck: website.lastCheck })),
			runChecks.map((check) => ({
				websiteId: String(check.website),
				status: check.status,
				progressPercent: check.progressPercent || 0,
				progressStage: check.progressStage || 'Queued',
				mobileProgressPercent: check.mobileProgressPercent || 0
			})),
			progressRun?.status,
			progressRun?.total
		);
		runProgress.runId = progressRun ? String(progressRun._id) : null;
		runProgress.scope = progressRun?.scope || 'all';
		runProgress.priorityOpen = countOpenPriorityChecks(runChecks);
		const checksByWebsite = new Map(runChecks.map((check) => [String(check.website), { status: check.status, startedAt: check.startedAt, progressPercent: check.progressPercent || 0, progressStage: check.progressStage || 'Queued', mobileProgressPercent: check.mobileProgressPercent || 0 }]));
		const dashboardWebsites = websites.map((website) => ({
			...website,
			...(website.active && progressRun && checksByWebsite.has(String(website._id)) ? { currentCheck: checksByWebsite.get(String(website._id)) } : {})
		}));
		res.json({ websites: dashboardWebsites, pausedCheckWebsites, stats: { total, active, healthy, latestRun, latestRunIsStale, runProgress, worker } });
	} catch (error) { next(error); }
});
app.get('/api/worker/status', async (_req, res, next) => {
	try { res.json(await getWorkerStatus()); } catch (error) { next(error); }
});
app.post('/api/websites', async (req, res, next) => { try { if (await Website.countDocuments() >= config.maxWebsites) return res.status(400).json({ error: `Maximum ${config.maxWebsites} websites are allowed.` }); const url = normalizeUrl(req.body.url); const sortOrder = await nextWebsiteOrder(); const website = await Website.create({ name: String(req.body.name || '').trim() || nameFromUrl(url), url, sortOrder, active: req.body.active !== false }); res.status(201).json(website); } catch (error) { next(error); } });
app.post('/api/traffic/sites', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		if (await TrafficWebsite.countDocuments() >= config.maxWebsites) return res.status(400).json({ error: `Maximum ${config.maxWebsites} traffic websites are allowed.` });
		const url = normalizeUrl(req.body.url);
		const website = await TrafficWebsite.create({
			name: String(req.body.name || '').trim() || nameFromUrl(url),
			url,
			sortOrder: await nextTrafficWebsiteOrder(),
			active: req.body.active !== false
		});
		res.status(201).json(website);
	} catch (error) { next(error); }
});
app.delete('/api/websites', async (_req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const domainRunIds = await Website.distinct('domainHosting.run');
		await deleteWebsiteChecks({});
		const result = await Website.deleteMany({});
		await reconcileDomainRuns(domainRunIds);
		res.json({ deleted: result.deletedCount });
	} catch (error) { next(error); }
});
app.patch('/api/websites/:id', async (req, res, next) => {
	try {
		const update = {};
		if (req.body.url) update.url = normalizeUrl(req.body.url);
		if (req.body.name !== undefined) update.name = String(req.body.name).trim();
		if (req.body.active === false) {
			const pauseReason = String(req.body.pauseReason || '').trim();
			if (!pauseReason) return res.status(400).json({ error: 'A pause reason is required.' });
			if (!await Website.exists({ _id: req.params.id })) return res.status(404).json({ error: 'Website not found.' });
			await pauseWebsites([req.params.id], pauseReason);
		} else if (req.body.active !== undefined) {
			update.active = Boolean(req.body.active);
			if (update.active) { update.pauseReason = ''; update.pausedAt = null; }
		}
		const website = Object.keys(update).length ? await Website.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }) : await Website.findById(req.params.id);
		if (!website) return res.status(404).json({ error: 'Website not found.' });
		res.json(website);
	} catch (error) { next(error); }
});
// Pause or resume single checks (homepage, loadTime, news, contact) while the website itself keeps being monitored.
// Body: { checks: { news: { paused: true, reason: 'Why' }, contact: { paused: false } } }
app.patch('/api/websites/:id/checks', async (req, res, next) => {
	try {
		const website = await Website.findById(req.params.id).select('pausedChecks lastCheck').lean();
		if (!website) return res.status(404).json({ error: 'Website not found.' });
		const { update, error } = buildCheckPauseUpdate(website, req.body?.checks);
		if (error) return res.status(400).json({ error });
		await Website.updateOne({ _id: req.params.id }, { $set: update });
		await reconcileLastCheck(req.params.id);
		res.json(await Website.findById(req.params.id).populate('lastCheck').lean());
	} catch (error) { next(error); }
});
app.delete('/api/websites/:id', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const domainRunIds = await Website.distinct('domainHosting.run', { _id: req.params.id });
		await Website.findByIdAndDelete(req.params.id);
		await deleteWebsiteChecks({ website: req.params.id });
		await reconcileDomainRuns(domainRunIds);
		res.json({ ok: true });
	} catch (error) { next(error); }
});
app.post('/api/websites/bulk-action', async (req, res, next) => {
	try {
		const ids = req.body.ids || [];
		const action = req.body.action;
		if (action === 'pause') {
			const reason = String(req.body.pauseReason || '').trim();
			if (!reason) return res.status(400).json({ error: 'A pause reason is required.' });
			await pauseWebsites(ids, reason);
		} else if (action === 'activate') {
			await Website.updateMany({ _id: { $in: ids } }, { $set: { active: true, pauseReason: '', pausedAt: null } });
		} else if (action === 'delete') {
			await migrateLegacyTrafficWebsites();
			const domainRunIds = await Website.distinct('domainHosting.run', { _id: { $in: ids } });
			await deleteWebsiteChecks({ website: { $in: ids } });
			const result = await Website.deleteMany({ _id: { $in: ids } });
			await reconcileDomainRuns(domainRunIds);
			return res.json({ deleted: result.deletedCount });
		} else if (action === 'check') return res.json(await enqueueRun({ websiteIds: ids }));
		else return res.status(400).json({ error: 'Unknown action.' });
		res.json({ ok: true });
	} catch (error) { next(error); }
});
app.post('/api/import/preview', upload.single('file'), async (req, res, next) => {
	try {
		const model = websiteModelForScope(req.body.scope);
		if (!model) return res.status(400).json({ error: 'Unknown website destination.' });
		if (model === TrafficWebsite) await migrateLegacyTrafficWebsites();
		let rows = parseBulkText(req.body.urls || '');
		if (req.file) {
			const data = await readUploadedSpreadsheet(req.file.buffer);
			rows = rows.concat(data.map((row) => ({ name: row['Website Name'] || row.name || Object.values(row)[0], url: row['Website URL'] || row.url || Object.values(row)[0] })));
		}
		const existing = new Set((await model.find().select('url -_id').lean()).map((row) => row.url));
		const seen = new Set();
		const preview = rows.map((row, index) => {
			try {
				const url = normalizeUrl(row.url);
				const valid = !existing.has(url) && !seen.has(url);
				seen.add(url);
				return { rowNumber: index + 1, name: row.name || nameFromUrl(url), url, valid, reason: valid ? '' : existing.has(url) ? 'Already added' : 'Duplicate in import' };
			} catch (error) {
				return { rowNumber: index + 1, name: row.name, url: row.url, valid: false, reason: error.message };
			}
		});
		res.json({ rows: preview, validCount: preview.filter((row) => row.valid).length });
	} catch (error) { next(error); }
});
app.post('/api/import/google-sheet/preview', async (req, res, next) => {
	try {
		const model = websiteModelForScope(req.body.scope);
		if (!model) return res.status(400).json({ error: 'Unknown website destination.' });
		if (model === TrafficWebsite) await migrateLegacyTrafficWebsites();
		const { rows, gid, tab } = await rowsFromGoogleSheet(req.body.url);
		const existing = new Set((await model.find().select('url -_id').lean()).map((row) => row.url));
		const seen = new Set();
		const preview = rows.map((row, index) => {
			try {
				const url = normalizeUrl(row.url);
				const valid = !seen.has(url);
				seen.add(url);
				return { rowNumber: index + 2, name: row.name || nameFromUrl(url), url, valid, action: existing.has(url) ? 'update' : 'add', reason: valid ? '' : 'Duplicate in sheet' };
			} catch (error) {
				return { rowNumber: index + 2, name: row.name, url: row.url, valid: false, action: 'invalid', reason: error.message };
			}
		});
		res.json({ rows: preview, validCount: preview.filter((row) => row.valid).length, sourceCount: rows.length, gid, tab });
	} catch (error) { next(error); }
});
app.post('/api/import/google-sheet/commit', async (req, res, next) => {
	try {
		const model = websiteModelForScope(req.body.scope);
		if (!model) return res.status(400).json({ error: 'Unknown website destination.' });
		if (model === TrafficWebsite) await migrateLegacyTrafficWebsites();
		await (model === TrafficWebsite ? ensureTrafficWebsiteOrder() : ensureWebsiteOrder());
		const rowsByUrl = new Map();
		for (const row of (req.body.rows || []).filter((item) => item.valid)) {
			const url = normalizeUrl(row.url);
			rowsByUrl.set(url, { url, name: String(row.name || '').trim() });
		}
		const rows = [...rowsByUrl.values()];
		const urls = rows.map((row) => row.url);
		const existingUrls = new Set(urls.length ? await model.distinct('url', { url: { $in: urls } }) : []);
		const newCount = rows.length - existingUrls.size;
		if (await model.countDocuments() + newCount > config.maxWebsites) return res.status(400).json({ error: 'Website limit would be exceeded.' });
		let nextOrder = await (model === TrafficWebsite ? nextTrafficWebsiteOrder() : nextWebsiteOrder());
		const operations = rows.map((row) => {
			const insertFields = { url: row.url, active: true };
			if (!existingUrls.has(row.url)) insertFields.sortOrder = nextOrder++;
			const update = row.name
				? { $setOnInsert: insertFields, $set: { name: row.name } }
				: { $setOnInsert: { ...insertFields, name: nameFromUrl(row.url) } };
			return { updateOne: { filter: { url: row.url }, update, upsert: true } };
		});
		const result = operations.length ? await model.bulkWrite(operations, { ordered: false }) : { matchedCount: 0, upsertedCount: 0 };
		res.json({ added: result.upsertedCount, updated: result.matchedCount });
	} catch (error) { next(error); }
});
app.post('/api/import/commit', async (req, res, next) => {
	try {
		const model = websiteModelForScope(req.body.scope);
		if (!model) return res.status(400).json({ error: 'Unknown website destination.' });
		if (model === TrafficWebsite) await migrateLegacyTrafficWebsites();
		const rowsByUrl = new Map();
		for (const row of (req.body.rows || []).filter((item) => item.valid)) {
			const url = normalizeUrl(row.url);
			if (!rowsByUrl.has(url)) rowsByUrl.set(url, row);
		}
		const rows = [...rowsByUrl.values()];
		if (await model.countDocuments() + rows.length > config.maxWebsites) return res.status(400).json({ error: 'Website limit would be exceeded.' });
		const firstOrder = await (model === TrafficWebsite ? nextTrafficWebsiteOrder() : nextWebsiteOrder());
		const inserted = await model.insertMany(rows.map((row, index) => ({ name: row.name || nameFromUrl(row.url), url: normalizeUrl(row.url), sortOrder: firstOrder + index })), { ordered: false });
		res.json({ added: inserted.length });
	} catch (error) { next(error); }
});
app.post('/api/runs', async (req, res, next) => { try { res.status(201).json(await enqueueRun({ websiteIds: req.body.websiteIds })); } catch (error) { next(error); } });
app.get('/api/traffic/status', async (_req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const [run, websites] = await Promise.all([
			TrafficRun.findOne().sort({ startedAt: -1 }).lean(),
			TrafficWebsite.find().sort({ sortOrder: 1, _id: 1 }).select('name url active traffic').lean()
		]);
		res.json({ today: trafficDateRange().endDate, run, websites });
	} catch (error) { next(error); }
});
app.post('/api/traffic/discover', async (_req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const properties = await discoverGoogleTrafficProperties();
		const websites = await TrafficWebsite.find().sort({ sortOrder: 1, _id: 1 }).select('name url active traffic').lean();
		const operations = [];
		const mapped = websites.map((website) => {
			const update = {};
			if (!website.traffic?.analyticsPropertyId && !properties.analytics.error) {
				const propertyId = matchAnalyticsProperty(website, properties.analytics.properties);
				if (propertyId) update['traffic.analyticsPropertyId'] = propertyId;
			}
			if (!website.traffic?.searchConsoleSiteUrl && !properties.searchConsole.error) {
				const siteUrl = matchSearchConsoleSite(website.url, properties.searchConsole.sites);
				if (siteUrl) update['traffic.searchConsoleSiteUrl'] = siteUrl;
			}
			if (Object.keys(update).length) operations.push({ updateOne: { filter: { _id: website._id }, update: { $set: update } } });
			return { ...website, traffic: { ...website.traffic, ...Object.fromEntries(Object.entries(update).map(([key, value]) => [key.slice('traffic.'.length), value])) } };
		});
		if (operations.length) await TrafficWebsite.bulkWrite(operations, { ordered: false });
		res.json({ ...properties, websites: mapped });
	} catch (error) { next(error); }
});
app.post('/api/traffic/analytics-report', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const { startDate, endDate } = req.body || {};
		const rangeError = analyticsDateRangeError(String(startDate || ''), String(endDate || ''));
		if (rangeError) return res.status(400).json({ error: rangeError });
		const google = await googleSheetsStatus();
		if (!google.connected) return res.status(400).json({ error: 'Connect Google and grant Analytics permission first.' });
		const websites = await TrafficWebsite.find({
			active: true,
			'traffic.analyticsPropertyId': { $exists: true, $nin: ['', null] }
		}).sort({ sortOrder: 1, _id: 1 }).select('traffic.analyticsPropertyId').lean();
		const reports = await inspectGoogleAnalyticsReports(websites, { startDate, endDate });
		res.json({ startDate, endDate, reports });
	} catch (error) { next(error); }
});
app.post('/api/traffic/sites/:id/report', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const ranges = req.body || {};
		const rangeErrors = trafficReportRangeErrors(ranges);
		const errors = Object.entries(rangeErrors)
			.filter(([, error]) => error)
			.map(([source, error]) => `${source === 'analytics' ? 'GA4' : 'Search Console'}: ${error}`);
		if (errors.length) return res.status(400).json({ error: errors.join(' ') });
		const website = await TrafficWebsite.findById(req.params.id).select('name url active traffic').lean();
		if (!website) return res.status(404).json({ error: 'Website not found.' });
		const google = await googleSheetsStatus();
		if (!google.connected) return res.status(400).json({ error: 'Connect Google and grant the Analytics and Search Console permissions first.' });
		const reportRanges = {
			analyticsStartDate: String(ranges.analyticsStartDate),
			analyticsEndDate: String(ranges.analyticsEndDate),
			searchConsoleStartDate: String(ranges.searchConsoleStartDate),
			searchConsoleEndDate: String(ranges.searchConsoleEndDate)
		};
		await TrafficWebsite.updateOne({ _id: website._id }, { $set: { 'traffic.reportRanges': reportRanges } });
		const report = await inspectGoogleTraffic(website, {
			analyticsRange: { startDate: reportRanges.analyticsStartDate, endDate: reportRanges.analyticsEndDate },
			searchConsoleRange: { startDate: reportRanges.searchConsoleStartDate, endDate: reportRanges.searchConsoleEndDate }
		}, { includeAnalyticsOverview: true });
		await TrafficWebsite.updateOne({ _id: website._id }, { $set: {
			'traffic.reportRanges': reportRanges,
			'traffic.customReport': report
		} });
		res.json({ websiteId: String(website._id), reportRanges, ...report });
	} catch (error) { next(error); }
});
app.patch('/api/traffic/sites/:id', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const website = await TrafficWebsite.findById(req.params.id).select('traffic').lean();
		if (!website) return res.status(404).json({ error: 'Website not found.' });
		if (['pending', 'processing'].includes(website.traffic?.status)) return res.status(409).json({ error: 'Wait for or cancel the current Traffic Check before changing mappings.' });
		const update = {};
		if (req.body.analyticsPropertyId !== undefined) {
			const propertyId = String(req.body.analyticsPropertyId || '').trim();
			if (propertyId && !/^\d+$/.test(propertyId)) return res.status(400).json({ error: 'Choose a valid GA4 property.' });
			update['traffic.analyticsPropertyId'] = propertyId;
			update['traffic.realtimeActiveUsers'] = null;
			update['traffic.realtimeUpdatedAt'] = null;
			update['traffic.realtimeError'] = '';
		}
		if (req.body.searchConsoleSiteUrl !== undefined) {
			const siteUrl = String(req.body.searchConsoleSiteUrl || '').trim();
			if (siteUrl && !isValidSearchConsoleSiteUrl(siteUrl)) return res.status(400).json({ error: 'Choose a valid Search Console property.' });
			update['traffic.searchConsoleSiteUrl'] = siteUrl;
		}
		if (!Object.keys(update).length) return res.status(400).json({ error: 'Select at least one property mapping.' });
		update['traffic.status'] = 'not-checked';
		update['traffic.checkedAt'] = null;
		update['traffic.analytics'] = null;
		update['traffic.analyticsError'] = '';
		update['traffic.searchConsole'] = null;
		update['traffic.searchConsoleError'] = '';
		update['traffic.customReport'] = null;
		update['traffic.startDate'] = '';
		update['traffic.endDate'] = '';
		const saved = await TrafficWebsite.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true }).select('name url active traffic').lean();
		res.json(saved);
	} catch (error) { next(error); }
});
app.delete('/api/traffic/sites/:id', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const runIds = await TrafficWebsite.distinct('traffic.run', { _id: req.params.id });
		const website = await TrafficWebsite.findByIdAndDelete(req.params.id);
		if (!website) return res.status(404).json({ error: 'Traffic website not found.' });
		await Promise.all(runIds.map((runId) => reconcileTrafficRuns([runId])));
		res.json({ ok: true });
	} catch (error) { next(error); }
});
app.post('/api/traffic/runs', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const analyticsRange = req.body?.analyticsRange || {};
		const searchConsoleRange = req.body?.searchConsoleRange || {};
		const rangeErrors = trafficReportRangeErrors({
			analyticsStartDate: analyticsRange.startDate,
			analyticsEndDate: analyticsRange.endDate,
			searchConsoleStartDate: searchConsoleRange.startDate,
			searchConsoleEndDate: searchConsoleRange.endDate
		});
		const errors = [
			rangeErrors.analytics && `GA4: ${rangeErrors.analytics}`,
			rangeErrors.searchConsole && `Search Console: ${rangeErrors.searchConsole}`
		].filter(Boolean);
		if (errors.length) return res.status(400).json({ error: errors.join(' ') });
		const google = await googleSheetsStatus();
		if (!google.connected) return res.status(400).json({ error: 'Connect Google and grant the Analytics and Search Console permissions first.' });
		const result = await enqueueTrafficRun(new Date(), { analyticsRange, searchConsoleRange });
		res.status(result.created ? 201 : 200).json(result);
	} catch (error) { next(error); }
});
app.post('/api/traffic/runs/:id/cancel', async (req, res, next) => {
	try {
		await migrateLegacyTrafficWebsites();
		const run = await TrafficRun.findById(req.params.id).select('status').lean();
		if (!run) return res.status(404).json({ error: 'Traffic run not found.' });
		if (run.status !== 'running') return res.status(409).json({ error: 'This Traffic Check is not running.' });
		const cancelled = await cancelTrafficRun(req.params.id);
		if (!cancelled) return res.status(409).json({ error: 'This Traffic Check is no longer running.' });
		res.json({ cancelled: true, run: cancelled });
	} catch (error) { next(error); }
});
app.post('/api/domain-hosting/runs', async (req, res, next) => { try { const body = req.body || {}; const websiteIds = Array.isArray(body.websiteIds) ? [...new Set(body.websiteIds.map(String))] : null; if (Array.isArray(body.websiteIds) && websiteIds.length === 0) return res.status(400).json({ error: 'Select at least one website for a domain check.' }); const result = await enqueueDomainRun({ websiteIds }); res.status(result.created ? 201 : 200).json(result); } catch (error) { next(error); } });
app.post('/api/domain-hosting/runs/:id/cancel', async (req, res, next) => {
	try {
		const run = await DomainRun.findById(req.params.id).select('status').lean();
		if (!run) return res.status(404).json({ error: 'Domain run not found.' });
		if (run.status !== 'running') return res.status(409).json({ error: 'This domain run is not running.' });
		const cancelled = await cancelDomainRun(req.params.id);
		if (!cancelled) return res.status(409).json({ error: 'This domain run is no longer running.' });
		res.json({ cancelled: true, run: cancelled });
	} catch (error) { next(error); }
});
app.get('/api/domain-hosting/status', async (_req, res, next) => { try { res.json({ run: await DomainRun.findOne().sort({ startedAt: -1 }).lean() }); } catch (error) { next(error); } });
app.get('/api/runs', async (_req, res, next) => { try { res.json(await Run.find().sort({ startedAt: -1 }).limit(100).lean()); } catch (error) { next(error); } });
app.get('/api/runs/:id/progress', async (req, res, next) => {
	try {
		const [run, progressWebsites] = await Promise.all([
			Run.findById(req.params.id).select('status total scope').lean(),
			Website.find().select('active lastCheck').populate('lastCheck', 'status progressPercent mobileProgressPercent').lean()
		]);
		if (!run) return res.status(404).json({ error: 'Run not found.' });
		const checks = latestCheckPerWebsite(await Check.find({ run: req.params.id }).select('website status priority progressPercent progressStage mobileProgressPercent').lean());
		const progress = summarizeWebsiteProgress(
			progressWebsites.filter((website) => website.active).map((website) => ({ websiteId: String(website._id), lastCheck: website.lastCheck })),
			checks.map((check) => ({
				websiteId: String(check.website),
				status: check.status,
				progressPercent: check.progressPercent || 0,
				progressStage: check.progressStage || 'Queued',
				mobileProgressPercent: check.mobileProgressPercent || 0
			})),
			run.status,
			run.total
		);
		res.json({
			...progress,
			runId: String(req.params.id),
			scope: run.scope || 'all',
			priorityOpen: countOpenPriorityChecks(checks),
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
app.get('/api/settings', async (_req, res, next) => { try { const values = Object.fromEntries((await Setting.find().lean()).map((setting) => [setting.key, setting.value])); res.json({ timezone: values.timezone || config.defaultTimezone, instantAlerts: values.instantAlerts ?? String(config.instantAlertsDefault) }); } catch (error) { next(error); } });
app.put('/api/settings', async (req, res, next) => { try { for (const [key, value] of Object.entries(req.body)) await Setting.findOneAndUpdate({ key }, { value: String(value) }, { upsert: true }); res.json(req.body); } catch (error) { next(error); } });
app.use((error, _req, res, _next) => {
	console.error(error);
	const status = error.code === 11000 ? 409 : error.code === 'GOOGLE_AUTH_REVOKED' ? 400 : 500;
	res.status(status).json({
		error: error.code === 11000 ? 'This website already exists.' : error.message,
		...(error.code ? { code: error.code } : {})
	});
});
async function start() { await connectDatabase(); app.listen(config.port, () => { console.log(`API listening on http://localhost:${config.port}`); }); }
export default app;

if (!process.env.VERCEL) start().catch((error) => { console.error(error); process.exit(1); });