import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data/subscribers.json");

export interface Subscriber {
  telegramId: string;
  username: string;
  firstName: string;
  isVip: boolean;
  vipExpiresAt: string | null;
  language: string;
  favorites: number[];
  watchHistory: number[];
  ratings: Record<string, number>;
  joinedAt: string;
}

type DB = Record<string, Subscriber>;

function load(): DB {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    if (fs.existsSync(FILE)) {
      return JSON.parse(fs.readFileSync(FILE, "utf8")) as DB;
    }
  } catch {}
  return {};
}

function save(db: DB) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
  } catch {}
}

let DB: DB = load();

export function register(user: { id: number; username?: string; first_name?: string }): Subscriber {
  const id = String(user.id);
  if (!DB[id]) {
    DB[id] = {
      telegramId: id,
      username: user.username ?? "",
      firstName: user.first_name ?? "",
      isVip: false,
      vipExpiresAt: null,
      language: "PT-BR",
      favorites: [],
      watchHistory: [],
      ratings: {},
      joinedAt: new Date().toISOString(),
    };
    save(DB);
  }
  return DB[id]!;
}

export function isVip(telegramId: string): boolean {
  const s = DB[telegramId];
  if (!s?.isVip) return false;
  if (s.vipExpiresAt && new Date(s.vipExpiresAt) < new Date()) {
    s.isVip = false;
    s.vipExpiresAt = null;
    save(DB);
    return false;
  }
  return true;
}

export function setVip(telegramId: string, active: boolean) {
  if (!DB[telegramId]) {
    DB[telegramId] = {
      telegramId, username: "", firstName: "", isVip: false,
      vipExpiresAt: null, language: "PT-BR", favorites: [],
      watchHistory: [], ratings: {}, joinedAt: new Date().toISOString(),
    };
  }
  DB[telegramId]!.isVip = active;
  DB[telegramId]!.vipExpiresAt = active
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;
  save(DB);
}

export function setLanguage(telegramId: string, lang: string) {
  if (DB[telegramId]) { DB[telegramId]!.language = lang; save(DB); }
}

export function getLanguage(telegramId: string): string {
  return DB[telegramId]?.language ?? "PT-BR";
}

export function toggleFavorite(telegramId: string, dramaId: number): boolean {
  const s = DB[telegramId];
  if (!s) return false;
  const idx = s.favorites.indexOf(dramaId);
  if (idx >= 0) s.favorites.splice(idx, 1); else s.favorites.push(dramaId);
  save(DB);
  return idx < 0;
}

export function getFavorites(telegramId: string): number[] {
  return DB[telegramId]?.favorites ?? [];
}

export function addToHistory(telegramId: string, episodeId: number) {
  const s = DB[telegramId];
  if (!s) return;
  if (!s.watchHistory.includes(episodeId)) { s.watchHistory.push(episodeId); save(DB); }
}

export function getWatchHistory(telegramId: string): number[] {
  return DB[telegramId]?.watchHistory ?? [];
}

export function rateEpisode(telegramId: string, episodeKey: string, rating: number) {
  const s = DB[telegramId];
  if (!s) return;
  s.ratings[episodeKey] = Math.min(5, Math.max(1, rating));
  save(DB);
}

export function getRating(telegramId: string, episodeKey: string): number | undefined {
  return DB[telegramId]?.ratings[episodeKey];
}

export function allSubscribers(): DB { return DB; }

export function stats() {
  const subs = Object.values(DB);
  return {
    total: subs.length,
    vip: subs.filter((s) => s.isVip).length,
    totalWatched: subs.reduce((a, s) => a + s.watchHistory.length, 0),
    totalFavorites: subs.reduce((a, s) => a + s.favorites.length, 0),
  };
}
