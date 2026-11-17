// The form of a Ukrainian word for a number: 1 файл, 2 файли, 5 файлів
// (and 21 файл, 22 файли, 11 файлів). The tables of the page's Ukrainian
// words (i18n-uk.ts and its parts) say their counts with it.
//
// Entry point: `plural`.

export function plural(count: string | number | undefined, one: string, few: string, many: string): string {
  const n = Math.abs(Number(count ?? 0));
  const tens = n % 100;
  const units = n % 10;

  if (!Number.isInteger(n) || (tens >= 11 && tens <= 14)) return many;

  return units === 1 ? one : units >= 2 && units <= 4 ? few : many;
}
