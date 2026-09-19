/** Server-owned destination for new tokens; never sourced from browser input. */
export const TOKEN_WEBSITE = 'https://pog.fun';
export const TOKEN_METADATA_POLICY = 'pog-website-x-v1';

export function normalizeTokenXLink(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid X link.');
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(text))
    throw new Error('Invalid X link.');
  const url = new URL(text);
  if (
    url.protocol !== 'https:' ||
    !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.split('/').some(Boolean)
  )
    throw new Error('Invalid X link.');
  url.hostname = 'x.com';
  return url.href;
}
