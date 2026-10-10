import os from 'node:os';
import { chromium } from 'playwright';
import { connectDatabase } from './db.js';
import { config } from './config.js';
import { claimNextCheck, completeCheck, failCheck, maybeFinalizeRun, updateCheckProgress } from './queue.js';
import { monitorWebsite } from './monitor.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
async function loop(browser, slot) { while (!stopping) { const claimed = await claimNextCheck(`${os.hostname()}-${process.pid}-${slot}`); if (!claimed) { await sleep(1200); continue; } try { const result = await monitorWebsite(browser, { website: claimed.website, runId: claimed.check.run, onProgress: (progress) => updateCheckProgress(claimed.check._id, progress).catch((error) => console.error('Unable to save check progress:', error.message)) }); await completeCheck(claimed.check, result); await maybeFinalizeRun(claimed.check.run); } catch (error) { await failCheck(claimed.check, error); await maybeFinalizeRun(claimed.check.run); } } }
async function main() { await connectDatabase(); const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] }); process.on('SIGTERM', () => { stopping = true; }); process.on('SIGINT', () => { stopping = true; }); await Promise.all(Array.from({ length: config.workerConcurrency }, (_, index) => loop(browser, index + 1))); await browser.close(); }
main().catch((error) => { console.error(error); process.exit(1); });
