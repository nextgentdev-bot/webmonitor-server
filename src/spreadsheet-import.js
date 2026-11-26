import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { defaultGoogleSheetTab, parseGoogleSheetRows } from './utils.js';

function cellValue(cell) {
	const value = cell.value;
	if (value == null) return '';
	if (typeof value !== 'object') return value;
	if (Array.isArray(value.richText)) return value.richText.map((item) => item.text).join('');
	if ('result' in value) return value.result ?? '';
	if (typeof value.text === 'string') return value.text;
	return value;
}

function worksheetGrid(worksheet) {
	const grid = [];
	worksheet.eachRow({ includeEmpty: false }, (row) => {
		grid.push(Array.from({ length: row.cellCount }, (_, index) => cellValue(row.getCell(index + 1))));
	});
	return grid;
}

function headerKeys(values) {
	const counts = new Map();
	return values.map((value) => {
		const key = String(value || '').trim() || '__EMPTY';
		const count = counts.get(key) || 0;
		counts.set(key, count + 1);
		return count ? `${key}_${count}` : key;
	});
}

export async function readGoogleSheetCsv(csv) {
	const workbook = new ExcelJS.Workbook();
	const worksheet = await workbook.csv.read(Readable.from([Buffer.from(csv)]));
	return parseGoogleSheetRows(worksheetGrid(worksheet));
}

export async function readGoogleSheetWorkbook(buffer) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer);
	const sheetName = defaultGoogleSheetTab(workbook.worksheets.map((worksheet) => worksheet.name));
	const worksheet = sheetName ? workbook.getWorksheet(sheetName) : null;
	if (!worksheet) throw new Error('Google Sheet does not contain any tabs.');
	return { rows: parseGoogleSheetRows(worksheetGrid(worksheet)), tab: sheetName };
}

export async function readUploadedSpreadsheet(buffer) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer);
	const worksheet = workbook.worksheets[0];
	if (!worksheet) return [];

	const headerRow = worksheet.getRow(1);
	const columnCount = Math.max(worksheet.columnCount, headerRow.cellCount);
	const keys = headerKeys(Array.from({ length: columnCount }, (_, index) => cellValue(headerRow.getCell(index + 1))));
	const rows = [];
	worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
		if (rowNumber === 1) return;
		rows.push(Object.fromEntries(keys.map((key, index) => [key, cellValue(row.getCell(index + 1))])));
	});
	return rows;
}
