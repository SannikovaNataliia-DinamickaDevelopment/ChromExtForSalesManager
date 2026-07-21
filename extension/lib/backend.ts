export const BACKEND_URL = 'http://localhost:3000';
export const SUPPORTED_HOST = 'www.techjobs.ca';

export function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === SUPPORTED_HOST;
  } catch {
    return false;
  }
}
