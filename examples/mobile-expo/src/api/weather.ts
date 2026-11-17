import { useCallback, useEffect, useState } from 'react';

import type { Units } from '@/auth/session';

import { ApiError, type FailReason, type Weather, type WeatherAnswer } from './types';


// Development builds answer from the mock layer while a fixture is active.
const mock: typeof import('./mock') | null = __DEV__ ? require('./mock') : null;

async function getJson(url: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ApiError('offline');
  }
  if (response.status === 401) throw new ApiError('unauthorized');
  if (!response.ok) throw new ApiError('unavailable');
  return response.json();
}

/** Open-Meteo: free and keyless. Geocode the city, then read today's forecast. */
export async function fetchWeather(query: string, units: Units): Promise<WeatherAnswer> {
  const mocked = mock?.mockWeather(query, units);
  if (mocked) return mocked;
  const places = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,
  );
  const place = places.results?.[0];
  if (!place) return { kind: 'not-found', query };
  const forecast = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min` +
      `&timezone=auto&forecast_days=1&temperature_unit=${units}`,
  );
  return {
    kind: 'loaded',
    weather: {
      city: place.name,
      temperature: Math.round(forecast.current.temperature_2m),
      high: Math.round(forecast.daily.temperature_2m_max[0]),
      low: Math.round(forecast.daily.temperature_2m_min[0]),
      code: forecast.current.weather_code,
    },
  };
}

/** Unread weather alerts. The local fake backend keeps the count on the account. */
export async function fetchAlerts(accountAlerts: number): Promise<number> {
  const mocked = mock?.mockAlerts();
  return mocked ?? accountAlerts;
}

export type WeatherState =
  | { status: 'loading' }
  | { status: 'loaded'; weather: Weather }
  | { status: 'not-found'; query: string }
  | { status: 'failed'; reason: FailReason };

export function useWeather(query: string | null, units: Units) {
  const [state, setState] = useState<WeatherState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query) return;
    let live = true;
    setState({ status: 'loading' });
    fetchWeather(query, units).then(
      (answer) => {
        if (!live) return;
        setState(answer.kind === 'loaded' ? { status: 'loaded', weather: answer.weather } : { status: 'not-found', query });
      },
      (error) => {
        if (live) setState({ status: 'failed', reason: error instanceof ApiError ? error.reason : 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [query, units, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

/** The WMO weather code, as the key naming its condition. */
export function conditionKey(code: number) {
  if (code === 0) return 'weather_condition_clear' as const;
  if (code <= 2) return 'weather_condition_partly_cloudy' as const;
  if (code === 3) return 'weather_condition_cloudy' as const;
  if (code === 45 || code === 48) return 'weather_condition_fog' as const;
  if (code >= 51 && code <= 57) return 'weather_condition_drizzle' as const;
  if (code >= 61 && code <= 67) return 'weather_condition_rain' as const;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'weather_condition_snow' as const;
  if (code >= 80 && code <= 82) return 'weather_condition_showers' as const;
  return 'weather_condition_storm' as const;
}
