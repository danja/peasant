// The one list of escape codes.
//
// Scattered escape sequences are how a terminal UI becomes unfixable: the day
// you need to strip colour for a pipe, or support a terminal that lacks
// truecolor, you have to find every one of them.

export const CSI = '\x1b[';

export const CODES = Object.freeze({
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,

  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  grey: `${CSI}90m`,
});

export const CURSOR = Object.freeze({
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  lineStart: '\r',
  clearLine: `${CSI}2K`,
  up: (n = 1) => `${CSI}${n}A`,
});

// Matches any escape sequence, for measuring and for stripping when output is
// not a terminal.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function strip(s) {
  return String(s).replace(ANSI_RE, '');
}

// Visible width, ignoring escapes. Not grapheme-perfect -- wide CJK characters
// are counted as one -- but correct for the ASCII the UI actually lays out.
export function width(s) {
  return strip(s).length;
}
