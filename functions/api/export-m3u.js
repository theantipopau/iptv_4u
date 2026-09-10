import { exportM3u } from '../../shared/epg-service.js';

export async function onRequestPost({ request }) {
  try {
    const body = await request.json();
    const result = await exportM3u(body);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: error.status || 500 });
  }
}
