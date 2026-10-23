// src/cli/jsonc.ts — Minimal JSONC helpers: parse (comments + trailing commas) and
// edit a top-level string value in place, so comments in opencode.jsonc survive.

/** Replaces comments and trailing commas with nothing/whitespace, leaving strings untouched. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: drop a comma whose next non-space character closes an object/array.
  let res = "";
  for (let k = 0; k < out.length; k++) {
    const ch = out[k];
    if (ch === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
    } else if (ch === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
      res += ch;
    } else {
      res += ch;
    }
  }
  return res;
}

export function parseJsonc<T = any>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}

/**
 * Sets a top-level string property (e.g. "model") keeping every comment and format byte.
 * Returns undefined when the property is missing or not a string.
 */
export function setTopLevelString(text: string, key: string, value: string): string | undefined {
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const str = text.slice(i + 1, j);
      i = j + 1;
      if (depth === 1 && str === key) {
        let k = i;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] !== ":") continue;
        k++;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] !== '"') return undefined;
        let e = k + 1;
        while (e < n && text[e] !== '"') e += text[e] === "\\" ? 2 : 1;
        return text.slice(0, k) + JSON.stringify(value) + text.slice(e + 1);
      }
    } else {
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
      i++;
    }
  }
  return undefined;
}

export interface Upsert {
  text: string;
  /** The exact text inserted (empty when an existing value was replaced), so it can be removed later. */
  inserted: string;
}

/**
 * Like setTopLevelString, but inserts `"key": "value"` right after the opening brace when the key is
 * missing. Returns undefined when the document has no top-level object.
 */
export function upsertTopLevelString(text: string, key: string, value: string): Upsert | undefined {
  const replaced = setTopLevelString(text, key, value);
  if (replaced !== undefined) return { text: replaced, inserted: "" };

  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else if (text[i] === "{") {
      break;
    } else if (/\s/.test(text[i])) {
      i++;
    } else {
      return undefined;
    }
  }
  if (text[i] !== "{") return undefined;

  // Is the object empty? (next significant character is the closing brace)
  let j = i + 1;
  for (;;) {
    while (j < n && /\s/.test(text[j])) j++;
    if (text[j] === "/" && text[j + 1] === "/") while (j < n && text[j] !== "\n") j++;
    else if (text[j] === "/" && text[j + 1] === "*") {
      j += 2;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j += 2;
    } else break;
  }
  const empty = text[j] === "}";
  const inserted = `\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}${empty ? "" : ","}`;
  return { text: text.slice(0, i + 1) + inserted + text.slice(i + 1), inserted };
}
