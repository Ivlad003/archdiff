// Counts in words — "1 module", "2 modules" — as every reason, title and
// report says a count. Node-free and with no imports: any layer may use it.
//
// Entry point: `counted`.

/** `n` and the word, singular for one: `counted(1, "module")` is "1 module", `counted(3, "class", "classes")` "3 classes". */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
