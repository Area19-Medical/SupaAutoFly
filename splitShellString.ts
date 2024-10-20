/**
 * Processes a quoted string, handling escape sequences
 *
 * @param {string} str - The input string containing the quoted segment.
 * @param {number} start - The starting index of the quoted segment within the input string.
 * @param {string} quote - The quote character used to delimit the quoted segment (e.g., '"' or "'").
 * @returns {[string, number]} A tuple where the first element is the accumulated string and the second element is the position after the closing quote.
 */
export function processQuotedString(str: string, start: number, quote: string): [string, number] {
  let accum = '';
  let escaped = false;

  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escaped) {
      if (c === quote) {
        accum += c;
      } else {
        accum += '\\' + c;
      }
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === quote) {
      return [ accum, i+1 ];
    }
    accum += c;
  }
  if (escaped)
    console.warn(`trailing backslash in '${str.slice(start)}'`)
  console.warn(`unterminated ${quote}-quoted string '${str.slice(start)}'`);
  return [ accum, str.length ];
}


/**
 * Splits a shell command string into an array of arguments, handling quoted strings and escaped characters.
 *
 * @param {string} str - The shell command string to split.
 * @returns {string[]} An array of arguments parsed from the input string.
 */
export function splitShellString(str: string): string[] {
  let accum = '';
  const result = [];
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escaped) {
      accum += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      const [ value, next ] = processQuotedString(str, i + 1, '"');
      accum += value;
      i = next - 1;
      continue;splitQuotedArgs
    }
    if (c === "'") {
      const [ value, next ] = processQuotedString(str, i + 1, "'");
      accum += value;
      i = next - 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      result.push(accum);
      accum = '';
      continue;
    }
    accum += c;
  }
  if (escaped)
    console.warn(`trailing backslash in '${str}'`)
  if (accum)
    result.push(accum);
  return result;
}
