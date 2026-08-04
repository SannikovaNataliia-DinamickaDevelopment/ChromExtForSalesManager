export const BACKEND_URL = 'http://localhost:3000';
export const SUPPORTED_HOSTS = ['www.techjobs.ca', 'www.itjobs.ca', 'wellfound.com', 'www.devitjobs.nl', 'devitjobs.nl'];

export function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return SUPPORTED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
