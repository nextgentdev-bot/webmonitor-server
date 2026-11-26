import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { readGoogleSheetCsv, readGoogleSheetWorkbook, readUploadedSpreadsheet } from './spreadsheet-import.js';

async function workbookBuffer(createWorkbook) {
	const workbook = new ExcelJS.Workbook();
	createWorkbook(workbook);
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('reads website rows from Google Sheet CSV', async () => {
	const rows = await readGoogleSheetCsv('Website Name,Website URL\nExample,https://example.com\n');
	assert.deepEqual(rows, [{ name: 'Example', url: 'https://example.com' }]);
});

test('reads the All Sites worksheet from Google Sheet workbooks', async () => {
	const buffer = await workbookBuffer((workbook) => {
		workbook.addWorksheet('Other').addRows([['Name', 'URL'], ['Wrong', 'https://wrong.example']]);
		workbook.addWorksheet('All Sites').addRows([['Website Name', 'Website URL'], ['Right', 'https://right.example']]);
	});
	assert.deepEqual(await readGoogleSheetWorkbook(buffer), {
		rows: [{ name: 'Right', url: 'https://right.example' }],
		tab: 'All Sites'
	});
});

test('reads named columns and fallback columns from uploaded workbooks', async () => {
	const buffer = await workbookBuffer((workbook) => {
		workbook.addWorksheet('Websites').addRows([
			['Website Name', 'Website URL'],
			['Example', 'https://example.com']
		]);
	});
	assert.deepEqual(await readUploadedSpreadsheet(buffer), [
		{ 'Website Name': 'Example', 'Website URL': 'https://example.com' }
	]);
});
