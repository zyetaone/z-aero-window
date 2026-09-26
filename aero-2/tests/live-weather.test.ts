import { describe, it, expect } from 'vitest';
import { mapOpenMeteoToWeather, openMeteoUrl, parseOpenMeteo } from '#lib/server/weather.js';

describe('mapOpenMeteoToWeather', () => {
	it('maps thunderstorm codes to storm regardless of cover', () => {
		expect(mapOpenMeteoToWeather(95, 10)).toBe('storm');
		expect(mapOpenMeteoToWeather(99, 90)).toBe('storm');
	});

	it('maps precipitation codes to rain', () => {
		expect(mapOpenMeteoToWeather(51, 30)).toBe('rain');
		expect(mapOpenMeteoToWeather(65, 80)).toBe('rain');
		expect(mapOpenMeteoToWeather(80, 40)).toBe('rain');
	});

	it('maps fog and snow to overcast (no union member, reads the same)', () => {
		expect(mapOpenMeteoToWeather(45, 50)).toBe('overcast');
		expect(mapOpenMeteoToWeather(71, 50)).toBe('overcast');
		expect(mapOpenMeteoToWeather(85, 50)).toBe('overcast');
	});

	it('splits fair codes by cover at 25/60', () => {
		expect(mapOpenMeteoToWeather(0, 0)).toBe('clear');
		expect(mapOpenMeteoToWeather(2, 24)).toBe('clear');
		expect(mapOpenMeteoToWeather(2, 25)).toBe('cloudy');
		expect(mapOpenMeteoToWeather(3, 59)).toBe('cloudy');
		expect(mapOpenMeteoToWeather(3, 60)).toBe('overcast');
	});
});

describe('openMeteoUrl', () => {
	it('requests current code, cover and wind for the point', () => {
		const url = openMeteoUrl(19.076, 72.8777);
		expect(url).toContain('api.open-meteo.com/v1/forecast');
		expect(url).toContain('latitude=19.076');
		expect(url).toContain('longitude=72.8777');
		expect(url).toContain('weather_code');
		expect(url).toContain('cloud_cover');
	});
});

describe('parseOpenMeteo', () => {
	it('parses a real-shaped payload', () => {
		expect(
			parseOpenMeteo({ current: { weather_code: 3, cloud_cover: 70, wind_speed_10m: 12 } })
		).toEqual({ weather: 'overcast', cloudCover: 70, code: 3 });
	});

	it('returns null on anything unexpected, never throws', () => {
		expect(parseOpenMeteo(null)).toBeNull();
		expect(parseOpenMeteo({})).toBeNull();
		expect(parseOpenMeteo({ current: null })).toBeNull();
		expect(parseOpenMeteo({ current: { weather_code: 'x' } })).toBeNull();
		expect(parseOpenMeteo({ current: { weather_code: 1, cloud_cover: NaN } })).toBeNull();
	});
});
