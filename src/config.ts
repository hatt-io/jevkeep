import { open, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { object, Skip } from './model.js';

export async function credential(): Promise<string> {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  try {
    const path = join(homedir(), '.config', 'jevkeep', 'config.json');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16_384 ||
          (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
        throw new Skip('credential file must be private');
      }
      const config: unknown = JSON.parse(await file.readFile('utf8'));
      if (!object(config) || typeof config.TYPESAFE_API_KEY !== 'string' || !config.TYPESAFE_API_KEY.trim()) {
        throw new Skip('invalid credential configuration');
      }
      return config.TYPESAFE_API_KEY.trim();
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Skip) throw error;
    throw new Skip('TYPESAFE_API_KEY unavailable');
  }
}
