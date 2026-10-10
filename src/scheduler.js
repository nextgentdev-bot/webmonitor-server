import { DateTime } from 'luxon';
import { config } from './config.js';
import { Setting } from './models.js';
import { enqueueRun } from './queue.js';

const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
export async function schedulerTick() {
  const values = Object.fromEntries((await Setting.find().lean()).map((setting) => [setting.key, setting.value]));
  const timezone = values.timezone || config.defaultTimezone;
  const dailyTime = validTime(values.dailyTime) ? values.dailyTime : config.defaultDailyTime;
  const now = DateTime.now().setZone(timezone); const localDate = now.toISODate();
  if (now.toFormat('HH:mm') < dailyTime || values.lastDailyLocalDate === localDate) return;
  const result = await enqueueRun({ type: 'daily', localRunDate: localDate });
  if (result.created) await Setting.findOneAndUpdate({ key: 'lastDailyLocalDate' }, { value: localDate }, { upsert: true });
}
export function startScheduler() { schedulerTick().catch((error) => console.error('Scheduler tick failed:', error)); const timer = setInterval(() => schedulerTick().catch((error) => console.error('Scheduler tick failed:', error)), 30000); timer.unref(); return timer; }
