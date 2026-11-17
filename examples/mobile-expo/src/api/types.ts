export type Weather = { city: string; temperature: number; high: number; low: number; code: number };
export type WeatherAnswer = { kind: 'loaded'; weather: Weather } | { kind: 'not-found'; query: string };
export type FailReason = 'offline' | 'unavailable' | 'unauthorized';

export class ApiError extends Error {
  constructor(readonly reason: FailReason) {
    super(reason);
  }
}
