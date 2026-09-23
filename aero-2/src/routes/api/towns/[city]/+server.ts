import { serveCityGeojson } from '#lib/server/geojson.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request }) =>
	serveCityGeojson(params.city, 'towns', request.headers.get('if-none-match'));
